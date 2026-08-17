/*
 * El guardián de escaneabilidad.
 *
 * Principio 3 de PRODUCT.md: nunca dejar exportar un QR roto. Este archivo conoce
 * las reglas físicas del formato y las aplica antes de que el usuario se equivoque.
 * Cada hallazgo dice problema, consecuencia y acción en una sola línea, y trae la
 * corrección aplicable de un clic.
 */

import { contrastRatio, formatRatio, pushToContrast } from './color.ts';
import type { ErrorLevel, QrDesign } from './types.ts';

export type Severity = 'ok' | 'warning' | 'broken';

export interface Finding {
  id: string;
  severity: Exclude<Severity, 'ok'>;
  message: string;
  fix?: { label: string; patch: Partial<QrDesign> };
}

export interface ValidationResult {
  severity: Severity;
  findings: Finding[];
  /** Notas neutras: contexto, no problemas. */
  notes: string[];
  contrast: number;
  effectiveBg: string;
  logoWidthRatio: number;
  logoLimit: number;
}

/**
 * Presupuesto del centro por nivel de corrección: lado del cuadrado de área
 * equivalente, como fracción del lado del código.
 *
 * Son límites de práctica, no de norma: la norma habla de codewords recuperables,
 * pero lo que hay en el centro tapa un área contigua y el margen real es menor
 * que el teórico.
 */
export const CENTER_LIMIT: Record<ErrorLevel, number> = { L: 0.1, M: 0.15, Q: 0.2, H: 0.3 };
const LEVEL_ORDER: readonly ErrorLevel[] = ['L', 'M', 'Q', 'H'];

/** Contraste por debajo del cual la mayoría de lectores fallan. */
const CONTRAST_BROKEN = 2.5;
/** Contraste mínimo cómodo para impresión y cámaras mediocres. */
const CONTRAST_SAFE = 4;
/** Objetivo de las correcciones: por encima del umbral, no justo encima de él. */
const CONTRAST_TARGET = 4.6;

/** Lo que ocupa el centro del código, venga de un logo o de un texto. */
export interface CenterOccupancy {
  kind: 'logo' | 'text';
  /** Lado del cuadrado de área equivalente, como fracción del lado del código. */
  widthRatio: number;
  /**
   * Tamaño de texto que sí cabría, ya medido con la fuente real. Sin esto la
   * corrección solo puede encoger a ciegas, y con una palabra larga habría que
   * pulsarla varias veces: el resto de correcciones de la app dejan la pieza
   * verificada de un clic y esta no puede ser la excepción.
   */
  fittedSize?: number;
}

export function logoWidthRatio(design: QrDesign, matrixSize: number): number {
  if (!design.logo) return 0;
  return design.logoScale + (design.logoPadding * 2) / matrixSize;
}

/** Respaldo cuando quien llama no puede medir texto (Node, self-check). */
function fallbackOccupancy(design: QrDesign, matrixSize: number): CenterOccupancy | null {
  if (!design.logo) return null;
  return { kind: 'logo', widthRatio: logoWidthRatio(design, matrixSize) };
}

/** Fracción del presupuesto por encima de la cual se avisa de que va justo. */
const COMFORT = 0.85;

/** Nivel mínimo que tolera esa ocupación del centro, o null si ninguno lo hace. */
export function minimumLevelForLogo(widthRatio: number): ErrorLevel | null {
  return LEVEL_ORDER.find((level) => widthRatio <= CENTER_LIMIT[level]) ?? null;
}

/**
 * Nivel al que conviene subir: el más bajo que deja margen, no el que aguanta justo.
 * Subir al mínimo viable dejaría la pieza permanentemente en aviso, que es una
 * corrección automática que no corrige nada.
 */
export function comfortableLevelForCenter(widthRatio: number): ErrorLevel | null {
  return (
    LEVEL_ORDER.find((level) => widthRatio <= CENTER_LIMIT[level] * COMFORT) ??
    minimumLevelForLogo(widthRatio)
  );
}

