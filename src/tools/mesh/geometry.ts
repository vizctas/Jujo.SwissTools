/*
 * Geometría pura del taller de mallas. Sin DOM, sin three, sin WASM.
 *
 * Todo lo que aquí vive trabaja sobre dos arrays planos —posiciones e índices—
 * porque es lo que entienden a la vez three.js, Manifold y el self-check de Node.
 *
 * Lo que decide esta capa:
 *  - qué es un objeto: una isla de triángulos conectados por aristas (detección)
 *  - qué está roto: aristas de borde (agujeros) y aristas con más de dos caras
 *  - cómo se cierra un agujero simple: abanico sobre su bucle de borde
 *  - de dónde sale el color y cómo se agrupan las caras por él
 */

export interface TriMesh {
  /** xyz por vértice. */
  positions: Float32Array;
  /** tres índices por triángulo. */
  indices: Uint32Array;
  /** rgb 0–1 por vértice, si los hay. */
  colors?: Float32Array;
  /** uv por vértice, si los hay. */
  uvs?: Float32Array;
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
  center: [number, number, number];
}

export function bounds(positions: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      const v = positions[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  if (!Number.isFinite(min[0])) {
    return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  }
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return {
    min,
    max,
    size,
    center: [min[0] + size[0] / 2, min[1] + size[1] / 2, min[2] + size[2] / 2],
  };
}

/* --------------------------------------------------------------- Soldadura */

/**
 * Funde vértices que ocupan el mismo punto. Casi todos los STL vienen con cada
 * triángulo llevando sus tres vértices propios: sin esto, nada está conectado
 * con nada y toda la malla parecería miles de objetos sueltos.
 *
 * `tolerance` en unidades de la malla. Se cuantiza a una rejilla, que es O(n) y
 * suficiente: los duplicados de un STL son exactos, no aproximados.
 */
export function weld(mesh: TriMesh, tolerance = 1e-5): TriMesh {
  const { positions, indices, colors, uvs } = mesh;
  const count = positions.length / 3;
  const remap = new Uint32Array(count);
  const keep: number[] = [];
  const seen = new Map<string, number>();
  const q = 1 / tolerance;

  for (let v = 0; v < count; v += 1) {
    const key = `${Math.round(positions[v * 3]! * q)},${Math.round(positions[v * 3 + 1]! * q)},${Math.round(positions[v * 3 + 2]! * q)}`;
    const found = seen.get(key);
    if (found === undefined) {
      seen.set(key, keep.length);
      remap[v] = keep.length;
      keep.push(v);
    } else {
      remap[v] = found;
    }
  }

  const outPositions = new Float32Array(keep.length * 3);
  const outColors = colors ? new Float32Array(keep.length * 3) : undefined;
  const outUvs = uvs ? new Float32Array(keep.length * 2) : undefined;
  keep.forEach((v, i) => {
    outPositions.set(positions.subarray(v * 3, v * 3 + 3), i * 3);
    if (colors && outColors) outColors.set(colors.subarray(v * 3, v * 3 + 3), i * 3);
    if (uvs && outUvs) outUvs.set(uvs.subarray(v * 2, v * 2 + 2), i * 2);
  });

  // Los triángulos que se colapsan al soldar se descartan aquí mismo.
  const outIndices: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]!]!;
    const b = remap[indices[t + 1]!]!;
    const c = remap[indices[t + 2]!]!;
    if (a === b || b === c || a === c) continue;
    outIndices.push(a, b, c);
  }

  return {
    positions: outPositions,
    indices: new Uint32Array(outIndices),
    colors: outColors,
    uvs: outUvs,
  };
}

/* --------------------------------------------------------------- Topología */

export interface Topology {
  /** Aristas con una sola cara: el contorno de un agujero. */
  boundaryEdges: number;
  /** Aristas con más de dos caras: no-manifold, imposible de imprimir tal cual. */
  nonManifoldEdges: number;
  /** Bucles cerrados de borde: cuántos agujeros hay, no cuántas aristas. */
  holes: number[][];
  watertight: boolean;
}

function edgeKey(a: number, b: number): number {
  // Orden-independiente y sin strings: cabe en un Map<number>.
  return a < b ? a * 4294967296 + b : b * 4294967296 + a;
}

