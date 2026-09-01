/** Mensajes entre la interfaz y el worker del modelo. */

export type BgWorkerRequest =
  | { t: 'load'; modelId: string; dtype: string; device: 'auto' | 'webgpu' | 'wasm' }
  | { t: 'process'; id: string; blob: Blob }
  | { t: 'cancel'; id: string }
  | { t: 'cancel-all' };

export type BgWorkerResponse =
  | { t: 'loading'; modelId: string; device: string; progress: number; file: string | null }
  | { t: 'ready'; modelId: string; device: string }
  | { t: 'load-failed'; modelId: string; message: string }
  | { t: 'started'; id: string }
  | { t: 'done'; id: string; mask: Uint8Array; width: number; height: number; ms: number }
  | { t: 'failed'; id: string; message: string }
  | { t: 'cancelled'; id: string };
