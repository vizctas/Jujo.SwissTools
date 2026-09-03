/*
 * Self-check de la geometría del taller. `npm run check` lo ejecuta.
 *
 * Lo que se rompe en silencio: la soldadura de vértices (sin ella todo son
 * miles de objetos), la detección de islas, los bucles de borde y el relleno.
 */

import assert from 'node:assert/strict';
import { bedClamp, overlapsXY, restingZ, shift, type Box } from './layout.ts';
import {
  bounds,
  clusterFaceColors,
  combineLabels,
  components,
  extract,
  fillHoles,
  flip,
  signedVolume,
  splitPlan,
  topology,
  weld,
  type TriMesh,
} from './geometry.ts';

/** Cubo unitario con caras hacia fuera, opcionalmente sin la tapa superior. */
function cube(offset: [number, number, number], open = false): TriMesh {
  const [ox, oy, oz] = offset;
  const p = [
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ].map((v, i) => v + [ox, oy, oz][i % 3]!);
  const faces = [
    [0, 2, 1, 0, 3, 2], // z- (mira a -z)
    [4, 5, 6, 4, 6, 7], // z+
    [0, 1, 5, 0, 5, 4], // y-
    [1, 2, 6, 1, 6, 5], // x+
    [3, 7, 6, 3, 6, 2], // y+
    [0, 4, 7, 0, 7, 3], // x-
  ];
  const indices = faces.filter((_, i) => !(open && i === 1)).flat();
  return { positions: new Float32Array(p), indices: new Uint32Array(indices) };
}

/** Desuelda: cada triángulo con sus propios vértices, como un STL real. */
function unweld(mesh: TriMesh): TriMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let t = 0; t < mesh.indices.length; t += 1) {
    const v = mesh.indices[t]!;
    positions.push(mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!);
    indices.push(t);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function merge(a: TriMesh, b: TriMesh): TriMesh {
  const offset = a.positions.length / 3;
  const positions = new Float32Array([...a.positions, ...b.positions]);
  const indices = new Uint32Array([...a.indices, ...[...b.indices].map((i) => i + offset)]);
  return { positions, indices };
}

// ---- cubo cerrado ----
{
  const c = cube([0, 0, 0]);
  const t = topology(c);
  assert.equal(t.watertight, true);
  assert.equal(t.holes.length, 0);
  assert.ok(Math.abs(signedVolume(c) - 1) < 1e-6, `volumen 1, fue ${signedVolume(c)}`);
  assert.ok(signedVolume(flip(c)) < 0, 'invertido debe dar volumen negativo');
  assert.deepEqual(bounds(c.positions).size, [1, 1, 1]);
}

// ---- STL desoldado: sin weld, 12 islas; con weld, 1 ----
{
  const raw = unweld(cube([0, 0, 0]));
  assert.equal(components(raw).count, 12, 'desoldado: cada triángulo es una isla');
  const welded = weld(raw);
  assert.equal(welded.positions.length / 3, 8, 'soldar deja 8 vértices');
  assert.equal(components(welded).count, 1);
  assert.equal(topology(welded).watertight, true);
}

// ---- dos cubos exportados como un solo objeto: detección ----
{
  const two = merge(cube([0, 0, 0]), cube([5, 0, 0]));
  const { labels, count } = components(two);
  assert.equal(count, 2, 'dos islas');
  const first = extract(two, labels, 0);
  assert.equal(first.indices.length, 36);
  assert.equal(first.positions.length / 3, 8, 'extraer compacta los vértices');
  assert.ok(Math.abs(signedVolume(first) - 1) < 1e-6);
}

// ---- cubo sin tapa: un agujero de 4 aristas, y se cierra ----
{
  const open = cube([0, 0, 0], true);
  const t = topology(open);
  assert.equal(t.watertight, false);
  assert.equal(t.boundaryEdges, 4);
  assert.equal(t.holes.length, 1);
  assert.equal(t.holes[0]!.length, 4);
  const { mesh: closed, filled, skipped } = fillHoles(open, t.holes);
  assert.equal(filled, 1);
  assert.equal(skipped, 0);
  assert.equal(topology(closed).watertight, true, 'tras rellenar, estanco');
  assert.ok(Math.abs(signedVolume(closed) - 1) < 1e-6, 'la tapa queda bien orientada');
}

// ---- color: cuantización determinista y combinación con islas ----
{
  const faceColors = new Float32Array([1, 0, 0, 0.98, 0.02, 0, 0, 0, 1, 0, 0.01, 0.99]);
  const { labels, palette } = clusterFaceColors(faceColors);
  assert.equal(palette.length, 2, 'dos rojos y dos azules -> dos grupos');
  assert.equal(labels[0], labels[1]);
  assert.equal(labels[2], labels[3]);
  const islands = new Int32Array([0, 0, 0, 0]);
  assert.equal(combineLabels(islands, labels).count, 2);
  const both = combineLabels(new Int32Array([0, 1, 0, 1]), labels);
  assert.equal(both.count, 4, 'isla x color');
}

// ---- plan de corte ----
{
  assert.deepEqual(splitPlan([300, 100, 100], [256, 256, 256]), [1, 0, 0]);
  assert.deepEqual(splitPlan([600, 100, 100], [256, 256, 256]), [2, 0, 0]);
  assert.deepEqual(splitPlan([100, 100, 100], [256, 256, 256]), [0, 0, 0]);
}

// ---- gravedad: nada baja de la cama, y lo suelto se posa ----
{
  const box = (x: number, y: number, z: number, size = 10): Box => ({
    min: [x, y, z],
    max: [x + size, y + size, z + size],
  });

  // El recorte contra la cama.
  assert.equal(bedClamp(0, -30, 0), 0, 'una pieza en el suelo no puede hundirse');
  assert.equal(bedClamp(5, -30, 0), -5, 'baja solo hasta apoyar');
  assert.equal(bedClamp(0, 12, 0), 12, 'hacia arriba no se toca');

  // Sin nada debajo: cae a la cama.
  assert.equal(restingZ(box(0, 0, 40), [], 0), 0);

  // Encima de otra pieza: se posa en su cara superior.
  const support = box(0, 0, 0);
  assert.equal(restingZ(box(2, 2, 40), [support], 0), 10, 'se posa sobre la pieza');

  // Apartada en planta: la pieza de al lado no la sostiene.
  assert.equal(restingZ(box(30, 0, 40), [support], 0), 0, 'sin solape no hay apoyo');
  assert.equal(overlapsXY(box(0, 0, 0), box(10, 0, 0)), false, 'tocarse por el borde no es apoyo');

  // Lo que está por encima no sostiene.
  assert.equal(restingZ(box(0, 0, 5), [box(0, 0, 50)], 0), 0, 'un techo no es un suelo');

  // Torre: gana el apoyo más alto.
  assert.equal(restingZ(box(1, 1, 60), [box(0, 0, 0), box(0, 0, 10)], 0), 20);

  // La cama puede no estar en cero: un modelo cargado a 100 mm de altura.
  assert.equal(restingZ(box(0, 0, 300), [], 100), 100);
  assert.deepEqual(shift(box(0, 0, 0), [1, 2, 3]).min, [1, 2, 3]);
}

console.log('mesh self-check ok');
