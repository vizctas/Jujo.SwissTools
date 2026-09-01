/*
 * El cliente del puente.
 *
 * Aísla toda la conversación con el proceso local: si mañana aparece un transporte
 * por WebUSB, se escribe otro módulo con esta misma forma y la interfaz no se entera.
 *
 * Se ocupa de lo que siempre se olvida: reconexión con espera creciente, distinguir
 * «no hay puente» de «hay puente pero el token no vale», y no dejar peticiones
 * colgadas cuando el proceso muere a mitad.
 */

import type { BridgeEvent, BridgeHealth, InstalledPackage } from './protocol.ts';
import { PROTOCOL_VERSION } from './protocol.ts';

export type BridgeStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'absent' }
  | { kind: 'needs-token' }
  | { kind: 'no-adb'; message: string }
  | { kind: 'protocol-mismatch'; theirs: number; ours: number }
  | { kind: 'connected'; adb: { path: string; version: string } | null }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'error'; message: string };

export interface BridgeConfig {
  port: number;
  token: string;
}

const DEFAULT_PORT = 8787;

export function loadConfig(): BridgeConfig {
  try {
    const raw = localStorage.getItem('jujo.adb.bridge');
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BridgeConfig>;
      return { port: Number(parsed.port) || DEFAULT_PORT, token: String(parsed.token ?? '') };
    }
  } catch {
    // Sin almacenamiento el token se pide en cada visita, no es el fin del mundo.
  }
  return { port: DEFAULT_PORT, token: '' };
}

/**
 * Pregunta al servidor que sirve esta página por el puente y su token.
 *
 * En desarrollo lo responde un plugin de Vite; en producción, el propio puente,
 * que sirve la app compilada. En los dos casos es el mismo origen, así que no hay
 * CORS ni token previo que valga. Si no contesta nadie, se cae al token guardado o
 * al pegado a mano.
 */
export async function discoverConfig(): Promise<BridgeConfig | null> {
  try {
    const response = await fetch('/__bridge.json', {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<BridgeConfig>;
    if (!data.token) return null;
    return { port: Number(data.port) || DEFAULT_PORT, token: String(data.token) };
  } catch {
    return null;
  }
}

export function saveConfig(config: BridgeConfig): void {
  try {
    localStorage.setItem('jujo.adb.bridge', JSON.stringify(config));
  } catch {
    // Ignorado a propósito.
  }
}

export interface UploadResult {
  uploadId: string;
  size: number;
  filename: string;
}

export class BridgeClient {
  #config: BridgeConfig;
  #source: EventSource | null = null;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  onStatus: (status: BridgeStatus) => void = () => {};
  onEvent: (event: BridgeEvent) => void = () => {};

  constructor(config: BridgeConfig) {
    this.#config = config;
  }

  get base(): string {
    return `http://127.0.0.1:${this.#config.port}`;
  }

  update(config: BridgeConfig): void {
    this.#config = config;
    this.stop();
    void this.start();
  }

  /** ¿Hay puente ahí? `/health` no pide token justo para poder preguntarlo. */
  async probe(): Promise<BridgeHealth | null> {
    try {
      const response = await fetch(`${this.base}/health`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) return null;
      return (await response.json()) as BridgeHealth;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    this.#closed = false;
    this.onStatus({ kind: 'checking' });

    const health = await this.probe();
    if (!health) {
      this.onStatus({ kind: 'absent' });
      this.#scheduleRetry();
      return;
    }
    if (health.protocol !== PROTOCOL_VERSION) {
      this.onStatus({
        kind: 'protocol-mismatch',
        theirs: health.protocol,
        ours: PROTOCOL_VERSION,
      });
      return;
    }
    if (health.adbError) {
      this.onStatus({ kind: 'no-adb', message: health.adbError.message });
      return;
    }
    if (this.#config.token === '') {
      this.onStatus({ kind: 'needs-token' });
      return;
    }

    this.#openStream(health);
  }

  #openStream(health: BridgeHealth): void {
    this.#source?.close();
    const url = `${this.base}/events?token=${encodeURIComponent(this.#config.token)}`;
    const source = new EventSource(url);
    this.#source = source;

    let opened = false;

    source.onopen = () => {
      opened = true;
      this.#attempt = 0;
      this.onStatus({ kind: 'connected', adb: health.adb });
    };

    source.onmessage = (message) => {
      try {
        this.onEvent(JSON.parse(message.data) as BridgeEvent);
      } catch {
        // Un mensaje suelto ilegible no debe tumbar la conexión entera.
      }
    };

    source.onerror = () => {
      source.close();
      this.#source = null;
      if (this.#closed) return;
      // EventSource no da el código HTTP. Si nunca llegó a abrir, lo más probable
      // es un 401: el token no vale. Si ya estaba abierto, es que el puente murió.
      if (!opened) {
        void this.#diagnoseFailedOpen();
        return;
      }
      this.#attempt += 1;
      this.onStatus({ kind: 'reconnecting', attempt: this.#attempt });
      this.#scheduleRetry();
    };
  }

  async #diagnoseFailedOpen(): Promise<void> {
    const health = await this.probe();
    if (!health) {
      this.onStatus({ kind: 'absent' });
      this.#scheduleRetry();
      return;
    }
    this.onStatus({ kind: 'needs-token' });
  }

  #scheduleRetry(): void {
    if (this.#closed || this.#retryTimer) return;
    // Espera creciente con techo: reintentar cada 500 ms para siempre calienta el
    // portátil y llena la consola de errores de red.
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(this.#attempt, 4));
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.start();
    }, delay);
  }

  stop(): void {
    this.#closed = true;
    this.#source?.close();
    this.#source = null;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
  }

  async command<T = { ok: boolean; message?: string }>(body: unknown): Promise<T> {
    const response = await fetch(`${this.base}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jujo-token': this.#config.token },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(detail?.message ?? `El puente respondió ${response.status}.`);
    }
    return (await response.json()) as T;
  }

  packagesStatus(
    packageName: string,
    serials: string[],
  ): Promise<{ ok: boolean; installed?: Record<string, InstalledPackage | null> }> {
    return this.command({ t: 'packages.status', packageName, serials });
  }

  /**
   * Sube el APK con progreso real.
   *
   * Se usa XMLHttpRequest en lugar de fetch a propósito: fetch todavía no reporta
   * progreso de subida de forma fiable en todos los navegadores, y aquí el usuario
   * está mirando una barra durante 200 MB.
   */
  upload(
    file: File,
    { onProgress, signal }: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  ): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', `${this.base}/upload`);
      request.setRequestHeader('x-jujo-token', this.#config.token);
      request.setRequestHeader('x-jujo-filename', encodeURIComponent(file.name));
      request.setRequestHeader('content-type', 'application/octet-stream');

      request.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
      };
      request.onload = () => {
        if (request.status >= 200 && request.status < 300) {
          resolve(JSON.parse(request.responseText) as UploadResult);
        } else {
          const detail = (() => {
            try {
              return JSON.parse(request.responseText) as { message?: string };
            } catch {
              return null;
            }
          })();
          reject(new Error(detail?.message ?? `El puente rechazó la subida (${request.status}).`));
        }
      };
      request.onerror = () =>
        reject(new Error('Se perdió la conexión con el puente durante la subida.'));
      request.onabort = () => reject(new DOMException('Subida cancelada.', 'AbortError'));

      signal?.addEventListener('abort', () => request.abort(), { once: true });
      request.send(file);
    });
  }
}
