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

import type { JointReport, JointShape, JointSpec } from './protocol.ts';

type Wasm = Awaited<ReturnType<typeof import('manifold-3d').default>>;
type M = InstanceType<Wasm['Manifold']>;
type CS = InstanceType<Wasm['CrossSection']>;
type Vec3 = [number, number, number];

const SEGMENTS = 48;
const MIN_DIAMETER = 2;
const MAX_DIAMETER = 12;
const MAX_PINS = 4;

/* ------------------------------------------------------------------ Marco */

/** Rotaciones que llevan la normal a +Z y de vuelta. */
export function frame(normal: Vec3): { forward: (m: M) => M; back: (m: M) => M } {
  const [x, y, z] = normal;
  const pitch = (Math.atan2(Math.hypot(x, y), z) * 180) / Math.PI;
  const yaw = (Math.atan2(y, x) * 180) / Math.PI;
  const chain = (m: M, steps: Vec3[]): M => {
    let current = m;
    for (const step of steps) {
      const next = current.rotate(step);
      if (current !== m) current.delete();
      current = next;
    }
    return current;
  };
  return {
    forward: (m) => chain(m, [[0, 0, -yaw], [0, -pitch, 0]]),
    back: (m) => chain(m, [[0, pitch, 0], [0, 0, yaw]]),
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

/** ¿Está el punto dentro de la sección? Un cuadradito y una intersección. */
function inside(wasm: Wasm, section: CS, point: [number, number]): boolean {
  const probe = wasm.CrossSection.square([0.01, 0.01], true).translate(point);
  const hit = probe.intersect(section);
  const yes = !hit.isEmpty();
  probe.delete();
  hit.delete();
  return yes;
}

/** El punto interior más cercano al candidato, buscando en una rejilla. */
function nearestInside(wasm: Wasm, section: CS, candidate: [number, number]): [number, number] | null {
  if (inside(wasm, section, candidate)) return candidate;
  const box = section.bounds();
  let best: [number, number] | null = null;
  let bestDistance = Infinity;
  const steps = 9;
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      const p: [number, number] = [
        box.min[0] + ((box.max[0] - box.min[0]) * i) / steps,
        box.min[1] + ((box.max[1] - box.min[1]) * j) / steps,
      ];
      const d = Math.hypot(p[0] - candidate[0], p[1] - candidate[1]);
      if (d < bestDistance && inside(wasm, section, p)) {
        best = p;
        bestDistance = d;
      }
    }
  }
  return best;
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
  wasm: Wasm,
  aligned: M,
  height: number,
  spec: JointSpec,
  thickness: { above: number; below: number },
): { plan: JointPlan | null; report: JointReport } {
  const report = (plan: JointPlan | null, skipped: string | null): { plan: JointPlan | null; report: JointReport } => ({
    plan,
    report: {
      mode: spec.mode,
      shape: spec.shape,
      diameter: plan?.diameter ?? 0,
      depth: plan?.depth ?? 0,
      count: plan?.spots.length ?? 0,
      skipped,
    },
  });

  const section = aligned.slice(height);
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
    const regions = usable.decompose().sort((a, b) => b.area() - a.area());
    usable.delete();

    const wanted = spec.count > 0 ? spec.count : MAX_PINS;
    const spots: [number, number][] = [];
    for (const region of regions) {
      if (spots.length >= wanted) break;
      const box = region.bounds();
      const w = box.max[0] - box.min[0];
      const h = box.max[1] - box.min[1];
      const cx = (box.min[0] + box.max[0]) / 2;
      const cy = (box.min[1] + box.max[1]) / 2;
      const long = Math.max(w, h);
      const candidates: [number, number][] =
        long >= 8 * radius && spots.length + 2 <= wanted
          ? w >= h
            ? [[box.min[0] + w * 0.25, cy], [box.min[0] + w * 0.75, cy]]
            : [[cx, box.min[1] + h * 0.25], [cx, box.min[1] + h * 0.75]]
          : [[cx, cy]];
      for (const candidate of candidates) {
        const spot = nearestInside(wasm, region, candidate);
        if (spot && !spots.some((s) => Math.hypot(s[0] - spot[0], s[1] - spot[1]) < diameter * 2)) spots.push(spot);
      }
      // En modo automático una región grande recibe sus espigas y las pequeñas nada:
      // repartir cuatro espigas por cuatro islas diminutas no une nada.
      if (spec.count === 0 && spots.length >= 2) break;
    }
    for (const region of regions) region.delete();
    if (spots.length === 0) return report(null, 'no hay sitio para una espiga con pared suficiente');

    return report({ mode: spec.mode, shape: spec.shape, diameter, depth, spots }, null);
  } finally {
    section.delete();
  }
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
