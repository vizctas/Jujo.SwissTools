/*
 * El render.
 *
 * Esta función es la única que dibuja un QR en toda la app: la vista previa y la
 * exportación consumen exactamente el mismo string. Es lo que hace verdad el
 * principio 2 de PRODUCT.md — no hay dos caminos que puedan divergir.
 *
 * Sistema de coordenadas: 1 unidad = 1 módulo. El escalado a píxeles lo decide
 * quien exporta, nunca este archivo.
 */

import { finderOrigins } from './qr.ts';
import type { CaptionFont, Matrix, QrDesign } from './types.ts';

export interface RenderOptions {
  /**
   * Mide texto para poder encogerlo cuando no cabe en la pieza. En el navegador
   * lo provee un canvas; sin él, el texto simplemente no se ajusta.
   */
  measureText?: (text: string, fontSizePx: number, fontFamily: string) => number;
  /** Bloque `@font-face` con las fuentes en base64, para exportaciones autocontenidas. */
  embeddedFontCss?: string;
  /** Marca de accesibilidad: título del SVG para lectores de pantalla. */
  title?: string;
  /**
   * Ancho en píxeles. Añade width/height explícitos al `<svg>`, que es lo que
   * necesitan tanto el rasterizado a canvas como Illustrator al abrir el archivo.
   * Sin esto la vista previa escala sola con su contenedor.
   */
  pixelWidth?: number;
}

export interface RenderResult {
  svg: string;
  /** Ancho y alto de la pieza, en módulos. */
  width: number;
  height: number;
  /** Rectángulo del logo en coordenadas de módulo, si hay logo. */
  logoRect: { x: number; y: number; size: number } | null;
}

export const FONT_STACKS: Record<CaptionFont, string> = {
  ui: "'Inter Variable', system-ui, sans-serif",
  serif: "'Instrument Serif', Georgia, serif",
  value: "'JetBrains Mono Variable', ui-monospace, monospace",
};

/** Los ids deben ser únicos por documento: la mesa y las miniaturas del historial conviven. */
let idCounter = 0;

