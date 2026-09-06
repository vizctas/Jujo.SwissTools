/*
 * Self-check de las uniones, con Manifold de verdad (WASM en Node).
 *
 * El fallo que esto vigila: una espiga dimensionada por la caja de la pieza en
 * vez de por la sección del corte. Una barra de 30×30 debe recibir espigas de
 * unos 6 mm, y una L cuyo brazo es estrecho no debe recibir una que perfore la pared.
 */

import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import { applyJoint, frame, planJoint, windowColumn } from './joints.ts';
import type { JointSpec } from './protocol.ts';
import { dot, planeBasis } from './plane.ts';

const wasm = await Module();
wasm.setup();
const { Manifold } = wasm;

const auto: JointSpec = { mode: 'dowel', shape: 'round', auto: true, diameter: 6, depth: 10, clearance: 0.15, count: 0 };

// ---- frame y planeBasis son el mismo marco ----
{
  // Un cubo desplazado, girado al marco alineado, tiene su centro en (c·u, c·v, c·n).
  const normal: [number, number, number] = [0.6, 0.48, 0.64];
  const { u, v, n } = planeBasis(normal);
  const c: [number, number, number] = [30, -12, 25];
  const cube = Manifold.cube([10, 10, 10], true).translate(c);
  const { forward, back } = frame(normal);
  const aligned = forward(cube);
  const box = aligned.boundingBox();
  const mid = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  assert.ok(Math.abs(mid[0]! - dot(c, u)) < 0.01, `x = c·u: ${mid[0]} vs ${dot(c, u)}`);
  assert.ok(Math.abs(mid[1]! - dot(c, v)) < 0.01, `y = c·v: ${mid[1]} vs ${dot(c, v)}`);
  assert.ok(Math.abs(mid[2]! - dot(c, n)) < 0.01, `z = c·n: ${mid[2]} vs ${dot(c, n)}`);
  // Ida y vuelta devuelve el cubo a su sitio, y el volumen no se toca.
  const restored = back(aligned).boundingBox();
  assert.ok(Math.abs((restored.min[0] + restored.max[0]) / 2 - c[0]) < 0.01, 'vuelve a x');
  assert.ok(Math.abs((restored.min[2] + restored.max[2]) / 2 - c[2]) < 0.01, 'vuelve a z');
  assert.ok(Math.abs(aligned.volume() - 1000) < 0.01, 'una rotación no cambia el volumen');
}

// ---- barra 30×30×100, corte por el medio en X: espigas de ~6 mm, dos de ellas no caben (sección 30) ----
{
  const bar = Manifold.cube([100, 30, 30], false);
  const { forward, back } = frame([1, 0, 0]);
  const aligned = forward(bar);
  const [above, below] = aligned.splitByPlane([0, 0, 1], 50);
  const { plan, report } = planJoint(aligned, 50, auto, { above: 50, below: 50 });
  assert.ok(plan, `debe haber plan: ${report.skipped}`);
  assert.ok(Math.abs(plan.diameter - 6) < 0.01, `diámetro ~6, fue ${plan.diameter}`);
  assert.ok(plan.depth >= 9 && plan.depth <= 10, `profundidad ~9.6, fue ${plan.depth}`);
  assert.equal(plan.spots.length, 1, 'en 30×30 cabe una espiga de 6 con pared, no dos');
  const applied = applyJoint(wasm, above, below, 50, plan, auto.clearance);
  assert.equal(applied.pins.length, 1);
  const a = back(applied.above);
  const pinBox = back(applied.pins[0]!).boundingBox();
  // La espiga vuelve al marco original, tumbada a lo largo de X y centrada en el corte.
  assert.ok(Math.abs((pinBox.min[0] + pinBox.max[0]) / 2 - 50) < 0.01, 'espiga centrada en x=50');
  assert.ok(Math.abs(pinBox.max[0] - pinBox.min[0] - (plan.depth * 2 - 0.3)) < 0.01, 'largo = 2·profundidad − holgura');
  assert.ok(a.volume() < 50 * 30 * 30 - 1, 'la mitad tiene el taladro descontado');
  assert.ok(Math.abs(a.volume() - (50 * 900 - Math.PI * 3.15 ** 2 * plan.depth)) < 60, 'volumen ≈ mitad − taladro');
}

