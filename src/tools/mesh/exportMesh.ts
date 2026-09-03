/*
 * Exportación de piezas.
 *
 * STL binario y OBJ se escriben a mano: son formatos de dos líneas y así la
 * salida no depende de que three.js siga exportando igual. 3MF es lo que
 * entienden los slicers modernos con colores y varias piezas en un archivo, y
 * es solo un ZIP con XML dentro — el ZIP también va a mano, en modo almacenado,
 * porque un archivo de contenedor no necesita comprimir para ser válido.
 */

import type { TriMesh } from './geometry.ts';

export interface ExportPiece {
  name: string;
  mesh: TriMesh;
  /** rgb 0–1; en 3MF se guarda como color de material. */
  color: [number, number, number] | null;
}

/* ------------------------------------------------------------------- STL */

export function toStl(pieces: ExportPiece[]): Blob {
  const triangles = pieces.reduce((sum, piece) => sum + piece.mesh.indices.length / 3, 0);
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  const header = new TextEncoder().encode('Jujo.SwissTools taller de mallas');
  new Uint8Array(buffer, 0, 80).set(header.subarray(0, 80));
  view.setUint32(80, triangles, true);

  let at = 84;
  for (const { mesh } of pieces) {
    const p = mesh.positions;
    const i = mesh.indices;
    for (let t = 0; t < i.length; t += 3) {
      const a = i[t]! * 3;
      const b = i[t + 1]! * 3;
      const c = i[t + 2]! * 3;
      const ux = p[b]! - p[a]!;
      const uy = p[b + 1]! - p[a + 1]!;
      const uz = p[b + 2]! - p[a + 2]!;
      const vx = p[c]! - p[a]!;
      const vy = p[c + 1]! - p[a + 1]!;
      const vz = p[c + 2]! - p[a + 2]!;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      view.setFloat32(at, nx, true);
      view.setFloat32(at + 4, ny, true);
      view.setFloat32(at + 8, nz, true);
      for (const [k, base] of [a, b, c].entries()) {
        view.setFloat32(at + 12 + k * 12, p[base]!, true);
        view.setFloat32(at + 16 + k * 12, p[base + 1]!, true);
        view.setFloat32(at + 20 + k * 12, p[base + 2]!, true);
      }
      view.setUint16(at + 48, 0, true);
      at += 50;
    }
  }
  return new Blob([buffer], { type: 'model/stl' });
}

/* ------------------------------------------------------------------- OBJ */

export function toObj(pieces: ExportPiece[]): Blob {
  const lines: string[] = ['# Jujo.SwissTools taller de mallas'];
  let offset = 1;
  for (const { name, mesh } of pieces) {
    lines.push(`o ${name.replace(/\s+/g, '_')}`);
    const p = mesh.positions;
    for (let v = 0; v < p.length; v += 3) {
      lines.push(`v ${fmt(p[v]!)} ${fmt(p[v + 1]!)} ${fmt(p[v + 2]!)}`);
    }
    const i = mesh.indices;
    for (let t = 0; t < i.length; t += 3) {
      lines.push(`f ${i[t]! + offset} ${i[t + 1]! + offset} ${i[t + 2]! + offset}`);
    }
    offset += p.length / 3;
  }
  return new Blob([lines.join('\n')], { type: 'model/obj' });
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(5).replace(/\.?0+$/, '');
}

/* ------------------------------------------------------------------- 3MF */

export function to3mf(pieces: ExportPiece[], unit: 'millimeter' | 'inch' = 'millimeter'): Blob {
  const materials = pieces
    .map((piece, index) =>
      piece.color
        ? `<m:color color="${hex(piece.color)}" />`.replace('<m:color', `<m:color id="${index}"`)
        : null,
    )
    .filter((x): x is string => x !== null);

  const objects = pieces.map((piece, index) => {
    const p = piece.mesh.positions;
    const i = piece.mesh.indices;
    const vertices: string[] = [];
    for (let v = 0; v < p.length; v += 3) {
      vertices.push(`<vertex x="${fmt(p[v]!)}" y="${fmt(p[v + 1]!)}" z="${fmt(p[v + 2]!)}"/>`);
    }
    const triangles: string[] = [];
    for (let t = 0; t < i.length; t += 3) {
      triangles.push(`<triangle v1="${i[t]}" v2="${i[t + 1]}" v3="${i[t + 2]}"/>`);
    }
    const material = piece.color ? ` pid="1" pindex="${index}"` : '';
    return `<object id="${index + 2}" name="${escapeXml(piece.name)}" type="model"${material}><mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh></object>`;
  });

  const items = pieces.map((_, index) => `<item objectid="${index + 2}"/>`).join('');
  const colorGroup =
    materials.length > 0
      ? `<m:colorgroup id="1">${pieces.map((piece) => `<m:color color="${hex(piece.color ?? [0.8, 0.8, 0.8])}"/>`).join('')}</m:colorgroup>`
      : '';

  const model =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="${unit}" xml:lang="es" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">` +
    `<metadata name="Application">Jujo.SwissTools</metadata>` +
    `<resources>${colorGroup}${objects.join('')}</resources>` +
    `<build>${items}</build></model>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

  return zip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rels],
    ['3D/3dmodel.model', model],
  ]);
}

function hex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------- ZIP */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP en modo almacenado. Suficiente para 3MF y sin ninguna dependencia. */
function zip(entries: [name: string, content: string][]): Blob {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // nombres en UTF-8
    local.setUint16(8, 0, true); // almacenado
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  // Un único buffer contiguo: más simple de tipar y de leer que una lista de trozos.
  const chunks = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(new ArrayBuffer(chunks.reduce((sum, chunk) => sum + chunk.length, 0)));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return new Blob([out], { type: 'model/3mf' });
}

/* ------------------------------------------------------------------ Guardar */

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function safeName(base: string): string {
  return base
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48) || 'pieza';
}