/** Recorta decimales: un SVG con 15 dígitos por coordenada pesa el triple sin verse mejor. */
function n(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type Corners = [tl: number, tr: number, br: number, bl: number];

function roundedRectPath(x: number, y: number, w: number, h: number, c: Corners): string {
  const [tl, tr, br, bl] = c;
  let d = `M${n(x + tl)},${n(y)}`;
  d += `H${n(x + w - tr)}`;
  if (tr > 0) d += `A${n(tr)},${n(tr)} 0 0 1 ${n(x + w)},${n(y + tr)}`;
  d += `V${n(y + h - br)}`;
  if (br > 0) d += `A${n(br)},${n(br)} 0 0 1 ${n(x + w - br)},${n(y + h)}`;
  d += `H${n(x + bl)}`;
  if (bl > 0) d += `A${n(bl)},${n(bl)} 0 0 1 ${n(x)},${n(y + h - bl)}`;
  d += `V${n(y + tl)}`;
  if (tl > 0) d += `A${n(tl)},${n(tl)} 0 0 1 ${n(x + tl)},${n(y)}`;
  return `${d}Z`;
}

function circlePath(cx: number, cy: number, r: number): string {
  return `M${n(cx - r)},${n(cy)}a${n(r)},${n(r)} 0 1,0 ${n(r * 2)},0a${n(r)},${n(r)} 0 1,0 ${n(-r * 2)},0Z`;
}

function diamondPath(cx: number, cy: number, r: number): string {
  return `M${n(cx)},${n(cy - r)}L${n(cx + r)},${n(cy)}L${n(cx)},${n(cy + r)}L${n(cx - r)},${n(cy)}Z`;
}

export type MeasureText = (text: string, fontSizePx: number, fontFamily: string) => number;

export interface CenterSlot {
  kind: 'logo' | 'text';
  /** Caja ocupada con su margen, en módulos, relativa al área del código. */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Lado del cuadrado de área equivalente, como fracción del lado del código.
   * El límite del formato es de área, y un texto es ancho y bajo: comparar solo
   * su anchura daría por rota una pieza que en realidad tapa mucho menos.
   */
  widthRatio: number;
}

/**
 * Qué ocupa el centro del código. El logo manda: si lo hay, el texto no se dibuja,
 * porque los dos viven en la misma ranura. Devuelve null si el centro está libre.
 */
export function centerSlot(
  design: QrDesign,
  matrixSize: number,
  measureText?: MeasureText,
): CenterSlot | null {
  const pad = design.logoPadding;

  if (design.logo) {
    const side = design.logoScale * matrixSize;
    const w = side + pad * 2;
    const start = (matrixSize - w) / 2;
    return { kind: 'logo', x: start, y: start, w, h: w, widthRatio: w / matrixSize };
  }

  const text = design.centerText.trim();
  if (text === '') return null;

  const fontSize = design.centerTextSize;
  // Sin medidor (Node, self-check) se estima por número de caracteres: basta para
  // que la geometría sea coherente, y en el navegador siempre hay medidor real.
  const textWidth =
    measureText?.(text, fontSize, FONT_STACKS[design.centerTextFont]) ?? text.length * fontSize * 0.6;
  const w = textWidth + pad * 2;
  const h = fontSize * 1.15 + pad * 2;
  return {
    kind: 'text',
    x: (matrixSize - w) / 2,
    y: (matrixSize - h) / 2,
    w,
    h,
    widthRatio: Math.sqrt(w * h) / matrixSize,
  };
}

/**
 * El mayor tamaño de texto central que cabe en el presupuesto dado.
 *
 * Un tamaño fijo en módulos no sirve como valor inicial: los mismos 4 módulos son
 * el 38% de un código de 33 y el 12% de uno de 77. Se busca por pasos porque el
 * ancho del texto depende de la fuente y no hay fórmula cerrada.
 */
export function fitCenterTextSize(
  design: QrDesign,
  matrixSize: number,
  targetRatio: number,
  measureText?: MeasureText,
): number {
  let best = 1.5;
  for (let size = 1.5; size <= 10; size += 0.25) {
    const slot = centerSlot({ ...design, logo: null, centerTextSize: size }, matrixSize, measureText);
    if (!slot || slot.widthRatio > targetRatio) break;
    best = size;
  }
  return best;
}

/**
 * Máscara de lo que NO dibuja la capa de módulos: los tres patrones de búsqueda
 * (los pinta la capa de ojos) y el hueco del centro cuando hay recorte.
 */
function buildMask(
  matrix: Matrix,
  design: QrDesign,
  slot: CenterSlot | null,
): (row: number, col: number) => boolean {
  const size = matrix.size;
  const finders = finderOrigins(size);
  const hole = slot && design.logoPunchout ? slot : null;

  return (row, col) => {
    for (const [fr, fc] of finders) {
      if (row >= fr && row < fr + 7 && col >= fc && col < fc + 7) return false;
    }
    if (hole) {
      // El módulo se borra si su celda solapa el hueco, no solo si su centro cae dentro.
      const overlaps =
        col + 1 > hole.x &&
        col < hole.x + hole.w &&
        row + 1 > hole.y &&
        row < hole.y + hole.h;
      if (overlaps) return false;
    }
    return true;
  };
}

function modulePath(
  matrix: Matrix,
  design: QrDesign,
  offset: number,
  slot: CenterSlot | null,
): string {
  const size = matrix.size;
  const allowed = buildMask(matrix, design, slot);
  const on = (row: number, col: number): boolean =>
    row >= 0 && col >= 0 && row < size && col < size && matrix.get(row, col) && allowed(row, col);

  const parts: string[] = [];
  const scale = design.moduleShape === 'connected' ? 1 : design.moduleScale;
  const inset = (1 - scale) / 2;

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!on(row, col)) continue;
      const x = offset + col + inset;
      const y = offset + row + inset;
      const cx = offset + col + 0.5;
      const cy = offset + row + 0.5;

      switch (design.moduleShape) {
        case 'square':
          parts.push(roundedRectPath(x, y, scale, scale, [0, 0, 0, 0]));
          break;
        case 'rounded':
          parts.push(
            roundedRectPath(x, y, scale, scale, Array(4).fill(scale * 0.3) as Corners),
          );
          break;
        case 'dot':
          parts.push(circlePath(cx, cy, scale / 2));
          break;
        case 'diamond':
          parts.push(diamondPath(cx, cy, scale / 2));
          break;
        case 'connected': {
          // Redondea una esquina solo cuando los dos vecinos que la forman están
          // apagados. El resultado son manchas continuas que se cortan limpias
          // contra el hueco del logo y contra los ojos.
          const up = on(row - 1, col);
          const down = on(row + 1, col);
          const left = on(row, col - 1);
          const right = on(row, col + 1);
          const r = 0.5;
          const corners: Corners = [
            !up && !left ? r : 0,
            !up && !right ? r : 0,
            !down && !right ? r : 0,
            !down && !left ? r : 0,
          ];
          parts.push(roundedRectPath(x, y, 1, 1, corners));
          break;
        }
      }
    }
  }
  return parts.join('');
}

