/// <reference lib="webworker" />
/*
 * El modelo, en un hilo aparte.
 *
 * Una pasada de segmentación bloquea el hilo principal varios segundos; en un lote
 * de veinte imágenes eso es una pestaña congelada. Aquí el trabajo va en un worker y
 * la interfaz sigue respondiendo, se puede cancelar y se ve el progreso de verdad.
 *
 * El worker devuelve **solo la máscara alfa**, no la imagen compuesta. Es lo que
 * permite cambiar el fondo, el suavizado o el umbral sin volver a pasar el modelo:
 * recomponer es instantáneo, inferir cuesta segundos.
 */

import type { BgWorkerRequest, BgWorkerResponse } from './protocol.ts';

const post = (message: BgWorkerResponse, transfer?: Transferable[]): void => {
  (self as unknown as Worker).postMessage(message, transfer ?? []);
};

type Pipeline = (input: unknown) => Promise<unknown>;

let pipe: Pipeline | null = null;
let loadedId: string | null = null;
let loadedDevice: string | null = null;
const cancelled = new Set<string>();

/**
 * La carga en curso.
 *
 * Sin esto, una imagen soltada a la vez que se elige el modelo entra en la cola
 * antes de que el modelo exista y se rechaza sola. Encolar y cargar son simultáneos
 * por naturaleza —el usuario suelta archivos y el modelo empieza a bajar en el mismo
 * gesto— así que la cola espera en lugar de fallar.
 */
let loading: Promise<void> | null = null;
let loadError: string | null = null;

/** Descubre si hay WebGPU sin romperse en navegadores que no lo traen. */
async function pickDevice(preferred: string): Promise<'webgpu' | 'wasm'> {
  if (preferred === 'wasm') return 'wasm';
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return 'wasm';
  try {
    return (await gpu.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

function load(modelId: string, dtype: string, preferred: string): Promise<void> {
  loadError = null;
  loading = doLoad(modelId, dtype, preferred);
  return loading;
}

async function doLoad(modelId: string, dtype: string, preferred: string): Promise<void> {
  const device = await pickDevice(preferred);
  if (pipe && loadedId === modelId && loadedDevice === device) {
    post({ t: 'ready', modelId, device });
    return;
  }

  // Import diferido: la librería pesa y no debe entrar en el bundle inicial de una
  // app cuya primera herramienta es un generador de QR.
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;

  post({ t: 'loading', modelId, device, progress: 0, file: null });

  try {
    pipe = (await pipeline('background-removal', modelId, {
      device,
      // fp16 solo tiene sentido en GPU; en WASM se queda en la precisión del modelo.
      dtype: device === 'webgpu' ? (dtype as 'fp16' | 'fp32' | 'q8') : undefined,
      progress_callback: (event: { status: string; file?: string; progress?: number }) => {
        if (event.status === 'progress') {
          post({
            t: 'loading',
            modelId,
            device,
            progress: Math.round(event.progress ?? 0),
            file: event.file ?? null,
          });
        }
      },
    })) as unknown as Pipeline;
    loadedId = modelId;
    loadedDevice = device;
    post({ t: 'ready', modelId, device });
  } catch (error) {
    pipe = null;
    loadedId = null;
    loadError = String((error as Error)?.message ?? error);
    post({ t: 'load-failed', modelId, message: loadError });
  }
}

interface RawImageLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels: number;
}

async function process(id: string, blob: Blob): Promise<void> {
  // Espera a que termine la carga en vez de rechazar el trabajo.
  if (loading) await loading.catch(() => {});
  if (!pipe) {
    post({
      t: 'failed',
      id,
      message: loadError ?? 'El modelo no está cargado. Cárgalo desde el panel.',
    });
    return;
  }
  const started = performance.now();
  try {
    const bitmap = await createImageBitmap(blob);
    const { RawImage } = await import('@huggingface/transformers');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Sin contexto 2D en el worker.');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const image = new RawImage(
      new Uint8ClampedArray(pixels.data),
      canvas.width,
      canvas.height,
      4,
    );

    if (cancelled.has(id)) {
      cancelled.delete(id);
      post({ t: 'cancelled', id });
      return;
    }

    const output = (await pipe(image as unknown)) as RawImageLike | RawImageLike[];
    const result = Array.isArray(output) ? output[0]! : output;

    if (cancelled.has(id)) {
      cancelled.delete(id);
      post({ t: 'cancelled', id });
      return;
    }

    // Solo el canal alfa: una cuarta parte de los bytes y todo lo que hace falta
    // para recomponer en el hilo principal.
    const mask = new Uint8Array(result.width * result.height);
    for (let index = 0; index < mask.length; index += 1) {
      mask[index] = result.data[index * 4 + 3]!;
    }

    post(
      {
        t: 'done',
        id,
        mask,
        width: result.width,
        height: result.height,
        ms: Math.round(performance.now() - started),
      },
      [mask.buffer],
    );
  } catch (error) {
    post({ t: 'failed', id, message: String((error as Error)?.message ?? error) });
  }
}

/** Cola en serie: la GPU no se reparte, y dos pasadas a la vez solo van más lento. */
const queue: { id: string; blob: Blob }[] = [];
let working = false;

async function drain(): Promise<void> {
  if (working) return;
  working = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    if (cancelled.has(job.id)) {
      cancelled.delete(job.id);
      post({ t: 'cancelled', id: job.id });
      continue;
    }
    post({ t: 'started', id: job.id });
    await process(job.id, job.blob);
  }
  working = false;
}

self.addEventListener('message', (event: MessageEvent<BgWorkerRequest>) => {
  const message = event.data;
  switch (message.t) {
    case 'load':
      void load(message.modelId, message.dtype, message.device).catch(() => {});
      break;
    case 'process':
      queue.push({ id: message.id, blob: message.blob });
      void drain();
      break;
    case 'cancel':
      cancelled.add(message.id);
      break;
    case 'cancel-all':
      for (const job of queue) cancelled.add(job.id);
      queue.length = 0;
      break;
    default:
      break;
  }
});
