/*
 * El plano de corte, como matemática pura.
 *
 * Un plano es una normal y una distancia. Todo lo demás —dónde va el rectángulo
 * del recorte, hacia dónde es «arriba» sobre él, qué significa un trazo en
 * pantalla— se expresa en el marco (u, v) del propio plano. Ese marco lo calcula
 * una sola función y lo usan el worker, el gizmo y el store: si cada uno lo
 * derivara a su manera, el recorte que se ve y el que se corta acabarían siendo
 * dos recortes distintos.
 *
 * Sin three, sin Manifold, sin DOM: se importa desde el worker, el visor y Node.
 */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export function unit(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > 0 ? [a[0] / length, a[1] / length, a[2] / length] : [0, 0, 1];
}

/**
 * La misma normal con su componente dominante positiva. Un plano no distingue
 * entre n y −n, pero «Lado» sí: sin esto, dos trazos casi iguales podrían dejar
 * el lado que se separa cambiado de sentido.
 */
export function orient(normal: Vec3): Vec3 {
  const abs = normal.map(Math.abs);
  const dominant = abs.indexOf(Math.max(...abs));
  return normal[dominant]! < 0 ? ([-normal[0] + 0, -normal[1] + 0, -normal[2] + 0] as Vec3) : normal;
}

export interface Basis {
  u: Vec3;
  v: Vec3;
  n: Vec3;
}

/**
 * Marco del plano. `v` es el Z del mundo proyectado sobre el plano, para que
 * «alto» sea arriba en cualquier inclinación; si la normal ya es Z, arriba no
 * significa nada y se toma Y, que es lo que había. `u = v × n` cierra un marco
 * dextrógiro: `u × v = n`.
 */
export function planeBasis(normal: Vec3): Basis {
  const n = unit(normal);
  const zOnPlane: Vec3 = [-n[0] * n[2], -n[1] * n[2], 1 - n[2] * n[2]];
  const v = Math.hypot(...zOnPlane) < 1e-6 ? ([0, 1, 0] as Vec3) : unit(zOnPlane);
  const u = cross(v, n);
  return { u, v, n };
}

/** Rangos `[lo, hi]` de una caja proyectada sobre cada vector del marco. */
export function projectBox(min: Vec3, max: Vec3, basis: Basis): { u: Vec2; v: Vec2; n: Vec2 } {
  const range = (axis: Vec3): Vec2 => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 8; i += 1) {
      const corner: Vec3 = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
      const d = dot(corner, axis);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    return [lo, hi];
  };
  return { u: range(basis.u), v: range(basis.v), n: range(basis.n) };
}