export function topology(mesh: TriMesh): Topology {
  const { indices } = mesh;
  const count = new Map<number, number>();
  const bump = (a: number, b: number): void => {
    const key = edgeKey(a, b);
    count.set(key, (count.get(key) ?? 0) + 1);
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
    bump(a, b);
    bump(b, c);
    bump(c, a);
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  // Las aristas de borde con su dirección tal como aparecen en su única cara:
  // así los bucles salen orientados igual que la malla y el relleno no se invierte.
  const next = new Map<number, number>();
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    for (let e = 0; e < 3; e += 1) {
      const a = tri[e]!;
      const b = tri[(e + 1) % 3]!;
      const n = count.get(edgeKey(a, b)) ?? 0;
      if (n === 1) {
        boundaryEdges += 1;
        next.set(a, b);
      } else if (n > 2 && e === 0) {
        nonManifoldEdges += 1;
      }
    }
  }

  // Encadenar aristas de borde en bucles.
  const holes: number[][] = [];
  const visited = new Set<number>();
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const loop: number[] = [];
    let current: number | undefined = start;
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      loop.push(current);
      current = next.get(current);
    }
    if (loop.length >= 3 && current === start) holes.push(loop);
  }

  return {
    boundaryEdges,
    nonManifoldEdges,
    holes,
    watertight: boundaryEdges === 0 && nonManifoldEdges === 0,
  };
}

/**
 * Cierra agujeros con un abanico desde el primer vértice del bucle.
 *
 * ponytail: correcto para bucles planos y convexos —la tapa de un STL exportado a
 * medias, un fondo sin cerrar—, que son los de siempre. Un agujero con forma de
 * estrella o retorcido sale con caras cruzadas; la interfaz avisa de cuáles se
 * cerraron y cuáles no, y el usuario decide.
 */
export function fillHoles(mesh: TriMesh, holes: number[][], maxLoop = 200): {
  mesh: TriMesh;
  filled: number;
  skipped: number;
} {
  const added: number[] = [];
  let filled = 0;
  let skipped = 0;
  for (const loop of holes) {
    if (loop.length > maxLoop) {
      skipped += 1;
      continue;
    }
    // El bucle recorre el borde en el sentido de sus caras; la tapa va al revés
    // para que su normal mire hacia fuera igual que las vecinas.
    const root = loop[0]!;
    for (let i = loop.length - 1; i >= 2; i -= 1) {
      added.push(root, loop[i]!, loop[i - 1]!);
    }
    filled += 1;
  }
  const indices = new Uint32Array(mesh.indices.length + added.length);
  indices.set(mesh.indices);
  indices.set(added, mesh.indices.length);
  return { mesh: { ...mesh, indices }, filled, skipped };
}

/* ------------------------------------------------------------ Componentes */

/**
 * Islas de triángulos: dos caras están en la misma isla si comparten un vértice.
 * Devuelve, por triángulo, el id de su isla. Es la detección de objetos.
 */
export function components(mesh: TriMesh): { labels: Int32Array; count: number } {
  const { indices } = mesh;
  const triCount = indices.length / 3;
  const vertexCount = mesh.positions.length / 3;
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let t = 0; t < indices.length; t += 3) {
    union(indices[t]!, indices[t + 1]!);
    union(indices[t + 1]!, indices[t + 2]!);
  }
  const ids = new Map<number, number>();
  const labels = new Int32Array(triCount);
  for (let t = 0; t < triCount; t += 1) {
    const root = find(indices[t * 3]!);
    let id = ids.get(root);
    if (id === undefined) {
      id = ids.size;
      ids.set(root, id);
    }
    labels[t] = id;
  }
  return { labels, count: ids.size };
}

/** Extrae los triángulos etiquetados con `label` en una malla propia y compacta. */
export function extract(mesh: TriMesh, labels: Int32Array, label: number): TriMesh {
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const take = (v: number): number => {
    let mapped = remap.get(v);
    if (mapped === undefined) {
      mapped = positions.length / 3;
      remap.set(v, mapped);
      positions.push(mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!);
      if (mesh.colors) colors.push(mesh.colors[v * 3]!, mesh.colors[v * 3 + 1]!, mesh.colors[v * 3 + 2]!);
      if (mesh.uvs) uvs.push(mesh.uvs[v * 2]!, mesh.uvs[v * 2 + 1]!);
    }
    return mapped;
  };
  for (let t = 0; t < labels.length; t += 1) {
    if (labels[t] !== label) continue;
    indices.push(take(mesh.indices[t * 3]!), take(mesh.indices[t * 3 + 1]!), take(mesh.indices[t * 3 + 2]!));
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    colors: mesh.colors ? new Float32Array(colors) : undefined,
    uvs: mesh.uvs ? new Float32Array(uvs) : undefined,
  };
}

/* ------------------------------------------------------------------ Color */

export type Rgb = [number, number, number];

/**
 * Agrupa colores por cara en unos pocos representantes. Cuantización por rejilla
 * en vez de k-means: determinista, sin iteraciones, y para colores de impresión
 * —que son planos por naturaleza— da lo mismo que un método más caro.
 *
 * `levels` divide cada canal; 6 niveles distinguen 216 colores, más que suficiente
 * para separar materiales y menos que suficiente para partir un degradado en mil
 * trozos, que es el fallo que hay que evitar.
 */
