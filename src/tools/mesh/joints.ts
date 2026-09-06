/*
 * Uniones entre mitades: dónde van las espigas, de qué tamaño y de qué forma.
 *
 * Todo se decide sobre la sección real del corte —el polígono que el plano
 * atraviesa—, no sobre la caja de la pieza. Es la diferencia entre una espiga
 * de 6 mm en una barra de 30 y una de 12 en una figura de 60 que solo tiene
 * 12 mm de material donde se corta.
 *
 * Se trabaja en un marco alineado (la normal del corte es +Z) y se rota de
 * vuelta al final: así las formas son cilindros y cubos sin orientar a mano.
 *
 * Sin DOM ni worker: se importa desde el worker y desde el self-check de Node.
 */

import type { Mat4 } from 'manifold-3d';
import { planeBasis, type Vec3 } from './plane.ts';
import type { JointReport, JointShape, JointSpec } from './protocol.ts';

type Wasm = Awaited<ReturnType<typeof import('manifold-3d').default>>;
type M = InstanceType<Wasm['Manifold']>;
type CS = InstanceType<Wasm['CrossSection']>;

const SEGMENTS = 48;
const MIN_DIAMETER = 2;
const MAX_DIAMETER = 12;
const MAX_PINS = 4;

/* ------------------------------------------------------------------ Marco */

/**
 * Transformaciones que llevan la normal a +Z y de vuelta.
 *
 * Es la misma base que `planeBasis`, no unos Euler equivalentes: u va a X y v a
 * Y, así que la columna de recorte que se construye aquí en (x, y) y el
 * rectángulo que el gizmo dibuja en (u, v) son, por construcción, el mismo.
 */
export function frame(normal: Vec3): { forward: (m: M) => M; back: (m: M) => M } {
  const { u, v, n } = planeBasis(normal);
  // Matrices 4×4 por columnas (la última fila se ignora). `forward` tiene u, v, n
  // por filas; `back` los tiene por columnas.
  const forward: Mat4 = [u[0], v[0], n[0], 0, u[1], v[1], n[1], 0, u[2], v[2], n[2], 0, 0, 0, 0, 1];
  const back: Mat4 = [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, 0, 0, 0, 1];
  return {
    forward: (m) => m.transform(forward),
    back: (m) => m.transform(back),
  };
}

/* ------------------------------------------------------------------- Plan */

export interface JointPlan {
  mode: JointSpec['mode'];
  shape: JointShape;
  diameter: number;
  depth: number;
  /** Centros de las espigas sobre el plano, en el marco alineado. */
  spots: [number, number][];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Los contornos de una sección, tal como los da Manifold: exteriores y huecos.
 * Trabajar sobre ellos en JS evita una booleana de WASM por cada candidato, que
 * es lo que hacía falta para poder tantear cientos de posiciones.
 */
type Ring = ReadonlyArray<readonly [number, number]>;

/** Par-impar sobre todos los contornos: los huecos salen fuera sin mirar el giro. */
function pointInside(rings: Ring[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Distancia al borde más cercano: cuánto material rodea a un punto. */
function edgeDistance(rings: Ring[], x: number, y: number): number {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      const dx = xj - xi;
      const dy = yj - yi;
      const len2 = dx * dx + dy * dy || 1;
      const t = clamp(((x - xi) * dx + (y - yi) * dy) / len2, 0, 1);
      const d = Math.hypot(x - (xi + t * dx), y - (yi + t * dy));
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Reparte hasta `wanted` conectores dentro de la zona útil —la sección ya
 * encogida por radio y pared—, separados al menos `minGap` entre centros.
 *
 * Uno solo va al punto más hondo, que es el que más material tiene alrededor.
 * Varios se reparten por muestreo del más lejano: el primero lo más lejos
 * posible del centro, el segundo lo más lejos del primero, y así. En un
 * rectángulo eso da los extremos o las cuatro esquinas, que es justo lo que
 * impide que las mitades giren una sobre otra.
 *
 * Si no cabe otro sin invadir la separación mínima, se para: salen los que
 * encajan, no los que se pidieron.
 */
function placeSpots(usable: CS, wanted: number, minGap: number): [number, number][] {
  const rings = usable.toPolygons() as unknown as Ring[];
  if (rings.length === 0) return [];
  const box = usable.bounds();
  const width = box.max[0] - box.min[0];
  const height = box.max[1] - box.min[1];

  const steps = 24;
  const candidates: { p: [number, number]; depth: number }[] = [];
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      const x = box.min[0] + (width * i) / steps;
      const y = box.min[1] + (height * j) / steps;
      if (!pointInside(rings, x, y)) continue;
      candidates.push({ p: [x, y], depth: edgeDistance(rings, x, y) });
    }
  }
  // Una zona útil muy fina se le escapa a la rejilla; sus vértices no.
  if (candidates.length === 0) {
    for (const ring of rings) {
      for (const [x, y] of ring) candidates.push({ p: [x, y], depth: 0 });
    }
  }
  if (candidates.length === 0) return [];

  const chosen: [number, number][] = [];
  if (wanted <= 1) {
    chosen.push(candidates.reduce((a, b) => (b.depth > a.depth ? b : a)).p);
    return chosen;
  }

  // Semilla: lo más lejos del centro. Con el centro como semilla, dos conectores
  // saldrían uno al medio y otro a un lado en vez de repartidos y simétricos.
  const cx = (box.min[0] + box.max[0]) / 2;
  const cy = (box.min[1] + box.max[1]) / 2;
  const score = (c: { p: [number, number]; depth: number }, from: [number, number][]): number => {
    const gap = from.length === 0 ? Math.hypot(c.p[0] - cx, c.p[1] - cy) : Math.min(...from.map((s) => Math.hypot(s[0] - c.p[0], s[1] - c.p[1])));
    return gap + c.depth * 0.5;
  };
  chosen.push(candidates.reduce((a, b) => (score(b, []) > score(a, []) ? b : a)).p);

  while (chosen.length < wanted) {
    let best: [number, number] | null = null;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const gap = Math.min(...chosen.map((s) => Math.hypot(s[0] - candidate.p[0], s[1] - candidate.p[1])));
      if (gap < minGap) continue;
      const value = gap + candidate.depth * 0.5;
      if (value > bestScore) {
        bestScore = value;
        best = candidate.p;
      }
    }
    if (!best) break;
    chosen.push(best);
  }
  return chosen;
}

/** Radio del mayor círculo que cabe en la sección, por bisección sobre offset(). */
function inscribedRadius(section: CS): number {
  const box = section.bounds();
  let lo = 0;
  let hi = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]) / 2;
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    const shrunk = section.offset(-mid, 'Round');
    const fits = !shrunk.isEmpty();
    shrunk.delete();
    if (fits) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Decide la unión para un corte a la altura `height` del sólido alineado.
 * `thickness` es cuánto material hay a cada lado del plano, a lo largo de la normal.
 */
