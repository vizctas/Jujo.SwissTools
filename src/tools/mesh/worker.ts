/// <reference lib="webworker" />
/*
 * Manifold, en un hilo aparte.
 *
 * Una booleana sobre una malla de 500 000 triángulos tarda segundos; en el hilo
 * principal eso es una mesa congelada a mitad de arrastre. Aquí las operaciones
 * caras van en serie en un worker, y el plano se puede seguir moviendo mientras.
 *
 * Manifold exige mallas cerradas y orientadas: eso no es una limitación a
 * esquivar, es la garantía de que lo que sale imprime. Lo que no está cerrado se
 * repara antes, en el hilo principal, con la geometría pura.
 */

import { applyJoint, frame, planJoint } from './joints.ts';
import type { JointReport, JointSpec, MeshWorkerRequest, MeshWorkerResponse, Plane, WireMesh } from './protocol.ts';

type ManifoldModule = Awaited<ReturnType<typeof import('manifold-3d').default>>;
type ManifoldInstance = InstanceType<ManifoldModule['Manifold']>;

const post = (message: MeshWorkerResponse, transfer?: Transferable[]): void => {
  (self as unknown as Worker).postMessage(message, transfer ?? []);
};

let wasm: ManifoldModule | null = null;
let booting: Promise<void> | null = null;

async function boot(): Promise<void> {
  if (wasm) return;
  const { default: Module } = await import('manifold-3d');
  const wasmUrl = new URL('manifold-3d/manifold.wasm', import.meta.url).href;
  wasm = await Module({ locateFile: () => wasmUrl });
  wasm.setup();
}

/* ------------------------------------------------------------ Conversión */

function toManifold(mesh: WireMesh): ManifoldInstance {
  if (!wasm) throw new Error('Manifold no está cargado.');
  const wire = new wasm.Mesh({
    numProp: 3,
    vertProperties: mesh.positions,
    triVerts: mesh.indices,
  });
  // Funde los vértices coincidentes y calcula los vectores de unión que Manifold
  // necesita para ver una única superficie en vez de triángulos sueltos.
  wire.merge();
  const manifold = wasm.Manifold.ofMesh(wire);
  const status = manifold.status();
  if (status !== 'NoError') {
    manifold.delete();
    throw new Error(describeStatus(status));
  }
  return manifold;
}

function describeStatus(status: string): string {
  switch (status) {
    case 'NotManifold':
      return 'El modelo no está cerrado: tiene agujeros o aristas compartidas por más de dos caras. Repáralo antes de cortar.';
    case 'NonFiniteVertex':
      return 'El modelo tiene vértices con coordenadas inválidas (NaN o infinito).';
    case 'VertexOutOfBounds':
    case 'PropertiesWrongLength':
    case 'MissingPositionProperties':
      return 'La estructura del modelo no cuadra: índices fuera de rango o propiedades incompletas.';
    default:
      return `Manifold rechazó el modelo (${status}).`;
  }
}

function toWire(manifold: ManifoldInstance): WireMesh {
  const mesh = manifold.getMesh();
  // getMesh puede devolver más propiedades por vértice (normales); solo se quiere xyz.
  const stride = mesh.numProp;
  const count = mesh.vertProperties.length / stride;
  const positions = new Float32Array(count * 3);
  for (let v = 0; v < count; v += 1) {
    positions[v * 3] = mesh.vertProperties[v * stride]!;
    positions[v * 3 + 1] = mesh.vertProperties[v * stride + 1]!;
    positions[v * 3 + 2] = mesh.vertProperties[v * stride + 2]!;
  }
  return { positions, indices: new Uint32Array(mesh.triVerts) };
}

function transferables(meshes: WireMesh[]): Transferable[] {
  return meshes.flatMap((mesh) => [mesh.positions.buffer, mesh.indices.buffer]);
}

/* -------------------------------------------------------------- Operaciones */

interface CutResult {
  pieces: ManifoldInstance[];
  pins: ManifoldInstance[];
  joints: JointReport[];
}

/**
 * Parte un sólido por un plano. Con `joint`, decide y aplica la unión sobre la
 * sección real del corte. Consume `manifold`.
 */
function cutOnce(manifold: ManifoldInstance, plane: Plane, joint: JointSpec | null): CutResult {
  if (!wasm) throw new Error('Manifold no está cargado.');
  const { forward, back } = frame(plane.normal);
  const aligned = forward(manifold);
  manifold.delete();

  const [above, below] = aligned.splitByPlane([0, 0, 1], plane.offset);
  if (above.isEmpty() || below.isEmpty()) {
    // El plano no atraviesa la pieza: no hay corte que hacer.
    above.delete();
    below.delete();
    const restored = back(aligned);
    aligned.delete();
    return { pieces: [restored], pins: [], joints: [] };
  }

  let result = { above, below, pins: [] as ManifoldInstance[] };
  const joints: JointReport[] = [];
  if (joint) {
    const thickness = {
      above: above.boundingBox().max[2] - plane.offset,
      below: plane.offset - below.boundingBox().min[2],
    };
    const { plan, report } = planJoint(wasm, aligned, plane.offset, joint, thickness);
    joints.push(report);
    if (plan) result = applyJoint(wasm, above, below, plane.offset, plan, joint.clearance);
  }
  aligned.delete();

  const restore = (m: ManifoldInstance): ManifoldInstance => {
    const r = back(m);
    m.delete();
    return r;
  };
  return {
    pieces: [restore(result.above), restore(result.below)],
    pins: result.pins.map(restore),
    joints,
  };
}

