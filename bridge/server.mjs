#!/usr/bin/env node
/*
 * Puente ADB de Jujo.SwissTools.
 *
 * Un proceso local, sin dependencias, que expone el adb que ya tienes a la app web.
 * Escucha solo en 127.0.0.1 y rechaza cualquier origen que no sea tu propia máquina.
 *
 * Sobre el token: sigue existiendo, pero ya no hay que teclearlo. `/__bridge.json`
 * lo entrega a los orígenes de la lista blanca, que es exactamente el conjunto de
 * páginas que ya podían hablar con el puente. Copiarlo a mano no añadía seguridad
 * frente a `https://sitio-hostil` —eso lo para el chequeo de origen— y sí añadía
 * fricción. Con `--strict-token` se desactiva la entrega y se vuelve al pegado
 * manual, para quien comparta la máquina.
 *
 * Server-Sent Events para lo que empuja el servidor y POST para los comandos: dos
 * primitivas que trae Node de fábrica.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { extname, join, normalize, resolve as resolvePath } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Adb, AdbNotFoundError } from './lib/adb.mjs';
import { Store } from './lib/db.mjs';
import { classifyFailure, PROTOCOL_VERSION } from './lib/protocol.mjs';
import { UploadStore } from './lib/uploads.mjs';
import { SnifferHub } from './lib/sniffer.mjs';
import { download, DownloadError, ffprobeInfo, mediaTools, probe, verify } from './lib/media.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const { values: options } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    adb: { type: 'string' },
    origin: { type: 'string', multiple: true },
    token: { type: 'string' },
    'strict-token': { type: 'boolean', default: false },
    'download-dir': { type: 'string' },
    serve: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: false,
});

if (options.help) {
  console.log(`Puente ADB de Jujo.SwissTools

  --port <n>           Puerto local (8787)
  --adb <ruta>         Ruta a adb si no está en el PATH
  --origin <url>       Origen extra permitido (repetible)
  --token <valor>      Token fijo en vez de uno generado
  --strict-token       No entregar el token; hay que pegarlo a mano
  --download-dir <d>   Dónde guardar las capturas
  --serve <dir>        Servir la app compilada desde ahí (por defecto ../dist)
`);
  process.exit(0);
}

const PORT = Number(options.port) || 8787;
const TOKEN = options.token || randomBytes(16).toString('hex');
const EXTRA_ORIGINS = new Set(options.origin ?? []);
const DOWNLOAD_DIR =
  options['download-dir'] || join(homedir(), 'Jujo.SwissTools', 'capturas');
const SERVE_DIR = resolvePath(options.serve || join(HERE, '..', 'dist'));

function originAllowed(origin) {
  if (!origin) return false;
  if (EXTRA_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

const store = new Store();
const uploads = new UploadStore();
let adb = null;
let adbError = null;

/* ------------------------------------------------------------ Difusión SSE */

const clients = new Set();

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

const sniffers = new SnifferHub({ get bin() { return adb?.bin; }, exec: (...a) => adb.exec(...a), connect: (a) => adb.connect(a) }, broadcast);

/* --------------------------------------------------------- Vigía de equipos */

const described = new Map();
let lastDevicesJson = '';
let pollTimer = null;
let reconnectTimer = null;

async function pollDevices({ force = false } = {}) {
  if (!adb) return;
  let list;
  try {
    list = await adb.devices();
  } catch (error) {
    broadcast({ t: 'devices.error', message: String(error.message ?? error) });
    return;
  }

  const seen = new Set(list.map((device) => device.serial));
  for (const serial of described.keys()) if (!seen.has(serial)) described.delete(serial);

  const live = await Promise.all(
    list.map(async (device) => {
      if (device.state !== 'device') return { ...device, details: null, freeSpace: null, known: true };
      if (!described.has(device.serial)) {
        const [details, freeSpace] = await Promise.all([
          adb.describe(device.serial),
          adb.freeSpace(device.serial),
        ]);
        described.set(device.serial, { details, freeSpace });
      }
      const cached = described.get(device.serial);
      const full = { ...device, details: cached.details, freeSpace: cached.freeSpace };
      store.seen(full);
      return { ...full, known: true };
    }),
  );

  // Los recordados que ahora mismo no están: se muestran igual, apagados, para
  // poder despertarlos de un clic en vez de recordar la IP de memoria.
  const offline = store
    .knownDevices()
    .filter((known) => !seen.has(known.serial))
    .map((known) => ({
      serial: known.serial,
      state: 'remembered',
      model: known.model,
      product: null,
      transport: known.transport,
      label: known.label,
      address: known.address,
      autoConnect: known.autoConnect,
      lastSeen: known.lastSeen,
      details: known.sdk
        ? { release: known.release, sdk: known.sdk, abis: known.abis, model: known.model }
        : null,
      freeSpace: null,
      known: true,
    }));

  const merged = [...live, ...offline];
  const json = JSON.stringify(merged);
  if (json !== lastDevicesJson || force) {
    lastDevicesJson = json;
    broadcast({ t: 'devices', devices: merged });
  }
}