export function planJoint(
  aligned: M,
  height: number,
  spec: JointSpec,
  thickness: { above: number; below: number },
  /** Con recorte, la cara de unión es solo la parte de la sección que se corta. */
  limit: CS | null = null,
): { plan: JointPlan | null; report: JointReport } {
  const requested = spec.count > 0 ? spec.count : 0;
  const report = (plan: JointPlan | null, skipped: string | null): { plan: JointPlan | null; report: JointReport } => ({
    plan,
    report: {
      mode: spec.mode,
      shape: spec.shape,
      diameter: plan?.diameter ?? 0,
      depth: plan?.depth ?? 0,
      count: plan?.spots.length ?? 0,
      requested,
      skipped,
    },
  });

  const full = aligned.slice(height);
  const section = limit ? full.intersect(limit) : full;
  try {
    if (section.isEmpty()) return report(null, 'el plano no atraviesa material');

    const rMax = inscribedRadius(section);
    // La pared que queda entre el taladro y el exterior: nunca menos de 1 mm.
    const wall = (radius: number): number => Math.max(1, radius * 0.6);

    let diameter = spec.auto ? clamp(0.4 * rMax, MIN_DIAMETER, MAX_DIAMETER) : spec.diameter;
    // Una espiga manual que no cabe se encoge hasta que quepa: mejor que perforar la pared.
    while (diameter / 2 + wall(diameter / 2) > rMax && diameter > MIN_DIAMETER) diameter -= 0.5;
    if (diameter / 2 + wall(diameter / 2) > rMax) return report(null, 'la sección es demasiado estrecha para una espiga');

    const maxDepth = 0.45 * Math.min(thickness.above, thickness.below);
    const depth = Math.min(spec.auto ? clamp(1.6 * diameter, 3, 25) : spec.depth, maxDepth);
    if (depth < 1.5) return report(null, 'una de las mitades es demasiado fina para taladrarla');

    const radius = diameter / 2;
    const usable = section.offset(-(radius + wall(radius)), 'Round');
    try {
      if (usable.isEmpty()) return report(null, 'no hay sitio con pared suficiente');
      // En automático: uno por cada trozo suelto de la sección —si son dos, las
      // mitades tienen que quedar unidas por los dos— y más según lo que dé el área.
      const lobes = usable.decompose();
      const lobeCount = lobes.length;
      for (const lobe of lobes) lobe.delete();
      const byArea = Math.round(Math.sqrt(Math.max(0, usable.area())) / (3 * diameter));
      const wanted = spec.count > 0 ? spec.count : clamp(Math.max(lobeCount, byArea), 1, MAX_PINS);
      const spots = placeSpots(usable, wanted, diameter * 2);
      if (spots.length === 0) return report(null, 'no hay sitio para un conector con pared suficiente');
      return report({ mode: spec.mode, shape: spec.shape, diameter, depth, spots }, null);
    } finally {
      usable.delete();
    }
  } finally {
    if (section !== full) section.delete();
    full.delete();
  }
}