export function validate(
  design: QrDesign,
  matrixSize: number,
  /** Ocupación real del centro. Sin ella se deduce del logo, que es lo medible sin DOM. */
  occupancy?: CenterOccupancy | null,
): ValidationResult {
  const findings: Finding[] = [];
  const notes: string[] = [];
  const center = occupancy === undefined ? fallbackOccupancy(design, matrixSize) : occupancy;

  const effectiveBg = design.bgTransparent ? '#ffffff' : design.bgColor;
  if (design.bgTransparent) {
    notes.push(
      'Fondo transparente: se valida contra papel blanco, que es el caso de impresión. Sobre una superficie oscura el código no leerá.',
    );
  }

  const contrast = contrastRatio(design.moduleColor, effectiveBg);
  const moduleIsLighter =
    contrastRatio(design.moduleColor, '#000000') > contrastRatio(effectiveBg, '#000000');

  if (moduleIsLighter) {
    findings.push({
      id: 'polarity',
      severity: 'broken',
      message:
        'Los módulos son más claros que el fondo. La mayoría de lectores no invierten la polaridad y no verán nada. Intercambia los dos colores.',
      fix: {
        label: 'Intercambiar colores',
        patch: { moduleColor: effectiveBg, bgColor: design.moduleColor, bgTransparent: false },
      },
    });
  } else if (contrast < CONTRAST_BROKEN) {
    findings.push({
      id: 'contrast-broken',
      severity: 'broken',
      message: `Contraste ${formatRatio(contrast)} entre módulo y fondo. Por debajo de ${CONTRAST_BROKEN}:1 el código no se lee. Oscurece el módulo o aclara el fondo.`,
      fix: {
        label: 'Oscurecer módulo',
        patch: {
          moduleColor: pushToContrast(design.moduleColor, effectiveBg, CONTRAST_TARGET, 'darker'),
        },
      },
    });
  } else if (contrast < CONTRAST_SAFE) {
    findings.push({
      id: 'contrast-tight',
      severity: 'warning',
      message: `Contraste ${formatRatio(contrast)}. Lee en pantalla, pero impreso o con cámaras malas fallará. Busca al menos ${CONTRAST_SAFE}:1.`,
      fix: {
        label: 'Oscurecer módulo',
        patch: {
          moduleColor: pushToContrast(design.moduleColor, effectiveBg, CONTRAST_TARGET, 'darker'),
        },
      },
    });
  }

  const ratio = center?.widthRatio ?? 0;
  const limit = CENTER_LIMIT[design.errorLevel];
  if (center) {
    const noun = center.kind === 'text' ? 'El texto del centro' : 'El logo';
    const shrink: Finding['fix'] =
      center.kind === 'text'
        ? {
            label: 'Ajustar el texto al máximo que cabe',
            patch: {
              centerTextSize: center.fittedSize ?? design.centerTextSize * 0.75,
            },
          }
        : { label: 'Reducir logo al 28%', patch: { logoScale: 0.28 } };

    if (ratio > limit) {
      const better = minimumLevelForLogo(ratio);
      findings.push({
        id: 'center-too-big',
        severity: 'broken',
        message: `${noun} tapa el equivalente al ${Math.round(ratio * 100)}% del ancho y la corrección ${design.errorLevel} solo recupera hasta el ${Math.round(limit * 100)}%. ${
          better
            ? `Sube la corrección a ${better} o hazlo más pequeño.`
            : `Hazlo más pequeño: ni el nivel H lo tolera.`
        }`,
        fix: better
          ? { label: `Subir corrección a ${better}`, patch: { errorLevel: better } }
          : shrink,
      });
    } else if (ratio > limit * COMFORT) {
      findings.push({
        id: 'center-tight',
        severity: 'warning',
        message: `${noun} está al borde de lo que la corrección ${design.errorLevel} tolera (${Math.round(ratio * 100)}% de ${Math.round(limit * 100)}%). Un poco de suciedad o un ángulo malo y deja de leer.`,
        fix:
          design.errorLevel !== 'H'
            ? {
                label: 'Subir un nivel de corrección',
                patch: {
                  errorLevel: LEVEL_ORDER[
                    LEVEL_ORDER.indexOf(design.errorLevel) + 1
                  ] as ErrorLevel,
                },
              }
            : shrink,
      });
    }

    // El texto central se lee sobre su placa, que es del color del fondo. Si se
    // funde con ella, la pieza escanea perfectamente y aun así está rota a la vista.
    if (center.kind === 'text') {
      const plate = design.bgTransparent ? '#ffffff' : design.bgColor;
      const legibility = contrastRatio(design.centerTextColor, plate);
      if (legibility < 3) {
        findings.push({
          id: 'center-text-illegible',
          severity: 'warning',
          message: `El texto del centro está a ${formatRatio(legibility)} de su placa: se lee mal aunque el código escanee. Oscurécelo o cambia el color del fondo.`,
          fix: {
            label: 'Oscurecer el texto',
            patch: {
              centerTextColor: pushToContrast(
                design.centerTextColor,
                plate,
                CONTRAST_TARGET,
                'darker',
              ),
            },
          },
        });
      }
    }

    if (!design.logoPunchout) {
      findings.push({
        id: 'center-no-punchout',
        severity: 'warning',
        message: `${noun} se dibuja encima de los módulos sin recortarlos. Los lectores lo toleran, pero se ve sucio impreso. Activa "Recortar módulos".`,
        fix: { label: 'Recortar módulos', patch: { logoPunchout: true } },
      });
    }
  }

  if (design.quietZone < 2) {
    findings.push({
      id: 'quiet-zone-broken',
      severity: 'broken',
      message: `Zona de silencio de ${design.quietZone} módulos. Sin margen el lector no encuentra dónde empieza el código. La norma pide 4.`,
      fix: { label: 'Poner 4 módulos', patch: { quietZone: 4 } },
    });
  } else if (design.quietZone < 4) {
    findings.push({
      id: 'quiet-zone-tight',
      severity: 'warning',
      message: `Zona de silencio de ${design.quietZone} módulos; la norma pide 4. Sobre un fondo con textura o color, fallará.`,
      fix: { label: 'Poner 4 módulos', patch: { quietZone: 4 } },
    });
  }

  // Los módulos muy pequeños dejan de tocarse y confunden al lector, sobre todo impresos.
  if (design.moduleShape !== 'connected' && design.moduleScale < 0.7) {
    findings.push({
      id: 'module-scale',
      severity: 'warning',
      message: `Los módulos están al ${Math.round(design.moduleScale * 100)}% de su celda. Por debajo del 70% los lectores baratos pierden el patrón. Súbelos o cambia a forma continua.`,
      fix: { label: 'Subir al 85%', patch: { moduleScale: 0.85 } },
    });
  }

  const severity: Severity = findings.some((finding) => finding.severity === 'broken')
    ? 'broken'
    : findings.length > 0
      ? 'warning'
      : 'ok';

  return {
    severity,
    findings,
    notes,
    contrast,
    effectiveBg,
    logoWidthRatio: ratio,
    logoLimit: limit,
  };
}