// ---- placa 100×100×20, corte en Z: dos espigas separadas, no una ----
{
  const slab = Manifold.cube([100, 100, 20], false);
  const { plan } = planJoint(slab, 10, auto, { above: 10, below: 10 });
  assert.ok(plan);
  assert.equal(plan.spots.length, 2, 'una cara ancha recibe dos espigas');
  assert.ok(plan.depth <= 4.5, `la profundidad respeta el grosor de 20 (≤ 4.5), fue ${plan.depth}`);
}

// ---- L estrecha: el brazo de 8 mm no puede recibir una espiga de 6 manual; se encoge ----
{
  const foot = Manifold.cube([40, 8, 20], false);
  const leg = Manifold.cube([8, 40, 20], false);
  const ell = foot.add(leg);
  const manual: JointSpec = { ...auto, auto: false, diameter: 6, count: 1 };
  const { plan, report } = planJoint(ell, 10, manual, { above: 10, below: 10 });
  assert.ok(plan, `debe caber algo: ${report.skipped}`);
  assert.ok(plan.diameter < 6, `una espiga de 6 no cabe en 8 mm de pared; fue ${plan.diameter}`);
  assert.ok(plan.diameter >= 2);
}

// ---- macho-hembra: sin espigas sueltas, la mitad de arriba gana volumen y la de abajo pierde ----
{
  const bar = Manifold.cube([30, 30, 100], false);
  const [above, below] = bar.splitByPlane([0, 0, 1], 50);
  const spec: JointSpec = { ...auto, mode: 'plug' };
  const { plan } = planJoint(bar, 50, spec, { above: 50, below: 50 });
  assert.ok(plan);
  const applied = applyJoint(wasm, above, below, 50, plan, spec.clearance);
  assert.equal(applied.pins.length, 0);
  assert.ok(applied.above.volume() > 45_000, 'macho añadido');
  assert.ok(applied.below.volume() < 45_000, 'hembra tallada');
}

// ---- cónica: la espiga es bicónica, más ancha en el centro que en las puntas ----
{
  const bar = Manifold.cube([30, 30, 100], false);
  const [above, below] = bar.splitByPlane([0, 0, 1], 50);
  const spec: JointSpec = { ...auto, shape: 'cone' };
  const { plan } = planJoint(bar, 50, spec, { above: 50, below: 50 });
  assert.ok(plan);
  const applied = applyJoint(wasm, above, below, 50, plan, spec.clearance);
  const pin = applied.pins[0]!;
  const middle = pin.slice(50).area();
  const tip = pin.slice(50 + plan.depth - 0.5).area();
  assert.ok(middle > tip * 1.5, 'la cónica se estrecha hacia la punta');
}

// ---- hexagonal y triangular: sección poligonal con el número de lados correcto, dentro del círculo ----
{
  for (const [shape, sides] of [['hex', 6], ['triangle', 3], ['square', 4]] as const) {
    const bar = Manifold.cube([30, 30, 100], false);
    const [above, below] = bar.splitByPlane([0, 0, 1], 50);
    const spec: JointSpec = { ...auto, shape };
    const { plan } = planJoint(bar, 50, spec, { above: 50, below: 50 });
    assert.ok(plan);
    const applied = applyJoint(wasm, above, below, 50, plan, spec.clearance);
    const section = applied.pins[0]!.slice(50);
    const polygon = section.toPolygons()[0]!;
    // La rebanada cruza las diagonales de los lados y mete puntos colineales: se cuentan esquinas.
    const corners = polygon.filter((p, i) => {
      const a = polygon[(i + polygon.length - 1) % polygon.length]!;
      const b = polygon[(i + 1) % polygon.length]!;
      const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
      return Math.abs(cross) > 1e-6;
    });
    assert.equal(corners.length, sides, `${shape}: ${sides} esquinas, fueron ${corners.length}`);
    const r = plan.diameter / 2;
    for (const [x, y] of polygon) assert.ok(Math.hypot(x - 15, y - 15) <= r + 1e-3, `${shape}: vértice dentro del círculo circunscrito`);
    const hole = applied.above.slice(50 + 0.5);
    assert.ok(hole.area() < 900 - section.area(), `${shape}: el alojamiento es mayor que el conector`);
  }
}