function autosplit(
  manifold: ManifoldInstance,
  volume: [number, number, number],
  joint: JointSpec | null,
): CutResult {
  let pieces = [manifold];
  const pins: ManifoldInstance[] = [];
  const joints: JointReport[] = [];
  // Eje a eje: cada rebanada que aún no cabe se vuelve a partir por el plano medio.
  for (let axis = 0; axis < 3; axis += 1) {
    const normal: [number, number, number] = [0, 0, 0];
    normal[axis] = 1;
    let changed = true;
    let guard = 0;
    while (changed && guard < 32) {
      changed = false;
      guard += 1;
      const next: ManifoldInstance[] = [];
      for (const piece of pieces) {
        const box = piece.boundingBox();
        const size = box.max[axis]! - box.min[axis]!;
        if (size <= volume[axis]! * 0.999) {
          next.push(piece);
          continue;
        }
        const mid = (box.min[axis]! + box.max[axis]!) / 2;
        const result = cutOnce(piece, { normal, offset: mid }, joint);
        next.push(...result.pieces);
        pins.push(...result.pins);
        joints.push(...result.joints);
        changed = result.pieces.length > 1;
      }
      pieces = next;
    }
  }
  return { pieces, pins, joints };
}

function withBase(manifold: ManifoldInstance, height: number, margin: number): ManifoldInstance {
  if (!wasm) throw new Error('Manifold no está cargado.');
  const box = manifold.boundingBox();
  const sx = box.max[0] - box.min[0] + margin * 2;
  const sy = box.max[1] - box.min[1] + margin * 2;
  // Z es arriba, como en STL y 3MF: la base va bajo la pieza y se solapa un pelo
  // con ella para que la unión no deje una costura.
  const base = wasm.Manifold.cube([sx, sy, height], false).translate([
    box.min[0] - margin,
    box.min[1] - margin,
    box.min[2] - height + Math.min(height, 0.2),
  ]);
  const joined = manifold.add(base);
  base.delete();
  manifold.delete();
  return joined;
}

function postPieces(id: string, result: CutResult): void {
  const wires = result.pieces.map(toWire);
  const pinWires = result.pins.map(toWire);
  for (const p of [...result.pieces, ...result.pins]) p.delete();
  post(
    { t: 'pieces', id, pieces: wires, pins: pinWires, joints: result.joints },
    transferables([...wires, ...pinWires]),
  );
}

/* ------------------------------------------------------------------ Cola */

async function handle(message: MeshWorkerRequest): Promise<void> {
  if (message.t === 'init') {
    try {
      booting ??= boot();
      await booting;
      post({ t: 'ready', version: '3.5' });
    } catch (error) {
      post({ t: 'init-failed', message: String((error as Error)?.message ?? error) });
    }
    return;
  }

  try {
    booting ??= boot();
    await booting;
    switch (message.t) {
      case 'analyze': {
        const m = toManifold(message.mesh);
        post({
          t: 'stats',
          id: message.id,
          stats: {
            volume: m.volume(),
            surfaceArea: m.surfaceArea(),
            genus: m.genus(),
            triangles: m.numTri(),
            vertices: m.numVert(),
          },
        });
        m.delete();
        break;
      }
      case 'cut':
        postPieces(message.id, cutOnce(toManifold(message.mesh), message.plane, message.joint));
        break;
      case 'autosplit':
        postPieces(message.id, autosplit(toManifold(message.mesh), message.volume, message.joint));
        break;
      case 'base': {
        const joined = withBase(toManifold(message.mesh), message.height, message.margin);
        const wire = toWire(joined);
        joined.delete();
        post({ t: 'mesh', id: message.id, mesh: wire }, transferables([wire]));
        break;
      }
      default:
        break;
    }
  } catch (error) {
    post({ t: 'failed', id: (message as { id: string }).id, message: String((error as Error)?.message ?? error) });
  }
}

/** En serie: Manifold no es reentrante y la GPU no interviene, así que no hay prisa que ganar. */
let chain = Promise.resolve();
self.addEventListener('message', (event: MessageEvent<MeshWorkerRequest>) => {
  const message = event.data;
  chain = chain.then(() => handle(message));
});
