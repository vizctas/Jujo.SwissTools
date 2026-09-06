/*
 * Detección de partes que se desprenden: brazos, cabezas, ojos, emblemas.
 *
 * La señal es siempre la misma y es geométrica, no semántica: barriendo el
 * sólido a lo largo de un eje, la sección se estrecha de golpe y lo que queda
 * más allá es poco. Eso es un cuello —un hombro, una muñeca, el borde de un ojo
 * pegado a la cara— y es justo donde conviene cortar.
 *
 * No se corta nada aquí: se proponen sitios, con su ventana ya medida, y quien
 * decide es quien mira la pieza. Una detección automática que además cortara
 * sola sería imposible de revisar.
 *
 * Sin DOM ni worker: se importa desde el worker y desde el self-check de Node.
 */

import { frame } from './joints.ts';
import type { Appendage, CutWindow } from './protocol.ts';

type Wasm = Awaited<ReturnType<typeof import('manifold-3d').default>>;
type M = InstanceType<Wasm['Manifold']>;

/** Rebanadas por eje. 48 bastan para encontrar un hombro en una figura de 200 mm. */
const SAMPLES = 48;
/** Lo que se desprende no puede ser un tercio del cuerpo: eso ya es partir por la mitad. */
const MAX_SHARE = 0.35;
/** Ni una miga: por debajo de esto es ruido de malla, no una pieza. */
const MIN_SHARE = 0.004;
/** El cuello tiene que ser al menos la mitad de estrecho que lo que hay dentro. */
const STEP_RATIO = 2;
/** Y no más ancho que esto respecto a la sección mayor del modelo. */
const NECK_SHARE = 0.3;
const MAX_RESULTS = 6;

interface Candidate extends Appendage {
  /** Cuánto se estrecha: cuanto más alto, más claro es el cuello. */
  ratio: number;
  /** Caja de lo que se desprendería, para descartar duplicados entre ejes. */
  box: { min: [number, number, number]; max: [number, number, number] };
}

/** Integral por trapecios: el volumen aproximado bajo el perfil de áreas. */
function integrate(areas: number[], step: number): number {
  let sum = 0;
  for (let i = 1; i < areas.length; i += 1) sum += ((areas[i - 1]! + areas[i]!) / 2) * step;
  return sum;
}

function overlaps(a: Candidate['box'], b: Candidate['box']): boolean {
  for (let i = 0; i < 3; i += 1) {
    const lo = Math.max(a.min[i]!, b.min[i]!);
    const hi = Math.min(a.max[i]!, b.max[i]!);
    if (hi - lo <= 0) return false;
  }
  return true;
}

/**
 * Busca cuellos en los tres ejes y devuelve, por cada uno, dónde cortar y con
 * qué ventana. Ordenados por lo claro que es el cuello.
 */