export function clusterFaceColors(
  faceColors: Float32Array,
  levels = 6,
): { labels: Int32Array; palette: Rgb[] } {
  const triCount = faceColors.length / 3;
  const labels = new Int32Array(triCount);
  const ids = new Map<number, number>();
  const sums: number[][] = [];
  const counts: number[] = [];
  for (let t = 0; t < triCount; t += 1) {
    const r = faceColors[t * 3]!;
    const g = faceColors[t * 3 + 1]!;
    const b = faceColors[t * 3 + 2]!;
    const key =
      Math.min(levels - 1, Math.floor(r * levels)) * levels * levels +
      Math.min(levels - 1, Math.floor(g * levels)) * levels +
      Math.min(levels - 1, Math.floor(b * levels));
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
      sums.push([0, 0, 0]);
      counts.push(0);
    }
    labels[t] = id;
    const sum = sums[id]!;
    sum[0] = sum[0]! + r;
    sum[1] = sum[1]! + g;
    sum[2] = sum[2]! + b;
    counts[id] = counts[id]! + 1;
  }
  const palette = sums.map((s, i): Rgb => [s[0]! / counts[i]!, s[1]! / counts[i]!, s[2]! / counts[i]!]);
  return { labels, palette };
}

/** Color medio de cada cara a partir del color por vértice. */
export function faceColorsFromVertices(mesh: TriMesh): Float32Array | null {
  if (!mesh.colors) return null;
  const triCount = mesh.indices.length / 3;
  const out = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t += 1) {
    for (let c = 0; c < 3; c += 1) {
      const v = mesh.indices[t * 3 + c]!;
      out[t * 3] = out[t * 3]! + mesh.colors[v * 3]! / 3;
      out[t * 3 + 1] = out[t * 3 + 1]! + mesh.colors[v * 3 + 1]! / 3;
      out[t * 3 + 2] = out[t * 3 + 2]! + mesh.colors[v * 3 + 2]! / 3;
    }
  }
  return out;
}

/**
 * Color de cada cara muestreando una textura en el centroide UV. `sample` lo da
 * quien tenga la imagen (un canvas en el hilo principal); aquí solo se calcula
 * dónde mirar.
 */
export function faceColorsFromTexture(
  mesh: TriMesh,
  sample: (u: number, v: number) => Rgb,
): Float32Array | null {
  if (!mesh.uvs) return null;
  const triCount = mesh.indices.length / 3;
  const out = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t += 1) {
    let u = 0;
    let v = 0;
    for (let c = 0; c < 3; c += 1) {
      const vi = mesh.indices[t * 3 + c]!;
      u += mesh.uvs[vi * 2]! / 3;
      v += mesh.uvs[vi * 2 + 1]! / 3;
    }
    const rgb = sample(u - Math.floor(u), v - Math.floor(v));
    out[t * 3] = rgb[0];
    out[t * 3 + 1] = rgb[1];
    out[t * 3 + 2] = rgb[2];
  }
  return out;
}

/** Combina dos etiquetados: misma isla Y mismo color. */
export function combineLabels(a: Int32Array, b: Int32Array): { labels: Int32Array; count: number } {
  const ids = new Map<number, number>();
  const labels = new Int32Array(a.length);
  for (let t = 0; t < a.length; t += 1) {
    const key = a[t]! * 1_000_003 + b[t]!;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    labels[t] = id;
  }
  return { labels, count: ids.size };
}

/* ---------------------------------------------------------------- Medidas */

/** Volumen con signo por el teorema de la divergencia. Negativo = normales hacia dentro. */
export function signedVolume(mesh: TriMesh): number {
  const p = mesh.positions;
  const i = mesh.indices;
  let sum = 0;
  for (let t = 0; t < i.length; t += 3) {
    const a = i[t]! * 3;
    const b = i[t + 1]! * 3;
    const c = i[t + 2]! * 3;
    sum +=
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
      p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
      p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return sum / 6;
}

/** Invierte la orientación de todas las caras. */
export function flip(mesh: TriMesh): TriMesh {
  const indices = new Uint32Array(mesh.indices.length);
  for (let t = 0; t < indices.length; t += 3) {
    indices[t] = mesh.indices[t]!;
    indices[t + 1] = mesh.indices[t + 2]!;
    indices[t + 2] = mesh.indices[t + 1]!;
  }
  return { ...mesh, indices };
}

/** Cuántos cortes hacen falta por eje para que la caja quepa en el volumen. */
export function splitPlan(size: [number, number, number], volume: [number, number, number]): number[] {
  return size.map((s, axis) => Math.max(0, Math.ceil(s / volume[axis]!) - 1));
}
