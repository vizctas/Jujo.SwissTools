/**
 * Sesiones de logcat.
 *
 * Una por dispositivo, no una global: el script original escuchaba un solo aparato,
 * y ver el mismo stream en el móvil y en el TV a la vez es justo lo que hace falta
 * cuando estás comparando por qué uno reproduce y el otro no.
 *
 * El proceso de logcat es tonto a propósito: lee, filtra, extrae y emite. Todo lo
 * que decide qué hacer con una URL vive fuera.
 */

import { spawn } from 'node:child_process';
import { extractUrls } from './media.mjs';

/** Tope del buffer de líneas por sesión. Sin esto, una noche escuchando se come la RAM. */
const TAIL_LIMIT = 400;

class Session {
  #adb;
  #serial;
  #profile;
  #emit;
  #child = null;
  #stopped = false;
  #buffer = '';
  #restarts = 0;

  /** Últimas líneas que pasaron el filtro, para que la interfaz muestre el tail. */
  tail = [];
  /** URLs ya vistas en esta sesión: una URL se anuncia una vez. */
  seen = new Set();
  lines = 0;
  startedAt = Date.now();

  constructor(adb, serial, profile, emit) {
    this.#adb = adb;
    this.#serial = serial;
    this.#profile = profile;
    this.#emit = emit;
  }

  get serial() {
    return this.#serial;
  }

  get profile() {
    return this.#profile;
  }

  /** Cambiar de perfil en caliente: no hace falta reiniciar el logcat. */
  setProfile(profile) {
    this.#profile = profile;
    this.#emit({ t: 'sniffer.profile', serial: this.#serial, profile });
  }

  async start() {
    // Vaciar el buffer del dispositivo: si no, la primera línea es de hace dos días.
    await this.#adb.exec(['-s', this.#serial, 'logcat', '-c'], { timeout: 8000 });
    this.#spawn();
  }

  #spawn() {
    if (this.#stopped) return;
    this.#child = spawn(this.#adb.bin, ['-s', this.#serial, 'logcat', '-v', 'time'], {
      windowsHide: true,
    });

    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk) => this.#ingest(chunk));
    this.#child.on('error', (error) => {
      this.#emit({ t: 'sniffer.error', serial: this.#serial, message: String(error.message) });
    });
    this.#child.on('close', () => {
      if (this.#stopped) return;
      // El dispositivo se cayó o se reinició adb. Volver a intentarlo con espera
      // creciente en vez de morir: es exactamente el caso de un TV que se duerme.
      this.#restarts += 1;
      const delay = Math.min(15_000, 1500 * this.#restarts);
      this.#emit({
        t: 'sniffer.reconnecting',
        serial: this.#serial,
        attempt: this.#restarts,
        delay,
      });
      setTimeout(() => {
        if (this.#stopped) return;
        void this.#adb.connect(this.#serial).finally(() => this.#spawn());
      }, delay);
    });
  }

  /** logcat llega en trozos arbitrarios; hay que recomponer líneas. */
  #ingest(chunk) {
    this.#buffer += chunk;
    const parts = this.#buffer.split(/\r?\n/);
    this.#buffer = parts.pop() ?? '';

    const hits = [];
    const fresh = [];
    for (const line of parts) {
      if (line === '') continue;
      this.lines += 1;
      const filter = this.#profile.logFilter ?? '';
      if (filter && !line.toLowerCase().includes(filter.toLowerCase())) continue;

      fresh.push(line);
      for (const url of extractUrls(line, { pattern: this.#profile.pattern })) {
        if (this.seen.has(url)) continue;
        this.seen.add(url);
        hits.push(url);
      }
    }

    if (fresh.length > 0) {
      this.tail.push(...fresh);
      if (this.tail.length > TAIL_LIMIT) this.tail.splice(0, this.tail.length - TAIL_LIMIT);
      // Se manda un lote, no una línea suelta: un logcat sin filtro son miles por
      // segundo y un evento por línea ahoga al navegador.
      this.#emit({ t: 'sniffer.lines', serial: this.#serial, lines: fresh.slice(-40), total: this.lines });
    }
    for (const url of hits) {
      this.#emit({ t: 'sniffer.url', serial: this.#serial, url, at: Date.now() });
    }
  }

  stop() {
    this.#stopped = true;
    try {
      this.#child?.kill();
    } catch {
      // Ya estaba muerto.
    }
  }

  status() {
    return {
      serial: this.#serial,
      profile: this.#profile,
      lines: this.lines,
      urls: this.seen.size,
      startedAt: this.startedAt,
      restarts: this.#restarts,
    };
  }
}

export class SnifferHub {
  #adb;
  #emit;
  #sessions = new Map();

  constructor(adb, emit) {
    this.#adb = adb;
    this.#emit = emit;
  }

  async start(serial, profile) {
    this.stop(serial);
    const session = new Session(this.#adb, serial, profile, this.#emit);
    this.#sessions.set(serial, session);
    await session.start();
    this.#emit({ t: 'sniffer.started', serial, profile });
    return session.status();
  }

  stop(serial) {
    const session = this.#sessions.get(serial);
    if (!session) return false;
    session.stop();
    this.#sessions.delete(serial);
    this.#emit({ t: 'sniffer.stopped', serial });
    return true;
  }

  stopAll() {
    for (const serial of [...this.#sessions.keys()]) this.stop(serial);
  }

  setProfile(serial, profile) {
    this.#sessions.get(serial)?.setProfile(profile);
  }

  tail(serial) {
    return this.#sessions.get(serial)?.tail ?? [];
  }

  statuses() {
    return [...this.#sessions.values()].map((session) => session.status());
  }
}
