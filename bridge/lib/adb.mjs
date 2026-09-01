/**
 * Todo lo que toca el binario de adb.
 *
 * El resto del puente no sabe que adb existe: pide dispositivos o instalaciones y
 * recibe objetos. Si algún día se sustituye por otro transporte, se sustituye este
 * archivo y nada más.
 */

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

const EXE = platform() === 'win32' ? 'adb.exe' : 'adb';

/** Sitios donde adb suele estar cuando no está en el PATH. */
function candidatePaths() {
  const home = homedir();
  const paths = [
    process.env.ADB_PATH,
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools', EXE),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, 'platform-tools', EXE),
  ];
  if (platform() === 'win32') {
    paths.push(join(home, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', EXE));
  } else if (platform() === 'darwin') {
    paths.push(join(home, 'Library', 'Android', 'sdk', 'platform-tools', EXE));
    paths.push('/opt/homebrew/bin/adb', '/usr/local/bin/adb');
  } else {
    paths.push(join(home, 'Android', 'Sdk', 'platform-tools', EXE));
    paths.push('/usr/bin/adb', '/usr/local/bin/adb');
  }
  return paths.filter(Boolean);
}

/** Ejecuta y devuelve la salida, sin lanzar por código de salida distinto de cero. */
function run(bin, args, { timeout = 15_000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: -1, stdout, stderr: stderr + '\nTiempo de espera agotado.' });
    }, timeout);

    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export class AdbNotFoundError extends Error {
  constructor() {
    super(
      'No se encontró adb. Instala las platform-tools de Android y deja adb en el PATH, ' +
        'o arranca el puente con --adb "C:\\ruta\\a\\adb.exe".',
    );
    this.name = 'AdbNotFoundError';
    this.code = 'ADB_NOT_FOUND';
  }
}

export class Adb {
  #bin;
  #version = null;

  constructor(bin) {
    this.#bin = bin;
  }

  get bin() {
    return this.#bin;
  }

  get version() {
    return this.#version;
  }

  /** Busca adb en el PATH y en las rutas habituales del SDK. */
  static async locate(explicit) {
    const tried = [];
    for (const candidate of [explicit, EXE, ...candidatePaths()].filter(Boolean)) {
      tried.push(candidate);
      if (candidate !== EXE) {
        try {
          await access(candidate, constants.X_OK);
        } catch {
          continue;
        }
      }
      const result = await run(candidate, ['version'], { timeout: 8000 });
      if (result.code === 0) {
        const adb = new Adb(candidate);
        adb.#version =
          /Android Debug Bridge version ([\d.]+)/.exec(result.stdout)?.[1] ?? 'desconocida';
        return adb;
      }
    }
    const error = new AdbNotFoundError();
    error.tried = tried;
    throw error;
  }

