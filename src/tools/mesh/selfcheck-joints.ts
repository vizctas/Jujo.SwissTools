/*
 * Self-check de las uniones, con Manifold de verdad (WASM en Node).
 *
 * El fallo que esto vigila: una espiga dimensionada por la caja de la pieza en
 * vez de por la sección del corte. Una barra de 30×30 debe recibir espigas de
 * unos 6 mm, y una L cuyo brazo es estrecho no debe recibir una que perfore la pared.
 */

import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import { applyJoint, frame, planJoint } from './joints.ts';
import type { JointSpec } from './protocol.ts';

const wasm = await Module();
wasm.setup();
const { Manifold } = wasm;

const auto: JointSpec = { mode: 'dowel', shape: 'round', auto: true, diameter: 6, depth: 10, clearance: 0.15, count: 0 };

// ---- barra 30×30×100, corte por el medio en X: espigas de ~6 mm, dos de ellas no caben (sección 30) ----
{
  const bar = Manifold.cube([100, 30, 30], false);
  const { forward, back } = frame([1, 0, 0]);
  const aligned = forward(bar);
  const [above, below] = aligned.splitByPlane([0, 0, 1], 50);
  const { plan, report } = planJoint(wasm, aligned, 50, auto, { above: 50, below: 50 });
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
  const { plan } = planJoint(wasm, slab, 10, auto, { above: 10, below: 10 });
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
  const { plan, report } = planJoint(wasm, ell, 10, manual, { above: 10, below: 10 });
  assert.ok(plan, `debe caber algo: ${report.skipped}`);
  assert.ok(plan.diameter < 6, `una espiga de 6 no cabe en 8 mm de pared; fue ${plan.diameter}`);
  assert.ok(plan.diameter >= 2);
}

// ---- macho-hembra: sin espigas sueltas, la mitad de arriba gana volumen y la de abajo pierde ----
{
  const bar = Manifold.cube([30, 30, 100], false);
  const [above, below] = bar.splitByPlane([0, 0, 1], 50);
  const spec: JointSpec = { ...auto, mode: 'plug' };
  const { plan } = planJoint(wasm, bar, 50, spec, { above: 50, below: 50 });
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
  const { plan } = planJoint(wasm, bar, 50, spec, { above: 50, below: 50 });
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
    const { plan } = planJoint(wasm, bar, 50, spec, { above: 50, below: 50 });
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

console.log('joints self-check ok');