// ---- cantidad pedida: cuatro caben en una placa, repartidos y con pared ----
{
  const slab = Manifold.cube([100, 100, 40], false);
  const { plan, report } = planJoint(slab, 20, { ...auto, count: 4 }, { above: 20, below: 20 });
  assert.ok(plan);
  assert.equal(report.requested, 4);
  // Anotado a mano: `assert` es una función de aserción y TypeScript no sabe
  // inferir dentro de un bucle que vuelve a leer lo que la aserción estrechó.
  const spots: Array<[number, number]> = plan.spots;
  const diameter: number = plan.diameter;
  assert.equal(spots.length, 4, `cuatro caben en 100×100, fueron ${spots.length}`);
  const section = slab.slice(20);
  for (let i = 0; i < spots.length; i += 1) {
    const [x, y] = spots[i]!;
    // Cada uno con su pared: el taladro más 1 mm sigue dentro de la sección.
    const probe = wasm.CrossSection.circle(diameter / 2 + 1, 48).translate([x, y]);
    const overlap = probe.intersect(section);
    assert.ok(Math.abs(overlap.area() - probe.area()) < 0.5, 'el conector y su pared caben en la sección');
    for (let j = i + 1; j < spots.length; j += 1) {
      const [ox, oy] = spots[j]!;
      assert.ok(Math.hypot(x - ox, y - oy) >= diameter * 2 - 1e-6, 'separados al menos dos diámetros');
    }
  }
  // Y repartidos, no amontonados: uno por cuadrante.
  assert.equal(new Set(spots.map(([x, y]) => `${x > 50 ? 1 : 0}${y > 50 ? 1 : 0}`)).size, 4, 'uno por cuadrante');
}

// ---- pedir más de los que caben: salen los que encajan, y se sabe cuántos se pidieron ----
{
  // 20×20 con conectores de 6 a mano: entre dos centros hacen falta 12 mm y la
  // zona útil mide 10,4, así que en cruz no caben; en diagonal, dos sí.
  const bar = Manifold.cube([20, 20, 100], false);
  const { plan, report } = planJoint(bar, 50, { ...auto, auto: false, count: 4 }, { above: 50, below: 50 });
  assert.ok(plan);
  assert.equal(report.requested, 4);
  const spots: Array<[number, number]> = plan.spots;
  const diameter: number = plan.diameter;
  assert.ok(spots.length < 4, `en 20×20 no caben cuatro de 6 mm; salieron ${spots.length}`);
  assert.ok(spots.length >= 1);
  assert.equal(report.count, spots.length);
  for (let i = 0; i < spots.length; i += 1) {
    for (let j = i + 1; j < spots.length; j += 1) {
      const [x, y] = spots[i]!;
      const [ox, oy] = spots[j]!;
      assert.ok(Math.hypot(x - ox, y - oy) >= diameter * 2 - 1e-6, 'los que salen mantienen la separación');
    }
  }
}

// ---- sección en dos trozos: uno en cada uno, o las mitades no quedan unidas ----
{
  const two = Manifold.cube([20, 20, 100], false).add(Manifold.cube([20, 20, 100], false).translate([60, 0, 0]));
  const { plan } = planJoint(two, 50, auto, { above: 50, below: 50 });
  assert.ok(plan);
  const spots: Array<[number, number]> = plan.spots;
  assert.equal(spots.length, 2, 'un conector por cada trozo de la sección');
  const xs = spots.map(([x]) => x).sort((a, b) => a - b);
  assert.ok(xs[0]! < 30 && xs[1]! > 50, `uno en cada trozo, fueron ${xs.map((x) => x.toFixed(1)).join(' y ')}`);
}

