/**
 * El contrato con el puente, visto desde la app.
 *
 * Es una copia deliberada de `bridge/lib/protocol.mjs`: son dos programas que se
 * actualizan por separado, y hacer que la web importe del paquete del puente
 * significaría que una versión vieja del puente rompe la web en silencio.
 * `PROTOCOL_VERSION` es el que avisa cuando se han separado.
 */

export const PROTOCOL_VERSION = 1;

export type DeviceState = 'device' | 'unauthorized' | 'offline' | 'recovery' | string;

export interface DeviceDetails {
  release: string | null;
  sdk: number | null;
  abis: string[];
  model: string | null;
}

export interface BridgeDevice {
  serial: string;
  /** `remembered` es un conocido que ahora no está conectado. */
  state: DeviceState | 'remembered';
  model: string | null;
  product: string | null;
  transport: 'usb' | 'tcp';
  details: DeviceDetails | null;
  freeSpace: number | null;
  /** Lo que sabe la memoria del puente. */
  label?: string | null;
  address?: string | null;
  autoConnect?: boolean;
  lastSeen?: number;
  known?: boolean;
}

export interface SnifferProfile {
  id: string;
  name: string;
  logFilter: string;
  pattern: string | null;
  builtin: boolean;
}

export interface SnifferSession {
  serial: string;
  profile: SnifferProfile;
  lines: number;
  urls: number;
  startedAt: number;
  restarts: number;
}

export interface MediaProbe {
  ok: boolean;
  kind?: 'direct' | 'hls-master' | 'hls-media' | 'dash' | 'unknown';
  contentType?: string;
  size?: number | null;
  encrypted?: boolean;
  resumable?: boolean;
  variants?: { url: string; bandwidth: number | null; resolution: string | null; codecs: string | null }[];
  detail?: string;
}

export interface InstalledPackage {
  versionCode: number | null;
  versionName: string | null;
}

export type InstallPhase = 'preparing' | 'uninstalling' | 'transferring';

export type BridgeEvent =
  | {
      t: 'hello';
      protocol: number;
      adb: { path: string; version: string } | null;
      downloadDir?: string;
      tools?: { ffmpeg: boolean; ffprobe: boolean };
      profiles?: SnifferProfile[];
      sessions?: SnifferSession[];
    }
  | { t: 'devices.reconnected'; address: string }
  | { t: 'sniffer.started'; serial: string; profile: SnifferProfile }
  | { t: 'sniffer.stopped'; serial: string }
  | { t: 'sniffer.profile'; serial: string; profile: SnifferProfile }
  | { t: 'sniffer.lines'; serial: string; lines: string[]; total: number }
  | { t: 'sniffer.url'; serial: string; url: string; at: number }
  | { t: 'sniffer.error'; serial: string; message: string }
  | { t: 'sniffer.reconnecting'; serial: string; attempt: number; delay: number }
  | { t: 'capture.started'; id: string; url: string; serial: string | null }
  | { t: 'capture.progress'; id: string; done: number; total: number | null; phase: string }
  | {
      t: 'capture.done';
      id: string;
      ok: boolean;
      path: string;
      size: number;
      kind: string;
      duration: number | null;
      resolution: string | null;
      detail: string | null;
    }
  | { t: 'capture.failed'; id: string; message: string; cancelled: boolean }
  | { t: 'devices'; devices: BridgeDevice[] }
  | { t: 'devices.error'; message: string }
  | { t: 'install.phase'; jobId: string; serial: string; phase: InstallPhase }
  | { t: 'install.progress'; jobId: string; serial: string; percent: number }
  | {
      t: 'install.result';
      jobId: string;
      serial: string;
      ok: boolean;
      code?: string;
      message?: string;
      flag?: InstallFlag | null;
      flagLabel?: string | null;
      output?: string;
    }
  | { t: 'install.done'; jobId: string }
  | { t: 'install.rejected'; jobId: string; message: string };

/** Banderas que la app puede pedir. El puente las traduce a argumentos de adb. */
export type InstallFlag =
  | 'reinstall'
  | 'downgrade'
  | 'grantPermissions'
  | 'allowTest'
  | 'uninstallFirst';

export interface BridgeHealth {
  name: string;
  protocol: number;
  adb: { path: string; version: string } | null;
  adbError: { code: string; message: string } | null;
  requiresToken: boolean;
  downloadDir?: string;
  tools?: { ffmpeg: boolean; ffprobe: boolean };
}

export interface Capture {
  id: string;
  url: string;
  serial: string | null;
  kind: string | null;
  status: 'downloading' | 'saved' | 'suspect' | 'failed' | 'cancelled';
  path: string | null;
  size: number | null;
  duration: number | null;
  detail: string | null;
  createdAt: number;
}
