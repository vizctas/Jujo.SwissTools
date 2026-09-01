/**
 * Los APK que llegan desde el navegador.
 *
 * Van a un directorio temporal propio, no a la carpeta del usuario, y se borran al
 * salir. Un puente que deja cientos de megas tirados por ahí es un puente que
 * alguien acaba desinstalando.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

/** Tope por archivo. Un APK enorme suele ser un error, no un caso de uso. */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/** Los subidos se descartan pasado este tiempo aunque nadie los borre. */
const TTL_MS = 6 * 60 * 60 * 1000;

export class UploadStore {
  #dir;
  #entries = new Map();

  constructor(dir = join(tmpdir(), 'jujo-adb-bridge')) {
    this.#dir = dir;
  }

  get dir() {
    return this.#dir;
  }

  async init() {
    await mkdir(this.#dir, { recursive: true });
    await this.#sweep();
  }

  /** Borra restos de ejecuciones anteriores que murieron sin limpiar. */
  async #sweep() {
    let names;
    try {
      names = await readdir(this.#dir);
    } catch {
      return;
    }
    const now = Date.now();
    await Promise.all(
      names.map(async (name) => {
        const path = join(this.#dir, name);
        try {
          const info = await stat(path);
          if (now - info.mtimeMs > TTL_MS) await rm(path, { force: true });
        } catch {
          // Carrera con otra instancia del puente: da igual quién lo borre.
        }
      }),
    );
  }

  /**
   * Escribe el cuerpo de la petición a disco. Corta y limpia si se pasa del tope,
   * en vez de llenar el disco y descubrirlo después.
   */
  async receive(request, { filename, declaredSize }) {
    if (declaredSize && declaredSize > MAX_UPLOAD_BYTES) {
      const error = new Error(
        `El archivo pesa ${Math.round(declaredSize / 1048576)} MB y el tope son ${MAX_UPLOAD_BYTES / 1048576} MB.`,
      );
      error.code = 'TOO_LARGE';
      throw error;
    }

    const id = randomUUID();
    const path = join(this.#dir, `${id}.apk`);
    let written = 0;
    let aborted = null;

    const guard = async function* (source) {
      for await (const chunk of source) {
        written += chunk.length;
        if (written > MAX_UPLOAD_BYTES) {
          aborted = new Error('El archivo supera el tope del puente.');
          aborted.code = 'TOO_LARGE';
          throw aborted;
        }
        yield chunk;
      }
    };

    try {
      await pipeline(request, guard, createWriteStream(path));
    } catch (error) {
      await rm(path, { force: true });
      throw aborted ?? error;
    }

    if (written === 0) {
      await rm(path, { force: true });
      const error = new Error('No llegó ningún byte.');
      error.code = 'EMPTY';
      throw error;
    }

    const entry = { id, path, size: written, filename: filename || 'app.apk', at: Date.now() };
    this.#entries.set(id, entry);
    return entry;
  }

  get(id) {
    return this.#entries.get(id) ?? null;
  }

  async drop(id) {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.#entries.delete(id);
    await rm(entry.path, { force: true });
  }

  async dropAll() {
    await Promise.all([...this.#entries.keys()].map((id) => this.drop(id)));
  }
}
