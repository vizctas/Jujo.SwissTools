/*
 * Color de la PIEZA, no del cromo.
 * El usuario elige en hex porque es lo que sale de <input type="color"> y lo que
 * pega desde su manual de marca. Los tokens de la app viven en OKLCH; esto es otro
 * dominio y mezclarlos sería una mentira de conversión.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isValidHex(value: string): boolean {
  return HEX_RE.test(value.trim());
}

/** Normaliza a `#rrggbb` en minúsculas. Devuelve null si no es un hex válido. */
export function normalizeHex(value: string): string | null {
  const match = HEX_RE.exec(value.trim());
  if (!match) return null;
  let body = match[1]!.toLowerCase();
  if (body.length === 3) {
    body = body
      .split('')
      .map((ch) => ch + ch)
      .join('');
  }
  return `#${body}`;
}

export function hexToRgb(hex: string): Rgb {
  const normalized = normalizeHex(hex) ?? '#000000';
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

/** Luminancia relativa WCAG 2.x. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Ratio de contraste WCAG entre dos colores. Siempre >= 1. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/** Redondeado a un decimal, que es como se muestra en la tira de validación. */
export function formatRatio(ratio: number): string {
  return `${Math.round(ratio * 10) / 10}:1`;
}

/**
 * Empuja el color hacia negro o hacia blanco hasta alcanzar el ratio pedido contra
 * `against`. Es la corrección de un clic de la tira de validación.
 *
 * La dirección es explícita a propósito: en un QR el módulo tiene que quedar más
 * oscuro que el fondo, así que "aumentar contraste" no es simétrico. Deducirla del
 * color actual daría la corrección equivocada cuando la polaridad ya está invertida.
 */
export function pushToContrast(
  hex: string,
  against: string,
  target: number,
  direction: 'darker' | 'lighter',
): string {
  const towardDark = direction === 'darker';
  const { r, g, b } = hexToRgb(hex);
  let best = normalizeHex(hex) ?? '#000000';

  // 40 pasos basta: cada uno mueve ~2.5% hacia el extremo.
  for (let step = 1; step <= 40; step += 1) {
    const t = step / 40;
    const mix = (channel: number): number =>
      Math.round(towardDark ? channel * (1 - t) : channel + (255 - channel) * t);
    const candidate = `#${[mix(r), mix(g), mix(b)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')}`;
    best = candidate;
    if (contrastRatio(candidate, against) >= target) break;
  }
  return best;
}
