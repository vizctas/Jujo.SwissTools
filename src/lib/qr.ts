import QRCode from 'qrcode';
import type { ErrorLevel, Matrix } from './types.ts';

export interface EncodeResult {
  matrix: Matrix;
  version: number;
  /** Capacidad usada, 0–1. Alimenta el indicador de capacidad del panel. */
  utilization: number;
}

export class EncodeError extends Error {
  readonly kind: 'empty' | 'too-long';
  constructor(kind: 'empty' | 'too-long', message: string) {
    super(message);
    this.name = 'EncodeError';
    this.kind = kind;
  }
}

/**
 * Capacidad en caracteres en modo byte por versión y nivel de corrección.
 * Solo se usa para el indicador de "capacidad restante"; la verdad sobre si algo
 * cabe la da el propio codificador, que lanza cuando no cabe.
 */
const BYTE_CAPACITY: Record<ErrorLevel, readonly number[]> = {
  L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858, 929, 1003, 1091, 1171, 1273, 1367, 1465, 1528, 1628, 1732, 1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953],
  M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666, 711, 779, 857, 911, 997, 1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331],
  Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151, 177, 203, 241, 258, 292, 322, 364, 394, 442, 482, 509, 565, 611, 661, 715, 751, 805, 868, 908, 982, 1030, 1112, 1168, 1228, 1283, 1351, 1423, 1499, 1579, 1663],
  H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119, 137, 155, 177, 194, 220, 250, 280, 310, 338, 382, 403, 439, 461, 511, 535, 593, 625, 658, 698, 742, 790, 842, 898, 958, 983, 1051, 1093, 1139, 1219, 1273],
};

export function capacityFor(level: ErrorLevel, version: number): number {
  return BYTE_CAPACITY[level][version - 1] ?? 0;
}

/** Capacidad máxima del formato para un nivel dado (versión 40). */
export function maxCapacity(level: ErrorLevel): number {
  return capacityFor(level, 40);
}

export function encode(data: string, level: ErrorLevel): EncodeResult {
  if (data.length === 0) {
    throw new EncodeError('empty', 'No hay contenido que codificar.');
  }

  let created;
  try {
    created = QRCode.create(data, { errorCorrectionLevel: level });
  } catch {
    throw new EncodeError(
      'too-long',
      `El contenido no cabe en un QR con corrección ${level}. Acorta el texto o baja el nivel de corrección.`,
    );
  }

  const modules = created.modules;
  const byteLength = new TextEncoder().encode(data).length;
  const capacity = capacityFor(level, created.version);

  return {
    version: created.version,
    utilization: capacity > 0 ? Math.min(1, byteLength / capacity) : 1,
    matrix: {
      size: modules.size,
      get: (row, col) => modules.data[row * modules.size + col] === 1,
    },
  };
}

/** Las tres posiciones de patrón de búsqueda, en [fila, columna] de su esquina. */
export function finderOrigins(size: number): ReadonlyArray<readonly [number, number]> {
  return [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ];
}