/** Intenta despertar los dispositivos de red recordados. */
async function reconnectKnown() {
  if (!adb) return;
  const connected = new Set((await adb.devices().catch(() => [])).map((device) => device.serial));
  for (const address of store.reconnectTargets()) {
    if (connected.has(address)) continue;
    const result = await adb.connect(address);
    if (result.ok) {
      broadcast({ t: 'devices.reconnected', address });
      await pollDevices({ force: true });
    }
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => void pollDevices(), 2000);
  // Reintento de los recordados más espaciado: `adb connect` a una IP muerta
  // tarda lo suyo y no hay prisa.
  reconnectTimer = setInterval(() => void reconnectKnown(), 20_000);
  void pollDevices({ force: true });
  void reconnectKnown();
}

/* ------------------------------------------------------------- Instalación */

const jobs = new Map();

async function startInstall({ jobId, uploadId, serials, flags = [], uninstallPackage = null }) {
  const upload = uploads.get(uploadId);
  if (!upload) {
    broadcast({ t: 'install.rejected', jobId, message: 'El APK ya no está en el puente. Vuelve a cargarlo.' });
    return;
  }
  const handles = new Map();
  jobs.set(jobId, handles);

  await Promise.all(
    serials.map(async (serial) => {
      broadcast({ t: 'install.phase', jobId, serial, phase: 'preparing' });
      if (uninstallPackage) {
        broadcast({ t: 'install.phase', jobId, serial, phase: 'uninstalling' });
        const removed = await adb.uninstall(serial, uninstallPackage);
        if (!removed.ok) {
          broadcast({ t: 'install.result', jobId, serial, ok: false, code: 'UNINSTALL_FAILED',
            message: `No se pudo desinstalar la app existente: ${removed.message}`, output: removed.message });
          return;
        }
      }
      broadcast({ t: 'install.phase', jobId, serial, phase: 'transferring' });
      const handle = adb.install(serial, upload.path, {
        flags,
        onProgress: (percent) => broadcast({ t: 'install.progress', jobId, serial, percent }),
      });
      handles.set(serial, handle);
      const result = await handle.promise;
      handles.delete(serial);

      if (result.cancelled) {
        broadcast({ t: 'install.result', jobId, serial, ok: false, code: 'CANCELLED', message: 'Cancelado.' });
        return;
      }
      if (result.ok) {
        broadcast({ t: 'install.result', jobId, serial, ok: true, output: result.output });
        described.delete(serial);
        return;
      }
      const failure = classifyFailure(result.output);
      broadcast({ t: 'install.result', jobId, serial, ok: false,
        code: failure?.code ?? 'UNKNOWN',
        message: failure?.message ?? 'adb rechazó la instalación sin un motivo reconocible.',
        flag: failure?.flag ?? null, flagLabel: failure?.flagLabel ?? null, output: result.output });
    }),
  );

  jobs.delete(jobId);
  broadcast({ t: 'install.done', jobId });
  void pollDevices({ force: true });
}

/* --------------------------------------------------------------- Capturas */

const captures = new Map();

async function startCapture({ captureId, url, serial, name }) {
  const id = captureId ?? randomUUID();
  const controller = new AbortController();
  captures.set(id, controller);
  store.recordCapture({ id, url, serial, status: 'downloading', createdAt: Date.now() });
  broadcast({ t: 'capture.started', id, url, serial });

  try {
    const result = await download(url, DOWNLOAD_DIR, {
      name,
      signal: controller.signal,
      onProgress: (progress) => broadcast({ t: 'capture.progress', id, ...progress }),
    });
    const check = await verify(result.path);
    const info = await ffprobeInfo(result.path);
    const status = check.ok ? 'saved' : 'suspect';
    store.recordCapture({
      id, url, serial, kind: result.kind, status,
      path: result.path, size: result.size, duration: info?.duration ?? null,
      detail: check.ok ? (info?.resolution ?? null) : check.why,
    });
    broadcast({
      t: 'capture.done', id, ok: check.ok, path: result.path, size: result.size,
      kind: result.kind, duration: info?.duration ?? null, resolution: info?.resolution ?? null,
      detail: check.ok ? null : check.why,
    });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const message = cancelled
      ? 'Cancelada.'
      : error instanceof DownloadError
        ? error.message
        : String(error?.message ?? error);
    store.recordCapture({ id, url, serial, status: cancelled ? 'cancelled' : 'failed', detail: message });
    broadcast({ t: 'capture.failed', id, message, cancelled });
  } finally {
    captures.delete(id);
  }
}

