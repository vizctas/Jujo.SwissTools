/*
 * Self-check de la detección de partes que se desprenden, con Manifold en Node.
 *
 * Lo que vigila: que encuentre el cuello donde está —el hombro, no dos
 * milímetros más allá—, que la ventana envuelva el apéndice y no medio cuerpo,
 * y sobre todo que un sólido sin apéndices no proponga nada. Una detección que
 * inventa cortes es peor que no tenerla.
 */

import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import { findAppendages } from './appendages.ts';

const wasm = await Module();
wasm.setup();
const { Manifold } = wasm;

// ---- un cuerpo con un brazo: se encuentra, y en el hombro ----
{
  const body = Manifold.cube([60, 40, 60], false);
  const arm = Manifold.cube([30, 12, 12], false).translate([60, 14, 40]);
  const found = findAppendages(wasm, body.add(arm));

  assert.ok(found.length >= 1, 'debe encontrar el brazo');
  const brazo = found.find((f) => f.axis === 0 && f.side === 1);
  assert.ok(brazo, `brazo hacia +X; salió ${JSON.stringify(found.map((f) => [f.axis, f.side]))}`);
  assert.ok(Math.abs(brazo.offset - 60) < 1.5, `corta en el hombro (x = 60), fue ${brazo.offset.toFixed(2)}`);

  // La ventana envuelve el brazo (y 14..26, z 40..52) con un poco de margen.
  const [cy, cz] = brazo.window.center;
  assert.ok(Math.abs(cy - 20) < 1.5 && Math.abs(cz - 46) < 1.5, `centrada en el brazo: ${cy.toFixed(1)}, ${cz.toFixed(1)}`);
  assert.ok(brazo.window.size[0] >= 12 && brazo.window.size[0] < 24, `ancho de ventana ~12–18, fue ${brazo.window.size[0].toFixed(1)}`);
  assert.ok(brazo.window.size[1] >= 12 && brazo.window.size[1] < 24, `alto de ventana ~12–18, fue ${brazo.window.size[1].toFixed(1)}`);

  // Y el volumen estimado se parece al del brazo: 30 × 12 × 12.
  assert.ok(Math.abs(brazo.volume - 4320) < 1800, `volumen ~4320, fue ${brazo.volume.toFixed(0)}`);
  assert.ok(Math.abs(brazo.area - 144) < 60, `cara de unión ~144 mm², fue ${brazo.area.toFixed(0)}`);
}

// ---- un brazo por Y: la ventana va en el marco del plano (u = −x, v = z) ----
{
  const body = Manifold.cube([60, 40, 60], false);
  const arm = Manifold.cube([12, 30, 12], false).translate([24, 40, 40]);
  const found = findAppendages(wasm, body.add(arm));
  const brazo = found.find((f) => f.axis === 1 && f.side === 1);
  assert.ok(brazo, `brazo hacia +Y; salió ${JSON.stringify(found.map((f) => [f.axis, f.side]))}`);
  const [cu, cv] = brazo.window.center;
  // El brazo va de x 24..36 y z 40..52: u = −x → −30, v = z → 46.
  assert.ok(Math.abs(cu + 30) < 1.5 && Math.abs(cv - 46) < 1.5, `centro (−30, 46), fue (${cu.toFixed(1)}, ${cv.toFixed(1)})`);
}

// ---- dos brazos y una cabeza: los tres, sin repetirse entre ejes ----
{
  const body = Manifold.cube([60, 40, 60], false);
  const right = Manifold.cube([30, 12, 12], false).translate([60, 14, 40]);
  const left = Manifold.cube([30, 12, 12], false).translate([-30, 14, 40]);
  const head = Manifold.cube([16, 16, 20], false).translate([22, 12, 60]);
  const found = findAppendages(wasm, body.add(right).add(left).add(head));

  assert.ok(found.length >= 3, `tres apéndices, salieron ${found.length}`);
  assert.ok(found.some((f) => f.axis === 0 && f.side === 1), 'brazo derecho');
  assert.ok(found.some((f) => f.axis === 0 && f.side === -1), 'brazo izquierdo');
  assert.ok(found.some((f) => f.axis === 2 && f.side === 1), 'cabeza arriba');
  // Ninguno se solapa con otro: el mismo brazo no sale dos veces por ejes distintos.
  for (const a of found) {
    for (const b of found) {
      if (a === b) continue;
      const mismoSitio = a.axis === b.axis && a.side === b.side && Math.abs(a.offset - b.offset) < 1;
      assert.ok(!mismoSitio, 'sin duplicados');
    }
  }
}

// ---- un cubo no tiene nada que desprender ----
{
  assert.equal(findAppendages(wasm, Manifold.cube([50, 50, 50], false)).length, 0, 'un cubo no propone cortes');
}

// ---- una esfera tampoco: se estrecha, pero de forma continua ----
{
  assert.equal(findAppendages(wasm, Manifold.sphere(30, 64)).length, 0, 'una esfera no tiene cuello');
}

// ---- media pieza no es un apéndice: dos bloques iguales unidos por una cara ----
{
  const a = Manifold.cube([40, 40, 40], false);
  const b = Manifold.cube([40, 40, 40], false).translate([40, 0, 0]);
  assert.equal(findAppendages(wasm, a.add(b)).length, 0, 'partir por la mitad no es desprender una parte');
}

console.log('appendages self-check ok');
