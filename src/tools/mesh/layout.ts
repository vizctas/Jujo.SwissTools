/*
 * Gravedad de la mesa. Cajas y números, sin three ni DOM: así se comprueba en
 * Node en vez de mirando píxeles.
 *
 * La regla es una sola y vive aquí: nada baja de la cama, y lo que se suelta en
 * el aire se posa en lo primero que lo sostenga.
 */

export type Vec3 = [number, number, number];

export interface Box {
  min: Vec3;
  max: Vec3;
}

/** Desplaza una caja. */
export function shift(box: Box, by: Vec3): Box {
  return {
    min: [box.min[0] + by[0], box.min[1] + by[1], box.min[2] + by[2]],
    max: [box.max[0] + by[0], box.max[1] + by[1], box.max[2] + by[2]],
  };
}

/** ¿Se pisan en planta? Tocarse por el borde no cuenta como apoyo. */
export function overlapsXY(a: Box, b: Box): boolean {
  return !(b.max[0] <= a.min[0] || b.min[0] >= a.max[0] || b.max[1] <= a.min[1] || b.min[1] >= a.max[1]);
}

/**
 * Altura a la que se posa `box`: la cama, o la cara superior de lo más alto que
 * tenga debajo y la pise en planta.
 *
 * ponytail: el apoyo se mide por caja. Una pieza en forma de U no sostiene por
 * su hueco; para posar trozos de un corte sobre la mesa, que es el caso, la caja
 * es exacta.
 */
export function restingZ(box: Box, others: Box[], bedZ: number, tolerance = 1e-3): number {
  let rest = bedZ;
  for (const other of others) {
    if (!overlapsXY(box, other)) continue;
    // Solo sostiene lo que ya está por debajo; lo que se cruza a media altura, no.
    if (other.max[2] > box.min[2] + tolerance) continue;
    if (other.max[2] > rest) rest = other.max[2];
  }
  return rest;
}

/** Desplazamiento vertical mínimo para que una caja no atraviese la cama. */
export function bedClamp(minZ: number, offsetZ: number, bedZ: number): number {
  return Math.max(offsetZ, bedZ - minZ);
}
