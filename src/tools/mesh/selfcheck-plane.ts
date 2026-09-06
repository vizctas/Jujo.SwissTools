/*
 * Self-check de la matemática del plano. `npm run check`.
 *
 * Lo que vigila: que el marco (u, v) sea el mismo en todas partes y que para
 * los planos por eje coincida con lo que había (X y Z idénticos, Y con u = −X),
 * porque de ese marco cuelgan la columna de recorte, el gizmo y los sliders.
 */

import assert from 'node:assert/strict';
import { cross, dot, orient, planeBasis, projectBox, type Vec3 } from './plane.ts';

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;
const same = (a: Vec3, b: Vec3, eps = 1e-6): boolean => a.every((c, i) => near(c, b[i]!, eps));

// ---- planos por eje: X y Z como antes, Y con u invertida ----
{
  const z = planeBasis([0, 0, 1]);
  assert.ok(same(z.u, [1, 0, 0]) && same(z.v, [0, 1, 0]), `Z → (x, y), fue ${JSON.stringify(z)}`);
  const x = planeBasis([1, 0, 0]);
  assert.ok(same(x.u, [0, 1, 0]) && same(x.v, [0, 0, 1]), `X → (y, z), fue ${JSON.stringify(x)}`);
  const y = planeBasis([0, 1, 0]);
  assert.ok(same(y.u, [-1, 0, 0]) && same(y.v, [0, 0, 1]), `Y → (−x, z), fue ${JSON.stringify(y)}`);
}

// ---- plano inclinado: ortonormal, dextrógiro y con «alto» hacia arriba ----
{
  const { u, v, n } = planeBasis([0.6, 0, 0.8]);
  assert.ok(near(dot(u, v), 0) && near(dot(u, n), 0) && near(dot(v, n), 0), 'ortogonal');
  assert.ok(near(Math.hypot(...u), 1) && near(Math.hypot(...v), 1) && near(Math.hypot(...n), 1), 'unitario');
  assert.ok(same(cross(u, v), n), 'u × v = n');
  assert.ok(v[2] > 0, `v mira hacia arriba, fue ${JSON.stringify(v)}`);
  // La normal sin normalizar también vale.
  assert.ok(same(planeBasis([6, 0, 8]).n, n));
}

// ---- orientar: la componente dominante, positiva ----
{
  assert.deepEqual(orient([0, 0, -1]), [0, 0, 1]);
  assert.deepEqual(orient([-0.8, 0.6, 0]), [0.8, -0.6, 0]);
  assert.deepEqual(orient([0.1, -0.9, 0.2]), [-0.1, 0.9, -0.2]);
}

// ---- caja proyectada: rangos sobre cada vector del marco ----
{
  const basis = planeBasis([1, 0, 0]);
  const box = projectBox([10, 20, 30], [40, 60, 90], basis);
  assert.deepEqual(box.n, [10, 40], 'a lo largo de X');
  assert.deepEqual(box.u, [20, 60], 'u = Y');
  assert.deepEqual(box.v, [30, 90], 'v = Z');
  // Inclinada: la diagonal del cubo unitario sobre su propia dirección mide √3.
  const d = planeBasis([1, 1, 1]);
  const cube = projectBox([0, 0, 0], [1, 1, 1], d);
  assert.ok(near(cube.n[1] - cube.n[0], Math.sqrt(3)), `√3, fue ${cube.n[1] - cube.n[0]}`);
}

console.log('plane self-check ok');
