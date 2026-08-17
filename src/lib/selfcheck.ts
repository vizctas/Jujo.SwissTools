/*
 * Self-check del núcleo. `npm run check`.
 *
 * Cubre lo que se rompe en silencio: escapado de formatos, geometría del render,
 * y las ramas del guardián de escaneabilidad. No es una suite; es la cosa más
 * pequeña que falla si la lógica se rompe.
 */

import assert from 'node:assert/strict';
import { contrastRatio, normalizeHex, pushToContrast } from './color.ts';
import { contentType, initialValues } from './content.ts';
import { encode, EncodeError } from './qr.ts';
import { centerSlot, fitCenterTextSize, renderSvg } from './render.ts';
import { DEFAULT_DESIGN, type QrDesign } from './types.ts';
import {
  CENTER_LIMIT,
  comfortableLevelForCenter,
  minimumLevelForLogo,
  validate,
} from './validate.ts';

const design = (patch: Partial<QrDesign> = {}): QrDesign => ({ ...DEFAULT_DESIGN, ...patch });

// ---- color ----
assert.equal(normalizeHex('#ABC'), '#aabbcc');
assert.equal(normalizeHex('nope'), null);
assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
{
  const darkened = pushToContrast('#888888', '#ffffff', 4.5, 'darker');
  assert.ok(contrastRatio(darkened, '#ffffff') >= 4.5, 'pushToContrast debe alcanzar el objetivo');
  const lightened = pushToContrast('#888888', '#000000', 4.5, 'lighter');
  assert.ok(contrastRatio(lightened, '#000000') >= 4.5);
}

// ---- codificación ----
{
  const result = encode('https://example.com', 'M');
  assert.ok(result.matrix.size >= 21 && result.matrix.size % 4 === 1);
  assert.ok(result.utilization > 0 && result.utilization <= 1);
  assert.throws(() => encode('', 'M'), (error: unknown) => error instanceof EncodeError && error.kind === 'empty');
  assert.throws(
    () => encode('x'.repeat(4000), 'H'),
    (error: unknown) => error instanceof EncodeError && error.kind === 'too-long',
  );
}

// ---- serialización de contenido ----
{
  assert.equal(contentType('url').encode({ url: 'ejemplo.com' }), 'https://ejemplo.com');
  assert.equal(contentType('url').encode({ url: 'http://a.b' }), 'http://a.b');

  // El punto y coma y los dos puntos del SSID tienen que salir escapados.
  const wifi = contentType('wifi').encode({
    ssid: 'Café; Bar:1',
    security: 'WPA',
    password: 'a\\b',
    hidden: 'true',
  });
  assert.equal(wifi, 'WIFI:T:WPA;S:Café\\; Bar\\:1;P:a\\\\b;H:true;;');

  const openNetwork = contentType('wifi').encode({ ssid: 'Libre', security: 'nopass', password: 'x' });
  assert.ok(!openNetwork.includes('P:'), 'una red abierta no lleva clave');

  const vcard = contentType('vcard').encode({ firstName: 'Ana', lastName: 'Gil, Soto', org: 'Acme' });
  assert.ok(vcard.startsWith('BEGIN:VCARD\r\nVERSION:3.0'));
  assert.ok(vcard.includes('N:Gil\\, Soto;Ana;;;'));
  assert.ok(vcard.includes('FN:Ana Gil\\, Soto'));
  assert.ok(vcard.endsWith('END:VCARD'));

  const allDay = contentType('event').encode({ summary: 'Feria', startDate: '2026-09-01' });
  assert.ok(allDay.includes('DTSTART;VALUE=DATE:20260901'));
  const timed = contentType('event').encode({
    summary: 'Charla',
    startDate: '2026-09-01',
    startTime: '18:30',
  });
  assert.ok(timed.includes('DTSTART:20260901T183000'));

  assert.equal(contentType('phone').encode({ number: '+34 600 (00) 00-00' }), 'tel:+34600000000');
  assert.equal(contentType('geo').encode({ lat: '40.4', lon: '-3.7' }), 'geo:40.4,-3.7');
  assert.ok(contentType('email').encode({ to: 'a@b.co', subject: 'Hola y adiós' }).includes('subject=Hola+y+adi%C3%B3s'));

  // Todo tipo arranca con valores utilizables y sin campos huérfanos.
  for (const type of ['url', 'wifi', 'vcard', 'event', 'geo'] as const) {
    const values = initialValues(type);
    for (const field of contentType(type).fields) {
      assert.ok(field.name in values, `${type}.${field.name} sin valor inicial`);
    }
    assert.equal(contentType(type).encode(values), '', `${type} vacío no debe codificar nada`);
  }
  assert.equal(initialValues('wifi')['security'], 'WPA');
}