export function findAppendages(wasm: Wasm, solid: M): Appendage[] {
  const worldBox = solid.boundingBox();
  const candidates: Candidate[] = [];

  for (let axis = 0; axis < 3; axis += 1) {
    const normal: [number, number, number] = [0, 0, 0];
    normal[axis] = 1;
    const { forward, back } = frame(normal);
    const aligned = forward(solid);
    try {
      const min = worldBox.min[axis]!;
      const span = worldBox.max[axis]! - min;
      if (span < 2) continue;
      const step = span / SAMPLES;

      // Perfil de áreas a lo largo del eje. Los extremos se muestrean un pelo
      // por dentro: justo en la cara, la rebanada es degenerada.
      const areas: number[] = [];
      for (let i = 0; i <= SAMPLES; i += 1) {
        const h = Math.min(Math.max(min + step * i, min + step * 0.05), min + span - step * 0.05);
        const section = aligned.slice(h);
        areas.push(section.area());
        section.delete();
      }
      const total = integrate(areas, step);
      const widest = Math.max(...areas);
      if (total <= 0 || widest <= 0) continue;

      for (let i = 2; i < SAMPLES - 1; i += 1) {
        const neck = areas[i]!;
        if (neck <= 0 || neck > widest * NECK_SHARE) continue;
        for (const side of [1, -1] as const) {
          // Lo que quedaría suelto, por el perfil: barato y suficiente para decidir.
          const beyond = side > 0 ? integrate(areas.slice(i), step) : integrate(areas.slice(0, i + 1), step);
          const share = beyond / total;
          if (share > MAX_SHARE || share < MIN_SHARE) continue;
          // Dos muestras hacia dentro: ahí es donde el cuerpo tiene que ensancharse.
          const inner = areas[i - side * 2];
          if (inner === undefined || inner < neck * STEP_RATIO) continue;

          // El muestreo deja el cuello en algún punto entre la muestra ancha y la
          // estrecha; se afina por bisección para cortar en el hombro y no dos
          // milímetros más allá, que en una figura pequeña se nota.
          // Un pelo dentro del apéndice: cortar justo sobre la cara del hombro es
          // el caso ambiguo de una booleana y deja rebabas del cuerpo pegadas.
          const offset = narrow(aligned, min + step * (i - side), min + step * i, neck) + side * Math.max(0.05, step * 0.1);
          const found = describe(wasm, aligned, back, offset, side * step * 0.4, side);
          if (!found) continue;
          // La sonda solo mide el cuello; se estira hasta la punta para poder
          // reconocer el mismo brazo cuando aparece también en otro eje.
          const box = { min: [...found.box.min] as [number, number, number], max: [...found.box.max] as [number, number, number] };
          if (side > 0) {
            box.min[axis] = offset;
            box.max[axis] = worldBox.max[axis]!;
          } else {
            box.min[axis] = worldBox.min[axis]!;
            box.max[axis] = offset;
          }
          candidates.push({
            axis: axis as 0 | 1 | 2,
            offset,
            side,
            window: found.window,
            volume: beyond,
            area: neck,
            ratio: inner / neck,
            box,
          });
        }
      }
    } finally {
      aligned.delete();
    }
  }

  // Un mismo brazo asoma en varios ejes: se queda el cuello más claro de cada zona.
  candidates.sort((a, b) => b.ratio - a.ratio);
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    if (kept.some((other) => overlaps(candidate.box, other.box))) continue;
    kept.push(candidate);
    if (kept.length >= MAX_RESULTS) break;
  }
  return kept.map(({ axis, offset, side, window, volume, area }) => ({ axis, offset, side, window, volume, area }));
}

/** Dónde deja de ser ancho: el primer punto ya estrecho entre las dos muestras. */
function narrow(aligned: M, wideAt: number, narrowAt: number, neck: number): number {
  let wide = wideAt;
  let thin = narrowAt;
  for (let i = 0; i < 10; i += 1) {
    const mid = (wide + thin) / 2;
    const section = aligned.slice(mid);
    const area = section.area();
    section.delete();
    if (area > neck * 1.5) wide = mid;
    else thin = mid;
  }
  return thin;
}

/**
 * La ventana de un candidato: la caja de la sección justo pasado el cuello, con
 * margen, en el marco (u, v) del plano. Es el mismo marco en que `windowColumn`
 * la va a extruir, así que no hay nada que convertir. La caja del mundo se saca
 * de una sonda girada de vuelta, solo para descartar duplicados entre ejes.
 */
function describe(
  wasm: Wasm,
  aligned: M,
  back: (m: M) => M,
  offset: number,
  delta: number,
  side: 1 | -1,
): { window: CutWindow; box: Candidate['box'] } | null {
  const section = aligned.slice(offset + delta);
  try {
    if (section.isEmpty()) return null;
    const flat = section.bounds();
    const width = flat.max[0] - flat.min[0];
    const height = flat.max[1] - flat.min[1];
    if (width <= 0 || height <= 0) return null;
    // Un pelo de margen: la ventana debe envolver la sección, no rozarla.
    const margin = Math.max(0.5, Math.max(width, height) * 0.15);
    const center: [number, number] = [(flat.min[0] + flat.max[0]) / 2, (flat.min[1] + flat.max[1]) / 2];
    const probe = wasm.Manifold.cube([width + margin * 2, height + margin * 2, 1], true).translate([center[0], center[1], offset]);
    const world = back(probe);
    const box = world.boundingBox();
    probe.delete();
    world.delete();
    return {
      window: { center, size: [width + margin * 2, height + margin * 2], side },
      box: { min: [...box.min] as [number, number, number], max: [...box.max] as [number, number, number] },
    };
  } finally {
    section.delete();
  }
}