function eyeFramePath(design: QrDesign, x: number, y: number): string {
  switch (design.eyeFrame) {
    case 'circle':
      return circlePath(x + 3.5, y + 3.5, 3.5) + circlePath(x + 3.5, y + 3.5, 2.5);
    case 'rounded':
      return (
        roundedRectPath(x, y, 7, 7, [1.9, 1.9, 1.9, 1.9]) +
        roundedRectPath(x + 1, y + 1, 5, 5, [1.15, 1.15, 1.15, 1.15])
      );
    case 'leaf':
      return (
        roundedRectPath(x, y, 7, 7, [3.5, 0, 3.5, 0]) +
        roundedRectPath(x + 1, y + 1, 5, 5, [2.5, 0, 2.5, 0])
      );
    case 'square':
    default:
      return (
        roundedRectPath(x, y, 7, 7, [0, 0, 0, 0]) +
        roundedRectPath(x + 1, y + 1, 5, 5, [0, 0, 0, 0])
      );
  }
}

function eyeBallPath(design: QrDesign, x: number, y: number): string {
  const bx = x + 2;
  const by = y + 2;
  switch (design.eyeBall) {
    case 'circle':
      return circlePath(bx + 1.5, by + 1.5, 1.5);
    case 'rounded':
      return roundedRectPath(bx, by, 3, 3, [0.9, 0.9, 0.9, 0.9]);
    case 'diamond':
      return diamondPath(bx + 1.5, by + 1.5, 1.5);
    case 'square':
    default:
      return roundedRectPath(bx, by, 3, 3, [0, 0, 0, 0]);
  }
}