function revealPath(target) {
  const commands = { win32: ['explorer', [target]], darwin: ['open', [target]] };
  const [bin, args] = commands[platform()] ?? ['xdg-open', [target]];
  try {
    spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- Comandos */

async function handleCommand(command) {
  switch (command.t) {
    case 'devices.refresh':
      described.clear();
      await pollDevices({ force: true });
      return { ok: true };

    case 'devices.connect': {
      const address = String(command.address ?? '').trim();
      if (!/^[\w.:-]+$/.test(address)) {
        return { ok: false, message: 'Escribe una dirección tipo 192.168.1.42:5555.' };
      }
      const result = await adb.connect(address.includes(':') ? address : `${address}:5555`);
      await pollDevices({ force: true });
      return result;
    }

    case 'devices.pair': {
      const address = String(command.address ?? '').trim();
      const code = String(command.code ?? '').trim();
      if (!/^[\w.:-]+:\d+$/.test(address)) {
        return { ok: false, message: 'El emparejamiento necesita host:puerto, y el puerto lo da el móvil.' };
      }
      if (!/^\d{6}$/.test(code)) {
        return { ok: false, message: 'El código de emparejamiento son seis dígitos.' };
      }
      const paired = await adb.pair(address, code);
      if (paired.ok) {
        // Tras emparejar hay que conectar por el puerto normal, que no es el del
        // emparejamiento. Se prueba el host con 5555, que es lo habitual.
        const host = address.split(':')[0];
        await adb.connect(`${host}:5555`);
        await pollDevices({ force: true });
      }
      return paired;
    }

    case 'devices.disconnect': {
      const result = await adb.disconnect(String(command.address ?? ''));
      described.delete(String(command.address ?? ''));
      await pollDevices({ force: true });
      return result;
    }

    case 'devices.forget':
      store.forget(String(command.serial ?? ''));
      await pollDevices({ force: true });
      return { ok: true };

    case 'devices.label':
      store.setLabel(String(command.serial ?? ''), String(command.label ?? ''));
      await pollDevices({ force: true });
      return { ok: true };

    case 'devices.autoConnect':
      store.setAutoConnect(String(command.serial ?? ''), Boolean(command.value));
      await pollDevices({ force: true });
      return { ok: true };

    case 'packages.status': {
      const packageName = String(command.packageName ?? '');
      if (!/^[\w.]+$/.test(packageName)) return { ok: false, message: 'Nombre de paquete inválido.' };
      const entries = await Promise.all(
        (command.serials ?? []).map(async (serial) => [
          serial,
          await adb.installedVersion(String(serial), packageName),
        ]),
      );
      return { ok: true, installed: Object.fromEntries(entries) };
    }

    case 'install.start':
      void startInstall(command);
      return { ok: true };

    case 'install.cancel': {
      const handles = jobs.get(command.jobId);
      if (!handles) return { ok: false, message: 'Ese trabajo ya terminó.' };
      for (const [serial, handle] of handles) {
        if (!command.serial || command.serial === serial) handle.cancel();
      }
      return { ok: true };
    }

    case 'upload.drop':
      await uploads.drop(command.uploadId);
      return { ok: true };

    /* ------------------------------------------------------------ Sniffer */

    case 'sniffer.profiles':
      return { ok: true, profiles: store.profiles() };

    case 'sniffer.saveProfile':
      store.saveProfile({
        id: command.id || randomUUID(),
        name: String(command.name ?? 'Perfil'),
        logFilter: String(command.logFilter ?? ''),
        pattern: command.pattern ? String(command.pattern) : null,
      });
      return { ok: true, profiles: store.profiles() };

    case 'sniffer.deleteProfile':
      store.deleteProfile(String(command.id ?? ''));
      return { ok: true, profiles: store.profiles() };

    case 'sniffer.start': {
      const profile = store.profiles().find((item) => item.id === command.profileId);
      if (!profile) return { ok: false, message: 'Ese perfil ya no existe.' };
      if (command.pattern) {
        try {
          new RegExp(command.pattern);
        } catch (error) {
          return { ok: false, message: `La expresión regular no compila: ${error.message}` };
        }
      }
      const status = await sniffers.start(String(command.serial), profile);
      return { ok: true, status };
    }

    case 'sniffer.stop':
      return { ok: sniffers.stop(String(command.serial)) };

    case 'sniffer.setProfile': {
      const profile = store.profiles().find((item) => item.id === command.profileId);
      if (!profile) return { ok: false, message: 'Ese perfil ya no existe.' };
      sniffers.setProfile(String(command.serial), profile);
      return { ok: true };
    }

    case 'sniffer.tail':
      return { ok: true, lines: sniffers.tail(String(command.serial)) };

    case 'sniffer.status':
      return { ok: true, sessions: sniffers.statuses() };

    /* ----------------------------------------------------------- Capturas */

    case 'media.probe': {
      const info = await probe(String(command.url ?? ''));
      return { ok: true, info };
    }

    case 'media.download':
      void startCapture(command);
      return { ok: true };

    case 'media.cancel':
      captures.get(String(command.id))?.abort();
      return { ok: true };

    case 'media.history':
      return { ok: true, captures: store.captures(command.limit ?? 60), dir: DOWNLOAD_DIR };

    case 'media.clearHistory':
      store.clearCaptures();
      return { ok: true };

    case 'media.reveal': {
      const target = command.path ? normalize(String(command.path)) : DOWNLOAD_DIR;
      // Solo se abre dentro de la carpeta de descargas: `reveal` con una ruta
      // arbitraria sería un «abre lo que quieras» de regalo.
      if (!resolvePath(target).startsWith(resolvePath(DOWNLOAD_DIR))) {
        return { ok: false, message: 'Fuera de la carpeta de capturas.' };
      }
      return { ok: revealPath(target) };
    }

    default:
      return { ok: false, message: `Comando desconocido: ${command.t}` };
  }
}

/* ------------------------------------------------------------------ Rutas */

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, x-jujo-token, x-jujo-filename',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/** Sirve la app compilada, si está. Un solo comando levanta todo. */
async function serveStatic(url, response) {
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const target = resolvePath(join(SERVE_DIR, normalize(relative)));
  if (!target.startsWith(SERVE_DIR)) return false;

  let info = await stat(target).catch(() => null);
  let path = target;
  if (!info?.isFile()) {
    path = join(SERVE_DIR, 'index.html');
    info = await stat(path).catch(() => null);
    if (!info?.isFile()) return false;
  }
  response.writeHead(200, {
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': path.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
  });
  createReadStream(path).pipe(response);
  return true;
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const sameOrigin = !origin;
  const allowed = originAllowed(origin);
  const cors = allowed ? corsHeaders(origin) : {};

  if (request.method === 'OPTIONS') {
    response.writeHead(allowed ? 204 : 403, cors);
    response.end();
    return;
  }

  if (url.pathname === '/health') {
    const tools = await mediaTools();
    send(response, 200, {
      name: 'jujo-adb-bridge',
      protocol: PROTOCOL_VERSION,
      adb: adb ? { path: adb.bin, version: adb.version } : null,
      adbError: adbError ? { code: adbError.code, message: adbError.message } : null,
      requiresToken: true,
      downloadDir: DOWNLOAD_DIR,
      tools,
    }, cors);
    return;
  }

  // Entrega del token. Solo a orígenes permitidos, que son los mismos que ya
  // podían usar el puente: no abre ninguna puerta que no estuviera abierta.
  if (url.pathname === '/__bridge.json') {
    if (options['strict-token']) {
      send(response, 403, { error: 'STRICT', message: 'El puente arrancó con --strict-token.' }, cors);
      return;
    }
    if (!allowed && !sameOrigin) {
      send(response, 403, { error: 'ORIGIN', message: 'Origen no permitido.' });
      return;
    }
    send(response, 200, { port: PORT, token: TOKEN, protocol: PROTOCOL_VERSION }, cors);
    return;
  }

  const isApi = ['/events', '/upload', '/command'].includes(url.pathname);

  if (!isApi) {
    if (await serveStatic(url, response)) return;
    send(response, 404, { error: 'NOT_FOUND', message: 'Ruta desconocida.' }, cors);
    return;
  }

  if (!allowed && !sameOrigin) {
    send(response, 403, { error: 'ORIGIN', message: `Origen no permitido: ${origin ?? 'ninguno'}` });
    return;
  }

  const token = request.headers['x-jujo-token'] ?? url.searchParams.get('token');
  if (token !== TOKEN) {
    send(response, 401, { error: 'TOKEN', message: 'Token inválido o ausente.' }, cors);
    return;
  }
  if (adbError) {
    send(response, 503, { error: adbError.code, message: adbError.message }, cors);
    return;
  }

  try {
    if (url.pathname === '/events' && request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        ...cors,
      });
      response.write(':\n\n');
      clients.add(response);
      startPolling();

      const tools = await mediaTools();
      response.write(`data: ${JSON.stringify({
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        adb: adb ? { path: adb.bin, version: adb.version } : null,
        downloadDir: DOWNLOAD_DIR,
        tools,
        profiles: store.profiles(),
        sessions: sniffers.statuses(),
      })}\n\n`);
      if (lastDevicesJson) response.write(`data: {"t":"devices","devices":${lastDevicesJson}}\n\n`);

      const keepAlive = setInterval(() => {
        try {
          response.write(': ping\n\n');
        } catch {
          clearInterval(keepAlive);
        }
      }, 20_000);
      request.on('close', () => {
        clearInterval(keepAlive);
        clients.delete(response);
      });
      return;
    }

    if (url.pathname === '/upload' && request.method === 'POST') {
      const entry = await uploads.receive(request, {
        filename: decodeURIComponent(String(request.headers['x-jujo-filename'] ?? 'app.apk')),
        declaredSize: Number(request.headers['content-length']) || 0,
      });
      send(response, 200, { uploadId: entry.id, size: entry.size, filename: entry.filename }, cors);
      return;
    }

    if (url.pathname === '/command' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const command = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      send(response, 200, await handleCommand(command), cors);
      return;
    }

    send(response, 404, { error: 'NOT_FOUND', message: 'Ruta desconocida.' }, cors);
  } catch (error) {
    send(response, error?.code === 'TOO_LARGE' ? 413 : 500,
      { error: error?.code ?? 'INTERNAL', message: String(error?.message ?? error) }, cors);
  }
});