// ---- render ----
{
  const { matrix } = encode('https://example.com', 'Q');
  const plain = renderSvg(matrix, design({ quietZone: 4 }));
  assert.equal(plain.width, matrix.size + 8);
  assert.equal(plain.height, plain.width, 'sin texto la pieza es cuadrada');
  assert.ok(plain.svg.startsWith('<svg '));
  assert.ok(plain.svg.includes('fill-rule="evenodd"'), 'el marco del ojo necesita evenodd');
  assert.equal(plain.logoRect, null);

  const captioned = renderSvg(matrix, design({ caption: 'Menú', subcaption: 'Mesa 4' }));
  assert.ok(captioned.height > captioned.width, 'el texto crece la pieza hacia abajo');
  assert.ok(captioned.svg.includes('>Menú<') && captioned.svg.includes('>Mesa 4<'));

  // El texto se escapa: un & suelto rompería el XML.
  assert.ok(renderSvg(matrix, design({ caption: 'Tapas & Vinos' })).svg.includes('Tapas &amp; Vinos'));

  // Forma continua: esquinas redondeadas solo donde hay vecinos apagados.
  assert.ok(renderSvg(matrix, design({ moduleShape: 'connected' })).svg.includes('A0.5,0.5'));
  assert.ok(!renderSvg(matrix, design({ moduleShape: 'square' })).svg.includes('A0.5,0.5'));

  // Con logo y recorte aparecen placa, clip e imagen, y el rect sale centrado.
  const withLogo = renderSvg(
    matrix,
    design({ logo: { dataUri: 'data:image/png;base64,AAA', name: 'l.png' }, logoScale: 0.2 }),
  );
  assert.ok(withLogo.logoRect !== null);
  assert.ok(withLogo.svg.includes('<clipPath') && withLogo.svg.includes('xlink:href='));
  assert.equal(
    Math.round((withLogo.logoRect!.x + withLogo.logoRect!.size / 2) * 100) / 100,
    withLogo.width / 2,
  );

  // Ids únicos entre dos piezas del mismo documento.
  const a = renderSvg(matrix, design({ logo: { dataUri: 'data:,', name: 'a' } })).svg;
  const b = renderSvg(matrix, design({ logo: { dataUri: 'data:,', name: 'b' } })).svg;
  const idOf = (svg: string): string => /id="(jujo-logo-\d+)"/.exec(svg)?.[1] ?? '';
  assert.notEqual(idOf(a), idOf(b), 'dos piezas no pueden compartir el id del clip');

  // --- la ranura del centro ---
  assert.equal(centerSlot(design(), matrix.size), null, 'centro libre por defecto');

  const textSlot = centerSlot(design({ centerText: 'MENU', centerTextSize: 4 }), matrix.size);
  assert.equal(textSlot?.kind, 'text');
  assert.ok(textSlot!.w > textSlot!.h, 'una palabra es más ancha que alta');
  // Área equivalente, no anchura: si no, un texto ancho y bajo se daría por roto.
  assert.equal(
    Math.round(textSlot!.widthRatio * 1000),
    Math.round((Math.sqrt(textSlot!.w * textSlot!.h) / matrix.size) * 1000),
  );
  assert.ok(textSlot!.widthRatio < textSlot!.w / matrix.size);

  const logoSlot = centerSlot(
    design({ centerText: 'MENU', logo: { dataUri: 'data:,', name: 'l' } }),
    matrix.size,
  );
  assert.equal(logoSlot?.kind, 'logo', 'el logo manda sobre el texto');
  assert.equal(logoSlot!.w, logoSlot!.h);

  /*
   * La promesa: un texto recién puesto nunca nace roto. El tamaño se ajusta al
   * presupuesto del nivel actual y, si ni el mínimo cabe ahí —pasa con corrección L
   * en códigos pequeños—, el auto-nivel sube la corrección y lo anuncia. Se
   * comprueba la promesa completa, no solo el primer paso.
   */
  const ORDER = ['L', 'M', 'Q', 'H'] as const;
  for (const level of ORDER) {
    const base = design({ centerText: 'MENÚ', errorLevel: level });
    const size = fitCenterTextSize(base, matrix.size, CENTER_LIMIT[level] * 0.85);
    const fitted = { ...base, centerTextSize: size };
    const slot = centerSlot(fitted, matrix.size)!;

    const needed = comfortableLevelForCenter(slot.widthRatio);
    assert.ok(needed, `${level}: debe existir algún nivel que aguante el texto mínimo`);
    const settled =
      ORDER.indexOf(needed!) > ORDER.indexOf(level) ? { ...fitted, errorLevel: needed! } : fitted;

    assert.equal(
      validate(settled, matrix.size, { kind: 'text', widthRatio: slot.widthRatio }).severity,
      'ok',
      `${level}: un texto recién puesto no puede nacer ni roto ni en aviso`,
    );
  }

  // La subida automática busca margen, no el mínimo que aguanta justo.
  assert.equal(minimumLevelForLogo(0.18), 'Q'); // 0.18 <= 0.20, pero sin margen
  assert.equal(comfortableLevelForCenter(0.18), 'H'); // 0.18 <= 0.30 * 0.85
  assert.equal(comfortableLevelForCenter(0.05), 'L');

  // El texto se dibuja centrado y recorta módulos como haría un logo.
  const centered = renderSvg(matrix, design({ centerText: 'MENU' }));
  assert.ok(centered.svg.includes('>MENU<'));
  assert.equal(centered.logoRect, null, 'no hay logo que reportar');
  const withoutText = renderSvg(matrix, design());
  assert.ok(
    centered.svg.length !== withoutText.svg.length,
    'el texto central cambia la pieza',
  );
  // Sin recorte no hay placa; con recorte sí.
  assert.ok(renderSvg(matrix, design({ centerText: 'MENU' })).svg.includes('<rect x='));
  assert.ok(
    !renderSvg(matrix, design({ centerText: 'MENU', logoPunchout: false, bgTransparent: true }))
      .svg.includes('<rect x='),
  );

  // El texto solo se encoge cuando de verdad no cabe.
  const wide = renderSvg(matrix, design({ caption: 'x' }), { measureText: () => 9999 });
  assert.ok(wide.svg.includes('textLength='));
  const narrow = renderSvg(matrix, design({ caption: 'x' }), { measureText: () => 1 });
  assert.ok(!narrow.svg.includes('textLength='));
}

