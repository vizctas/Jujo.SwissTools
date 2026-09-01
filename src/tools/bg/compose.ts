/*
 * Composición del recorte.
 *
 * Todo esto ocurre en canvas, sin volver a tocar el modelo: la máscara ya está y
 * cambiar el fondo, el umbral o el suavizado es solo repintar. Por eso mover un
 * slider aquí es instantáneo mientras que recortar tarda segundos.
 *
 * Lo que hace la diferencia entre un recorte que se nota y uno que no es el borde:
 * un umbral duro deja escalones y come el pelo, y por eso el suavizado se aplica
 * sobre la máscara y no sobre la imagen.
 */

export interface ComposeOptions {
  /** `null` deja el fondo transparente; si no, color hex. */
  background: string | null;
  /** Radio de suavizado del borde, en píxeles. */
  feather: number;
  /**
   * Desplaza el punto medio de la máscara. Negativo come sujeto, positivo lo engorda.
   * Sirve para rescatar halos del fondo viejo.
   */
  threshold: number;
  /** Recorta al rectángulo que ocupa el sujeto. */
  trim: boolean;
  format: 'png' | 'webp';
}

export const DEFAULT_COMPOSE: ComposeOptions = {
  background: null,
  feather: 0,
  threshold: 0,
  trim: false,
  format: 'png',
};

export interface MaskData {
  mask: Uint8Array;
  width: number;
  height: number;
}

/** Rectángulo que ocupa el sujeto, con un margen. Null si la máscara está vacía. */
export function subjectBounds(
  { mask, width, height }: MaskData,
  padding = 2,
): { x: number; y: number; width: number; height: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // 8 y no 0: por debajo de eso es ruido del modelo, no sujeto.
      if (mask[y * width + x]! <= 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const x = Math.max(0, minX - padding);
  const y = Math.max(0, minY - padding);
  return {
    x,
    y,
    width: Math.min(width, maxX + padding + 1) - x,
    height: Math.min(height, maxY + padding + 1) - y,
  };
}

/** Cuánto del encuadre ocupa el sujeto, 0–1. Sirve para avisar de recortes vacíos. */
export function coverage({ mask }: MaskData): number {
  let sum = 0;
  for (let index = 0; index < mask.length; index += 1) sum += mask[index]!;
  return sum / (mask.length * 255);
}

function maskCanvas(data: MaskData, options: ComposeOptions): HTMLCanvasElement {
  const { mask, width, height } = data;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(width, height);

  // Curva suave alrededor del punto medio en vez de un corte: mantiene el
  // semitransparente del pelo, que es justo lo que distingue un buen recorte.
  const shift = options.threshold * 2.55;
  for (let index = 0; index < mask.length; index += 1) {
    const value = Math.max(0, Math.min(255, mask[index]! + shift));
    const at = index * 4;
    image.data[at] = 255;
    image.data[at + 1] = 255;
    image.data[at + 2] = 255;
    image.data[at + 3] = value;
  }
  context.putImageData(image, 0, 0);

  if (options.feather > 0) {
    const blurred = document.createElement('canvas');
    blurred.width = width;
    blurred.height = height;
    const blurContext = blurred.getContext('2d')!;
    blurContext.filter = `blur(${options.feather}px)`;
    blurContext.drawImage(canvas, 0, 0);
    return blurred;
  }
  return canvas;
}

/** Pinta el recorte final. Devuelve el canvas para que quien llame decida qué hacer. */
export function composeCanvas(
  source: ImageBitmap | HTMLImageElement,
  data: MaskData,
  options: ComposeOptions,
): HTMLCanvasElement {
  const bounds = options.trim
    ? (subjectBounds(data) ?? { x: 0, y: 0, width: data.width, height: data.height })
    : { x: 0, y: 0, width: data.width, height: data.height };

  const cut = document.createElement('canvas');
  cut.width = data.width;
  cut.height = data.height;
  const cutContext = cut.getContext('2d')!;
  cutContext.drawImage(source, 0, 0, data.width, data.height);
  cutContext.globalCompositeOperation = 'destination-in';
  cutContext.drawImage(maskCanvas(data, options), 0, 0);
  cutContext.globalCompositeOperation = 'source-over';

  const out = document.createElement('canvas');
  out.width = bounds.width;
  out.height = bounds.height;
  const context = out.getContext('2d')!;
  if (options.background) {
    context.fillStyle = options.background;
    context.fillRect(0, 0, out.width, out.height);
  }
  context.drawImage(
    cut,
    bounds.x, bounds.y, bounds.width, bounds.height,
    0, 0, bounds.width, bounds.height,
  );
  return out;
}

export function canvasToBlob(canvas: HTMLCanvasElement, format: 'png' | 'webp'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('El navegador no pudo generar la imagen.'))),
      format === 'webp' ? 'image/webp' : 'image/png',
      format === 'webp' ? 0.95 : undefined,
    );
  });
}

/** `foto.jpg` -> `foto-sin-fondo.png` */
export function outputName(filename: string, format: 'png' | 'webp'): string {
  return `${filename.replace(/\.[^.]+$/, '')}-sin-fondo.${format}`;
}