/* ---------------------------------------------------------------- Arranque */

async function main() {
  await uploads.init();

  console.log('\n  Puente ADB de Jujo.SwissTools\n');
  try {
    adb = await Adb.locate(options.adb);
    console.log(`  adb        ${adb.bin} (versión ${adb.version})`);
  } catch (error) {
    if (!(error instanceof AdbNotFoundError)) throw error;
    adbError = error;
    console.log('  adb        NO ENCONTRADO');
    console.log(`             ${error.message}`);
  }

  const tools = await mediaTools();
  console.log(`  ffmpeg     ${tools.ffmpeg ? 'sí' : 'no (los streams por segmentos no se podrán unir)'}`);
  console.log(`  capturas   ${DOWNLOAD_DIR}`);
  const known = store.knownDevices().length;
  if (known > 0) console.log(`  memoria    ${known} dispositivo(s) recordado(s)`);

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `\n  El puerto ${PORT} ya está ocupado. Puede que el puente ya esté corriendo.\n` +
          `  Prueba: node bridge/server.mjs --port ${PORT + 1}\n`,
      );
      process.exit(1);
    }
    throw error;
  });

  server.listen(PORT, '127.0.0.1', async () => {
    const served = await stat(join(SERVE_DIR, 'index.html')).catch(() => null);
    console.log(`\n  Escuchando en http://127.0.0.1:${PORT} (solo local)`);
    if (served) console.log(`  App servida desde ${SERVE_DIR} — abre esa dirección y listo.`);
    if (options['strict-token']) {
      console.log(`\n  Token (--strict-token, hay que pegarlo):\n\n      ${TOKEN}\n`);
    } else {
      console.log('  El emparejamiento con la app es automático.');
    }
    console.log('  Ctrl+C para parar.\n');
  });
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n  Cerrando…');
  clearInterval(pollTimer);
  clearInterval(reconnectTimer);
  sniffers.stopAll();
  for (const controller of captures.values()) controller.abort();
  for (const handles of jobs.values()) for (const handle of handles.values()) handle.cancel();
  for (const client of clients) client.end();
  await uploads.dropAll();
  store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

main().catch((error) => {
  console.error('\n  El puente no pudo arrancar:', error?.message ?? error, '\n');
  process.exit(1);
});