/**
 * Columna de recorte: la caja que, cruzada con la pieza, deja solo lo que el
 * corte debe separar. Nace en el plano y se va hacia +normal más allá de la
 * pieza, así que lo que quede al otro lado no se toca.
 *
 * En coordenadas del mundo, con la normal sobre un eje. Quien la use la gira al
 * marco alineado con el mismo `frame` que la pieza, para no derivar a mano a qué
 * eje va a parar cada lado.
 */
export function windowColumn(
  wasm: Wasm,
  normal: Vec3,
  offset: number,
  window: { center: [number, number]; size: [number, number]; side: 1 | -1 },
  reach: number,
): M | null {
  const axis = normal.findIndex((n) => Math.abs(n) > 0.999);
  if (axis < 0) return null;
  const others = [0, 1, 2].filter((i) => i !== axis);
  const size: Vec3 = [0, 0, 0];
  const center: Vec3 = [0, 0, 0];
  size[axis] = reach;
  center[axis] = offset + (window.side * reach) / 2;
  size[others[0]!] = Math.max(0.01, window.size[0]);
  size[others[1]!] = Math.max(0.01, window.size[1]);
  center[others[0]!] = window.center[0];
  center[others[1]!] = window.center[1];
  return wasm.Manifold.cube(size, true).translate(center);
}

/* ------------------------------------------------------------------ Formas */

/**
 * Sólido del conector centrado en z = 0, de longitud `length`. `radius` es el
 * radio circunscrito: las secciones poligonales caben en el mismo círculo que la
 * redonda, así el cálculo de pared vale para todas.
 */
function shape(wasm: Wasm, kind: JointShape, radius: number, length: number, plug: boolean): M {
  const { Manifold } = wasm;
  switch (kind) {
    case 'square':
      return Manifold.cube([radius * Math.SQRT2, radius * Math.SQRT2, length], true).rotate([0, 0, 45]);
    case 'hex':
      return Manifold.cylinder(length, radius, radius, 6, true);
    case 'triangle':
      return Manifold.cylinder(length, radius, radius, 3, true);
    case 'cone': {
      const tip = radius * 0.7;
      if (plug) {
        // Un tronco de cono que se estrecha hacia la punta (−z).
        return Manifold.cylinder(length, tip, radius, SEGMENTS, true);
      }
      const lower = Manifold.cylinder(length / 2, tip, radius, SEGMENTS, false).translate([0, 0, -length / 2]);
      const upper = Manifold.cylinder(length / 2, radius, tip, SEGMENTS, false);
      const both = lower.add(upper);
      lower.delete();
      upper.delete();
      return both;
    }
    case 'round':
    default:
      return Manifold.cylinder(length, radius, radius, SEGMENTS, true);
  }
}

/* ------------------------------------------------------------------ Aplicar */

/**
 * Taladra (o talla) las dos mitades según el plan y devuelve las espigas sueltas.
 * Todo en el marco alineado; quien llama rota de vuelta.
 */
export function applyJoint(
  wasm: Wasm,
  above: M,
  below: M,
  height: number,
  plan: JointPlan,
  clearance: number,
): { above: M; below: M; pins: M[] } {
  const radius = plan.diameter / 2;
  const pins: M[] = [];
  let a = above;
  let b = below;
  const swap = (current: M, next: M): M => {
    current.delete();
    return next;
  };

  for (const [x, y] of plan.spots) {
    if (plan.mode === 'plug') {
      // Macho en la mitad de arriba (se funde con ella), hembra en la de abajo.
      const fuse = 0.4;
      const peg = shape(wasm, plan.shape, radius, plan.depth + fuse, true).translate([x, y, height - plan.depth / 2 + fuse / 2]);
      const socket = shape(wasm, plan.shape, radius + clearance, plan.depth + clearance, true).translate([
        x,
        y,
        height - (plan.depth + clearance) / 2,
      ]);
      a = swap(a, a.add(peg));
      b = swap(b, b.subtract(socket));
      peg.delete();
      socket.delete();
      continue;
    }
    const length = plan.depth * 2;
    const drill = shape(wasm, plan.shape, radius + clearance, length, false).translate([x, y, height]);
    a = swap(a, a.subtract(drill));
    b = swap(b, b.subtract(drill));
    drill.delete();
    // El conector: un poco más corto que los dos alojamientos sumados, para que cierre.
    pins.push(shape(wasm, plan.shape, radius, length - clearance * 2, false).translate([x, y, height]));
  }
  return { above: a, below: b, pins };
}