  exec(args, options) {
    return run(this.#bin, args, options);
  }

  /**
   * Lista dispositivos. `adb devices -l` da estado y modelo; el resto de detalles
   * cuesta un `getprop` por dispositivo, así que solo se piden para los que están
   * en estado `device` y se cachean fuera de aquí.
   */
  async devices() {
    const { code, stdout, stderr } = await this.exec(['devices', '-l'], { timeout: 10_000 });
    if (code !== 0) {
      throw new Error(stderr.trim() || 'adb devices falló.');
    }
    const devices = [];
    for (const line of stdout.split(/\r?\n/).slice(1)) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('*')) continue;
      const [serial, state, ...rest] = trimmed.split(/\s+/);
      if (!serial || !state) continue;
      const tags = Object.fromEntries(
        rest
          .map((token) => token.split(':'))
          .filter((pair) => pair.length === 2)
          .map(([key, value]) => [key, value]),
      );
      devices.push({
        serial,
        state,
        model: tags.model?.replace(/_/g, ' ') ?? null,
        product: tags.product ?? null,
        // Por red hay dos formas: `ip:puerto` de `adb connect`, y el serial mDNS que
        // deja el emparejamiento inalámbrico. Mirar solo el puerto se come el segundo.
        transport: /:\d+$/.test(serial) || /_adb-tls|_tcp$|^adb-/.test(serial) ? 'tcp' : 'usb',
      });
    }
    return devices;
  }

  /** Propiedades que hacen falta para avisar antes de instalar, en una sola llamada. */
  async describe(serial) {
    const { code, stdout } = await this.exec(
      [
        '-s',
        serial,
        'shell',
        'getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.cpu.abilist; getprop ro.product.model',
      ],
      { timeout: 10_000 },
    );
    if (code !== 0) return null;
    const [release, sdk, abilist, model] = stdout.split(/\r?\n/).map((line) => line.trim());
    return {
      release: release || null,
      sdk: Number(sdk) || null,
      abis: (abilist || '').split(',').filter(Boolean),
      model: model || null,
    };
  }

  /** Espacio libre en /data, en bytes. Sirve para avisar antes de intentar nada. */
  async freeSpace(serial) {
    const { code, stdout } = await this.exec(['-s', serial, 'shell', 'df -k /data'], {
      timeout: 10_000,
    });
    if (code !== 0) return null;
    const line = stdout.split(/\r?\n/).find((row) => /\d+\s+\d+\s+\d+/.test(row));
    const columns = line?.trim().split(/\s+/) ?? [];
    const availableKb = Number(columns[3]);
    return Number.isFinite(availableKb) ? availableKb * 1024 : null;
  }

  /** Versión instalada de un paquete, o null si no está. */
  async installedVersion(serial, packageName) {
    const { code, stdout } = await this.exec(
      ['-s', serial, 'shell', `dumpsys package ${packageName} | grep -E "versionCode|versionName"`],
      { timeout: 12_000 },
    );
    if (code !== 0 || stdout.trim() === '') return null;
    return {
      versionCode: Number(/versionCode=(\d+)/.exec(stdout)?.[1]) || null,
      versionName: /versionName=(\S+)/.exec(stdout)?.[1] ?? null,
    };
  }

  async connect(address) {
    const { stdout, stderr } = await this.exec(['connect', address], { timeout: 20_000 });
    const output = `${stdout}${stderr}`.trim();
    // adb connect devuelve 0 incluso cuando falla, así que se lee el texto.
    const ok = /connected to/i.test(output) && !/cannot|failed|refused/i.test(output);
    return { ok, message: output || 'Sin respuesta de adb.' };
  }

  /**
   * Emparejamiento inalámbrico. Es un paso aparte de `connect`: Android da un
   * puerto y un código de seis dígitos que caducan en un minuto, y el puerto del
   * emparejamiento no es el mismo por el que luego se conecta.
   */
  async pair(address, code) {
    const { stdout, stderr } = await this.exec(['pair', address, code], { timeout: 30_000 });
    const output = `${stdout}${stderr}`.trim();
    const ok = /Successfully paired/i.test(output);
    return { ok, message: output || 'adb no respondió al emparejamiento.' };
  }

  async disconnect(address) {
    const { stdout, stderr } = await this.exec(['disconnect', address], { timeout: 10_000 });
    return { ok: true, message: `${stdout}${stderr}`.trim() };
  }

  async uninstall(serial, packageName) {
    const { stdout, stderr } = await this.exec(['-s', serial, 'uninstall', packageName], {
      timeout: 60_000,
    });
    const output = `${stdout}${stderr}`.trim();
    return { ok: /^Success/m.test(output), message: output };
  }

  /**
   * Instala un APK. Devuelve un manejador con `promise` y `cancel`.
   *
   * ponytail: el porcentaje solo aparece si adb decide emitir `[ NN% ]`, cosa que
   * depende de su versión y de si cree que habla con una terminal. Cuando no llega
   * ninguno, quien escucha muestra progreso indeterminado en vez de inventarse una
   * barra que avanza sola.
   */
  install(serial, apkPath, { flags = [], onProgress } = {}) {
    const args = ['-s', serial, 'install', ...flags, apkPath];
    const child = spawn(this.#bin, args, { windowsHide: true });
    let output = '';
    let cancelled = false;

    const readChunk = (chunk) => {
      const text = String(chunk);
      output += text;
      const percent = [...text.matchAll(/\[\s*(\d{1,3})%\]/g)].pop();
      if (percent && onProgress) onProgress(Number(percent[1]));
    };
    child.stdout?.on('data', readChunk);
    child.stderr?.on('data', readChunk);

    const promise = new Promise((resolve) => {
      child.on('error', (error) => {
        resolve({ ok: false, output: `${output}\n${error.message}`, cancelled });
      });
      child.on('close', (code) => {
        const ok = code === 0 && /^Success/m.test(output);
        resolve({ ok, output: output.trim(), cancelled });
      });
    });

    return {
      promise,
      cancel() {
        cancelled = true;
        child.kill();
      },
    };
  }
}
