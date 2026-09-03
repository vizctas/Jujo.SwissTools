/*
 * Carga de mallas: STL, OBJ, glTF/GLB y PLY a una lista de mallas planas.
 *
 * Aquí se decide también de dónde sale el color, que es lo que el usuario pidió
 * que se detectara solo. Se mira en este orden, del más fiable al menos:
 *  1. varias mallas o varios materiales en el archivo → cada uno es un color
 *  2. color por vértice → se agrupa por similitud
 *  3. una textura → se muestrea por cara
 *  4. nada → un solo color, el de la pieza
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { Rgb, TriMesh } from './geometry.ts';

export type ColorSource = 'materials' | 'vertices' | 'texture' | 'none';

export interface LoadedPart {
  name: string;
  mesh: TriMesh;
  /** Color plano del material, si el archivo lo trae. */
  color: Rgb | null;
  /** Muestreador de la textura del material, si la hay. */
  sampleTexture: ((u: number, v: number) => Rgb) | null;
}

export interface LoadedModel {
  filename: string;
  format: 'stl' | 'obj' | 'gltf' | 'ply';
  parts: LoadedPart[];
  colorSource: ColorSource;
  /** Lo que el archivo dice de sí mismo que conviene enseñar. */
  notes: string[];
}

export class LoadError extends Error {}

const FORMATS: Record<string, LoadedModel['format']> = {
  stl: 'stl',
  obj: 'obj',
  gltf: 'gltf',
  glb: 'gltf',
  ply: 'ply',
};

export async function loadModel(file: File): Promise<LoadedModel> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const format = FORMATS[extension];
  if (!format) {
    throw new LoadError(`No sé abrir .${extension || '?'}. Vale STL, OBJ, glTF/GLB y PLY.`);
  }

  const buffer = await file.arrayBuffer();
  const notes: string[] = [];
  let root: THREE.Object3D;

  try {
    switch (format) {
      case 'stl': {
        const geometry = new STLLoader().parse(buffer);
        root = new THREE.Mesh(geometry);
        if (geometry.hasAttribute('color')) notes.push('STL con color por triángulo (extensión no estándar).');
        break;
      }
      case 'ply': {
        const geometry = new PLYLoader().parse(buffer);
        root = new THREE.Mesh(geometry);
        break;
      }
      case 'obj': {
        const text = new TextDecoder().decode(buffer);
        root = new OBJLoader().parse(text);
        if (/^mtllib/m.test(text)) {
          notes.push('El OBJ referencia un .mtl que no se ha cargado: los colores de material no están disponibles.');
        }
        break;
      }
      case 'gltf': {
        const gltf = await new GLTFLoader().parseAsync(buffer, '');
        root = gltf.scene;
        // glTF es Y arriba; la impresión 3D es Z arriba. Se gira al entrar.
        root.rotation.x = Math.PI / 2;
        break;
      }
    }
  } catch (error) {
    throw new LoadError(`El archivo no se pudo leer: ${String((error as Error)?.message ?? error)}`);
  }

  root.updateMatrixWorld(true);
  const parts: LoadedPart[] = [];
  let anyVertexColor = false;
  let anyTexture = false;
  let materialCount = 0;

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = (object.geometry as THREE.BufferGeometry).clone();
    geometry.applyMatrix4(object.matrixWorld);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const groups = geometry.groups.length > 0 && Array.isArray(object.material)
      ? geometry.groups
      : [{ start: 0, count: Infinity, materialIndex: 0 }];

    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0] as THREE.Material | undefined;
      const mesh = toTriMesh(geometry, group.start, group.count);
      if (mesh.indices.length === 0) continue;
      if (mesh.colors) anyVertexColor = true;
      const color = materialColor(material);
      const sampler = textureSampler(material);
      if (sampler && mesh.uvs) anyTexture = true;
      materialCount += 1;
      parts.push({
        name: object.name || material?.name || `Objeto ${parts.length + 1}`,
        mesh,
        color,
        sampleTexture: sampler,
      });
    }
  });

  if (parts.length === 0) throw new LoadError('El archivo no contiene ningún modelo.');

  const colorSource: ColorSource =
    materialCount > 1 ? 'materials' : anyVertexColor ? 'vertices' : anyTexture ? 'texture' : 'none';

  return { filename: file.name, format, parts, colorSource, notes };
}

function toTriMesh(geometry: THREE.BufferGeometry, start: number, count: number): TriMesh {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const color = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const index = geometry.getIndex();

  const total = index ? index.count : position.count;
  const end = Math.min(total, start + count);
  const indices = new Uint32Array(end - start);
  for (let i = start; i < end; i += 1) {
    indices[i - start] = index ? index.getX(i) : i;
  }

  return {
    positions: new Float32Array(position.array as ArrayLike<number>),
    indices,
    colors: color ? new Float32Array(color.array as ArrayLike<number>).subarray(0, position.count * 3) : undefined,
    uvs: uv ? new Float32Array(uv.array as ArrayLike<number>) : undefined,
  };
}

function materialColor(material: THREE.Material | undefined): Rgb | null {
  const withColor = material as (THREE.Material & { color?: THREE.Color }) | undefined;
  if (!withColor?.color) return null;
  const c = withColor.color;
  // Un material blanco puro es el color por defecto, no una decisión: no cuenta.
  if (c.r > 0.98 && c.g > 0.98 && c.b > 0.98) return null;
  return [c.r, c.g, c.b];
}

function textureSampler(material: THREE.Material | undefined): ((u: number, v: number) => Rgb) | null {
  const map = (material as (THREE.Material & { map?: THREE.Texture }) | undefined)?.map;
  const image = map?.image as (HTMLImageElement | ImageBitmap | HTMLCanvasElement) | undefined;
  if (!image || !('width' in image) || image.width === 0) return null;

  // Muestrear una textura de 4K por cada triángulo pixel a pixel sería lento; a
  // 256 px de lado el color de un material se distingue igual y cabe en memoria.
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(image as CanvasImageSource, 0, 0, size, size);
  } catch {
    return null;
  }
  const pixels = context.getImageData(0, 0, size, size).data;
  const flipY = map?.flipY ?? true;
  return (u, v) => {
    const x = Math.min(size - 1, Math.max(0, Math.floor(u * size)));
    const yy = flipY ? 1 - v : v;
    const y = Math.min(size - 1, Math.max(0, Math.floor(yy * size)));
    const at = (y * size + x) * 4;
    return [pixels[at]! / 255, pixels[at + 1]! / 255, pixels[at + 2]! / 255];
  };
}
