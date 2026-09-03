export type Vec3 = [number, number, number];

/**
 * Volúmenes de impresión de fábrica, en mm (X × Y × Z). «A medida» es cualquier
 * otro valor. Ordenadas por marca y de menor a mayor, que es como se buscan.
 */
export const PRINTERS: ReadonlyArray<{ id: string; label: string; size: Vec3 }> = [
  { id: 'bambu-a1mini', label: 'Bambu Lab A1 mini', size: [180, 180, 180] },
  { id: 'bambu-a1', label: 'Bambu Lab A1', size: [256, 256, 256] },
  { id: 'bambu-p1', label: 'Bambu Lab P1P · P1S', size: [256, 256, 256] },
  { id: 'bambu-x1c', label: 'Bambu Lab X1C · X1E', size: [256, 256, 256] },
  { id: 'bambu-h2d', label: 'Bambu Lab H2D', size: [350, 320, 325] },
  { id: 'creality-ender3', label: 'Creality Ender 3 · V2 · V3 SE', size: [220, 220, 250] },
  { id: 'creality-ender3-s1', label: 'Creality Ender 3 S1 · V3 KE', size: [220, 220, 270] },
  { id: 'creality-k1', label: 'Creality K1 · K1C', size: [220, 220, 250] },
  { id: 'creality-k1max', label: 'Creality K1 Max', size: [300, 300, 300] },
  { id: 'creality-ender5', label: 'Creality Ender 5 Plus', size: [350, 350, 400] },
  { id: 'anycubic-kobra2', label: 'Anycubic Kobra 2 · Neo · Go', size: [220, 220, 250] },
  { id: 'anycubic-kobra3', label: 'Anycubic Kobra 3', size: [250, 250, 260] },
  { id: 'anycubic-kobra2plus', label: 'Anycubic Kobra 2 Plus', size: [320, 320, 400] },
  { id: 'anycubic-kobra2max', label: 'Anycubic Kobra 2 Max', size: [420, 420, 500] },
  { id: 'prusa-mini', label: 'Prusa MINI+', size: [180, 180, 180] },
  { id: 'prusa-mk3s', label: 'Prusa MK3S+', size: [250, 210, 210] },
  { id: 'prusa-mk4', label: 'Prusa MK4 · MK4S', size: [250, 210, 220] },
  { id: 'prusa-core-one', label: 'Prusa CORE One', size: [250, 220, 270] },
  { id: 'prusa-xl', label: 'Prusa XL', size: [360, 360, 360] },
  { id: 'elegoo-neptune4', label: 'Elegoo Neptune 4 · 4 Pro', size: [225, 225, 265] },
  { id: 'elegoo-neptune4max', label: 'Elegoo Neptune 4 Max', size: [420, 420, 480] },
  { id: 'elegoo-centauri', label: 'Elegoo Centauri Carbon', size: [256, 256, 256] },
  { id: 'sovol-sv06', label: 'Sovol SV06', size: [220, 220, 250] },
  { id: 'sovol-sv08', label: 'Sovol SV08', size: [350, 350, 345] },
  { id: 'flashforge-ad5m', label: 'Flashforge Adventurer 5M', size: [220, 220, 220] },
  { id: 'qidi-q1pro', label: 'QIDI Q1 Pro', size: [245, 245, 240] },
  { id: 'voron-24-350', label: 'Voron 2.4 350', size: [350, 350, 340] },
];