// ---- corte medido: la ventana separa un brazo sin tocar el ala que hay detrás ----
{
  // Un cuerpo con dos apéndices que cruzan el mismo plano x = 70.
  const body = Manifold.cube([60, 40, 60], false);
  const arm = Manifold.cube([40, 12, 12], false).translate([50, 14, 40]);
  const wing = Manifold.cube([40, 12, 12], false).translate([50, 14, 10]);
  const model = body.add(arm).add(wing);
  const total = model.volume();

  // Sin ventana, el plano infinito se lleva los dos apéndices por delante.
  const { forward } = frame([1, 0, 0]);
  const alignedPlain = forward(model);
  const [plainAbove] = alignedPlain.splitByPlane([0, 0, 1], 70);
  assert.equal(plainAbove.decompose().length, 2, 'el plano entero corta brazo y ala');

  // Con ventana sobre el brazo (ejes Y y Z), solo se separa el brazo.
  const column = windowColumn(wasm, [1, 0, 0], 70, { center: [20, 46], size: [20, 20], side: 1 }, 500);
  assert.ok(column, 'la columna se construye con normal sobre un eje');
  const above = model.intersect(column);
  const below = model.subtract(column);
  assert.ok(Math.abs(above.volume() - 20 * 12 * 12) < 1, `solo el trozo de brazo: ${above.volume().toFixed(0)}`);
  assert.ok(Math.abs(below.volume() - (total - 20 * 12 * 12)) < 1, 'el resto conserva su volumen');
  assert.equal(below.decompose().length, 1, 'lo que queda sigue siendo una sola pieza, con su ala');

  // Y la cara de unión es la del brazo: el conector no se planta en el ala.
  const aligned = forward(model);
  const limit = forward(column).slice(70.01);
  const { plan, report } = planJoint(aligned, 70, auto, { above: 20, below: 70 }, limit);
  assert.ok(plan, `debe haber plan: ${report.skipped}`);
  const sectionOfArm = aligned.slice(70.01).intersect(limit);
  assert.ok(Math.abs(sectionOfArm.area() - 12 * 12) < 1, 'la sección limitada es la del brazo');
  for (const [x, y] of plan.spots) {
    const probe = wasm.CrossSection.circle(0.01, 8).translate([x, y]);
    assert.ok(!probe.intersect(sectionOfArm).isEmpty(), 'el conector cae dentro del brazo');
  }
}

// ---- recorte con profundidad: se lleva solo la caja pedida, no el corredor entero ----
{
  // Una barra larga: sin profundidad el recorte se lleva todo lo que hay más
  // allá del plano; con 20 mm, solo esos 20 mm.
  const bar = Manifold.cube([100, 20, 20], false);
  const sinFondo = windowColumn(wasm, [1, 0, 0], 30, { center: [10, 10], size: [30, 30], side: 1 }, 500);
  const conFondo = windowColumn(wasm, [1, 0, 0], 30, { center: [10, 10], size: [30, 30], side: 1 }, 20);
  assert.ok(sinFondo && conFondo);
  assert.ok(Math.abs(bar.intersect(sinFondo).volume() - 70 * 20 * 20) < 1, 'sin profundidad llega al final');
  assert.ok(Math.abs(bar.intersect(conFondo).volume() - 20 * 20 * 20) < 1, 'con profundidad, solo la caja');
  assert.ok(Math.abs(bar.subtract(conFondo).volume() - (100 - 20) * 20 * 20) < 1, 'y el resto queda entero');
  // Hacia el otro lado se lleva el trozo de antes del plano, no el de después.
  const atras = windowColumn(wasm, [1, 0, 0], 30, { center: [10, 10], size: [30, 30], side: -1 }, 20);
  assert.ok(atras);
  assert.ok(Math.abs(bar.intersect(atras).volume() - 20 * 20 * 20) < 1, 'lado negativo: la caja anterior al plano');
  const box = bar.intersect(atras).boundingBox();
  assert.ok(Math.abs(box.min[0] - 10) < 0.01 && Math.abs(box.max[0] - 30) < 0.01, `x 10..30, fue ${box.min[0]}..${box.max[0]}`);
}

// ---- ventana con normal torcida: no se aplica, y se dice ----
{
  assert.equal(windowColumn(wasm, [0.7, 0.7, 0], 10, { center: [0, 0], size: [10, 10], side: 1 }, 100), null);
}

console.log('joints self-check ok');
