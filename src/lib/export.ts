/*
 * Exportación.
 *
 * El SVG que sale de aquí es el mismo que se ve en la mesa, más dos cosas que la
 * vista previa no necesita: dimensiones en píxeles y las fuentes embebidas.
 *
 * Embeber la fuente no es adorno. Sin ella el SVG se abre en Illustrator con una
 * tipografía distinta y el rasterizado a PNG ni siquiera intenta cargarla: el texto
 * saldría con la fuente por defecto del navegador. Sería el principio 2 roto en el
 * único sitio donde el usuario no puede verlo antes de que sea tarde.
 */

import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import monoUrl from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url';
import serifUrl from '@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2?url';
import type { MeasureText } from './render.ts';
import type { CaptionFont } from './types.ts';

interface FontSpec {
  url: string;
  family: string;
  weight: string;
}

const FONTS: Record<CaptionFont, FontSpec> = {
  ui: { url: interUrl, family: 'Inter Variable', weight: '100 900' },
  value: { url: monoUrl, family: 'JetBrains Mono Variable', weight: '100 800' },
  serif: { url: serifUrl, family: 'Instrument Serif', weight: '400' },
};

const cache = new Map<CaptionFont, string>();

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // En trozos: pasar 200 KB de golpe a fromCharCode revienta la pila de argumentos.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Bloque `@font-face` autocontenido para la fuente del texto de la pieza.
 * Devuelve cadena vacía si la fuente no se puede leer: mejor exportar con la
 * tipografía de reserva que no exportar.
 */
export async function embeddedFontCss(font: CaptionFont): Promise<string> {
  const cached = cache.get(font);
  if (cached !== undefined) return cached;

  const spec = FONTS[font];
  try {
    const response = await fetch(spec.url);
    if (!response.ok) throw new Error(String(response.status));
    const base64 = toBase64(await response.arrayBuffer());
    const css = `@font-face{font-family:'${spec.family}';font-style:normal;font-weight:${spec.weight};src:url(data:font/woff2;base64,${base64}) format('woff2');}`;
    cache.set(font, css);
    return css;
  } catch {
    return '';
  }
}

/** Un `@font-face` por cada fuente que la pieza usa de verdad. */
export async function embeddedFontsFor(fonts: Iterable<CaptionFont>): Promise<string> {
  const unique = [...new Set(fonts)];
  const blocks = await Promise.all(unique.map(embeddedFontCss));
  return blocks.join('');
}

/** Mide texto con la fuente real, para que el ajuste no sea a ojo. */
export function createTextMeasurer(): MeasureText {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  return (text, fontSize, fontFamily) => {
    if (!context) return 0;
    // Se mide a 100px y se escala: por debajo de ~10px el hinting falsea el ancho.
    context.font = `${100}px ${fontFamily}`;
    return (context.measureText(text).width / 100) * fontSize;
  };
}

let shared: MeasureText | null = null;

/**
 * Medidor compartido. La geometría del centro se calcula en el reducer, en el
 * render y en la exportación; con tres canvases distintos habría tres verdades.
 */
export function textMeasurer(): MeasureText {
  shared ??= createTextMeasurer();
  return shared;
}

export async function svgToPngBlob(
  svg: string,
  pixelWidth: number,
  pixelHeight: number,
): Promise<Blob> {
  const source = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('El navegador no pudo rasterizar la pieza.'));
      image.src = source;
    });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(pixelWidth);
    canvas.height = Math.round(pixelHeight);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Sin contexto 2D disponible.');
    // Nada de fondo pintado: si la pieza es transparente, el PNG también lo es.
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('No se pudo generar el PNG.'))),
        'image/png',
      );
    });
  } finally {
    URL.revokeObjectURL(source);
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // El revoke inmediato corta la descarga en algunos navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Nombre de archivo legible y seguro en cualquier sistema. */
export function safeFilename(base: string, extension: string): string {
  const cleaned = base
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // "Menú" -> "menu"
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48);
  return `${cleaned || 'codigo-qr'}.${extension}`;
}