// ---- guardián de escaneabilidad ----
{
  const size = 33;
  assert.equal(validate(design(), size).severity, 'ok');

  const inverted = validate(design({ moduleColor: '#ffffff', bgColor: '#000000' }), size);
  assert.equal(inverted.severity, 'broken');
  assert.equal(inverted.findings[0]?.id, 'polarity');
  const swapped = { ...design({ moduleColor: '#ffffff', bgColor: '#000000' }), ...inverted.findings[0]!.fix!.patch };
  assert.equal(validate(swapped, size).severity, 'ok', 'la corrección debe dejarlo sano');

  // Contraste bajo pero no imposible: aviso, no roto.
  const tight = validate(design({ moduleColor: '#7f8794' }), size);
  assert.equal(tight.severity, 'warning');
  assert.equal(tight.findings[0]?.id, 'contrast-tight');

  const washed = validate(design({ moduleColor: '#c3cad4' }), size);
  assert.equal(washed.severity, 'broken');
  assert.equal(washed.findings[0]?.id, 'contrast-broken');
  const fixed = { ...design({ moduleColor: '#c3cad4' }), ...washed.findings[0]!.fix!.patch };
  assert.equal(validate(fixed, size).severity, 'ok');

  assert.equal(validate(design({ quietZone: 2 }), size).severity, 'warning');
  assert.equal(validate(design({ quietZone: 0 }), size).severity, 'broken');

  // Logo pasado para Q, pero H lo aguanta: la corrección es subir el nivel.
  const bigLogo = validate(
    design({ logo: { dataUri: 'data:,', name: 'l' }, logoScale: 0.22, errorLevel: 'Q' }),
    size,
  );
  assert.equal(bigLogo.severity, 'broken');
  assert.equal(bigLogo.findings.find((f) => f.id === 'center-too-big')?.fix?.patch.errorLevel, 'H');

  // Pasado incluso para H: la única salida es encoger el logo.
  const hugeLogo = validate(
    design({ logo: { dataUri: 'data:,', name: 'l' }, logoScale: 0.45, errorLevel: 'H' }),
    size,
  );
  const hugeFix = hugeLogo.findings.find((f) => f.id === 'center-too-big')?.fix;
  assert.equal(hugeFix?.patch.errorLevel, undefined);
  assert.ok((hugeFix?.patch.logoScale ?? 1) < 0.3);

  // El texto del centro se juzga por área, y el mensaje lo nombra por lo que es.
  const bigText = validate(design({ centerText: 'RESERVAS' }), size, {
    kind: 'text',
    widthRatio: 0.34,
  });
  assert.equal(bigText.severity, 'broken');
  const textFinding = bigText.findings.find((f) => f.id === 'center-too-big');
  assert.ok(textFinding?.message.startsWith('El texto del centro'));
  assert.ok((textFinding?.fix?.patch.centerTextSize ?? 99) < DEFAULT_DESIGN.centerTextSize);

  /*
   * La corrección de una palabra larga tiene que dejarla verificada de un clic, no
   * encoger un poco y seguir en rojo. Con el tamaño ya medido, aplicar el arreglo y
   * revalidar debe dar 'ok'.
   */
  {
    const long = design({ centerText: 'VESPRY.APP', centerTextSize: 6, errorLevel: 'H' });
    const fitted = fitCenterTextSize(long, size, CENTER_LIMIT.H * 0.85);
    const before = centerSlot(long, size)!;
    const broken = validate(long, size, {
      kind: 'text',
      widthRatio: before.widthRatio,
      fittedSize: fitted,
    });
    assert.equal(broken.severity, 'broken');
    const fix = broken.findings.find((f) => f.id === 'center-too-big')!.fix!;
    assert.equal(fix.patch.centerTextSize, fitted);

    const repaired = { ...long, ...fix.patch };
    const after = centerSlot(repaired, size)!;
    assert.equal(
      validate(repaired, size, { kind: 'text', widthRatio: after.widthRatio }).severity,
      'ok',
      'un clic en la corrección debe dejar la pieza verificada',
    );
  }

  // Texto que se funde con su placa: escanea, pero está roto a la vista.
  const faded = validate(design({ centerText: 'ABC', centerTextColor: '#f2f4f7' }), size, {
    kind: 'text',
    widthRatio: 0.1,
  });
  assert.equal(faded.severity, 'warning');
  const fadedFix = faded.findings.find((f) => f.id === 'center-text-illegible')?.fix;
  assert.ok(fadedFix, 'el texto ilegible debe traer corrección');
  const repaired = { ...design({ centerText: 'ABC' }), ...fadedFix!.patch };
  assert.equal(
    validate(repaired, size, { kind: 'text', widthRatio: 0.1 }).findings.length,
    0,
    'la corrección debe dejar el texto legible',
  );

  // Centro sin recorte: aviso con su corrección.
  const noPunch = validate(design({ centerText: 'AB', logoPunchout: false }), size, {
    kind: 'text',
    widthRatio: 0.1,
  });
  assert.equal(noPunch.findings.find((f) => f.id === 'center-no-punchout')?.severity, 'warning');

  // Sin nada en el centro no hay hallazgos de centro.
  assert.equal(validate(design({ centerText: 'AB' }), size, null).findings.length, 0);

  assert.equal(minimumLevelForLogo(0.09), 'L');
  assert.equal(minimumLevelForLogo(0.22), 'H');
  assert.equal(minimumLevelForLogo(0.5), null);

  assert.ok(validate(design({ bgTransparent: true }), size).notes.length === 1);
}

console.log('self-check ok');