export function renderSvg(
  matrix: Matrix,
  design: QrDesign,
  options: RenderOptions = {},
): RenderResult {
  const size = matrix.size;
  const qz = design.quietZone;
  const width = size + qz * 2;

  const hasCaption = design.caption.trim().length > 0;
  const hasSub = design.subcaption.trim().length > 0;
  const captionSize = design.captionSize;
  const subSize = captionSize * 0.72;
  const captionBlock = hasCaption || hasSub
    ? design.captionGap +
      (hasCaption ? captionSize * 1.25 : 0) +
      (hasSub ? subSize * 1.35 : 0)
    : 0;
  const height = width + captionBlock;

  const layers: string[] = [];

  if (!design.bgTransparent) {
    layers.push(
      `<rect width="${n(width)}" height="${n(height)}" fill="${escapeXml(design.bgColor)}"/>`,
    );
  }

  const slot = centerSlot(design, size, options.measureText);

  layers.push(
    `<path fill="${escapeXml(design.moduleColor)}" d="${modulePath(matrix, design, qz, slot)}"/>`,
  );

  const frameColor = design.eyeCustomColor ? design.eyeFrameColor : design.moduleColor;
  const ballColor = design.eyeCustomColor ? design.eyeBallColor : design.moduleColor;
  const frames: string[] = [];
  const balls: string[] = [];
  for (const [row, col] of finderOrigins(size)) {
    frames.push(eyeFramePath(design, qz + col, qz + row));
    balls.push(eyeBallPath(design, qz + col, qz + row));
  }
  layers.push(
    `<path fill="${escapeXml(frameColor)}" fill-rule="evenodd" d="${frames.join('')}"/>`,
    `<path fill="${escapeXml(ballColor)}" d="${balls.join('')}"/>`,
  );

  let logoRect: RenderResult['logoRect'] = null;
  if (slot) {
    if (design.logoPunchout) {
      // Placa bajo el centro: sin ella, recortar módulos dejaría un agujero.
      // ponytail: sobre fondo transparente se asume blanco, que es el caso de impresión.
      const rx = (Math.min(slot.w, slot.h) * design.logoRadius) / 100;
      layers.push(
        `<rect x="${n(qz + slot.x)}" y="${n(qz + slot.y)}" width="${n(slot.w)}" height="${n(slot.h)}" rx="${n(rx)}" fill="${escapeXml(
          design.bgTransparent ? '#ffffff' : design.bgColor,
        )}"/>`,
      );
    }
  }

  if (slot?.kind === 'text') {
    const family = FONT_STACKS[design.centerTextFont];
    const fontSize = design.centerTextSize;
    // Línea base calculada a mano: `dominant-baseline` no viaja bien a Illustrator.
    const baseline = qz + size / 2 + fontSize * 0.35;
    layers.push(
      `<text x="${n(qz + size / 2)}" y="${n(baseline)}" text-anchor="middle" font-family="${escapeXml(
        family,
      )}" font-size="${n(fontSize)}" font-weight="600" fill="${escapeXml(
        design.centerTextColor,
      )}">${escapeXml(design.centerText.trim())}</text>`,
    );
  }

  if (design.logo && slot) {
    const side = design.logoScale * size;
    const x = qz + (size - side) / 2;
    const y = qz + (size - side) / 2;
    logoRect = { x, y, size: side };

    const radius = (side * design.logoRadius) / 100;
    idCounter += 1;
    const clipId = `jujo-logo-${idCounter}`;
    const href = escapeXml(design.logo.dataUri);
    layers.push(
      `<clipPath id="${clipId}"><rect x="${n(x)}" y="${n(y)}" width="${n(side)}" height="${n(side)}" rx="${n(radius)}"/></clipPath>`,
      // href y xlink:href: Illustrator e InDesign siguen leyendo el segundo.
      `<image clip-path="url(#${clipId})" x="${n(x)}" y="${n(y)}" width="${n(side)}" height="${n(side)}" preserveAspectRatio="xMidYMid meet" href="${href}" xlink:href="${href}"/>`,
    );
  }

  if (hasCaption || hasSub) {
    const family = FONT_STACKS[design.captionFont];
    const centerX = width / 2;
    const available = size; // el texto no invade la zona de silencio
    let cursor = width + design.captionGap;

    const textNode = (
      text: string,
      fontSize: number,
      weight: number,
      opacity: number,
    ): string => {
      const baseline = cursor + fontSize;
      cursor = baseline + fontSize * 0.28;
      const measured = options.measureText?.(text, fontSize, family);
      // Solo se encoge cuando de verdad no cabe; nunca se estira.
      const fit =
        measured !== undefined && measured > available
          ? ` textLength="${n(available)}" lengthAdjust="spacingAndGlyphs"`
          : '';
      const alpha = opacity < 1 ? ` opacity="${opacity}"` : '';
      return `<text x="${n(centerX)}" y="${n(baseline)}" text-anchor="middle" font-family="${escapeXml(
        family,
      )}" font-size="${n(fontSize)}" font-weight="${weight}" fill="${escapeXml(
        design.captionColor,
      )}"${alpha}${fit}>${escapeXml(text)}</text>`;
    };

    if (hasCaption) layers.push(textNode(design.caption.trim(), captionSize, 600, 1));
    if (hasSub) {
      if (hasCaption) cursor += subSize * 0.1;
      layers.push(textNode(design.subcaption.trim(), subSize, 400, 0.78));
    }
  }

  const fontCss = options.embeddedFontCss
    ? `<defs><style type="text/css">${options.embeddedFontCss}</style></defs>`
    : '';
  const title = options.title
    ? `<title>${escapeXml(options.title)}</title>`
    : '';

  const pixels =
    options.pixelWidth !== undefined
      ? ` width="${n(options.pixelWidth)}" height="${n((options.pixelWidth * height) / width)}"`
      : '';

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"${pixels} ` +
    `viewBox="0 0 ${n(width)} ${n(height)}" shape-rendering="geometricPrecision" role="img">` +
    title +
    fontCss +
    layers.join('') +
    `</svg>`;

  return { svg, width, height, logoRect };
}
