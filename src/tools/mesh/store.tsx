/*
 * Estado del taller de mallas.
 *
 * Dos capas con ritmos distintos: la geometría pura (soldar, islas, agujeros)
 * corre en el hilo principal porque es lineal y termina antes de que el spinner
 * llegue a pintarse; las booleanas (cortar, espigas, base) van a Manifold en un
 * worker porque tardan segundos y el visor tiene que seguir girando mientras.
 *
 * Cada pieza es una malla independiente con su topología calculada: la mesa
 * enseña de un vistazo cuál imprime y cuál no, sin volver a preguntar.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { safeName, saveBlob, to3mf, toObj, toStl, type ExportPiece } from './exportMesh.ts';
import {
  bounds,
  clusterFaceColors,
  components,
  extract,
  faceColorsFromTexture,
  faceColorsFromVertices,
  fillHoles,
  flip,
  signedVolume,
  topology,
  weld,
  type Bounds,
  type Rgb,
  type TriMesh,
  type Topology,
} from './geometry.ts';
import { LoadError, loadModel, type ColorSource } from './load.ts';
import { orient, outlineBounds, planeBasis, projectBox, toPlane, type Basis, type Vec2 } from './plane.ts';
import { PRINTERS, type Vec3 } from './printers.ts';
import type {
  Appendage,
  CutWindow,
  JointMode,
  JointReport,
  JointShape,
  JointSpec,
  MeshStats,
  MeshWorkerRequest,
  MeshWorkerResponse,
  Plane,
} from './protocol.ts';

export type PartOrigin = 'file' | 'island' | 'color' | 'cut' | 'pin';

export interface Part {
  id: string;
  name: string;
  mesh: TriMesh;
  color: Rgb;
  origin: PartOrigin;
  bounds: Bounds;
  topology: Topology;
  /** Volumen por divergencia; sirve aunque la malla no sea estanca. */
  volumeHint: number;
  /** Lo que dice Manifold, cuando la malla es cerrada. */
  stats: MeshStats | null;
  statsError: string | null;
  /** Muestreador de textura heredado del archivo, para separar por color. */
  sampler: ((u: number, v: number) => Rgb) | null;
  /**
   * El objeto del archivo del que desciende la pieza, con su nombre y dónde
   * estaba su centro. Las piezas de un corte se separan de ese centro, no del
   * de la escena, y se agrupan bajo él en la lista.
   */
  family: { id: string; name: string; center: Vec3 };
}

export interface ModelInfo {
  filename: string;
  format: string;
  colorSource: ColorSource;
  notes: string[];
}

export type EngineStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string };

export type Axis = 'x' | 'y' | 'z';

export interface CutState {
  /** Normal unitaria del plano, en coordenadas de la pieza. Los ejes son un caso particular. */
  normal: Vec3;
  /** Fracción 0–1 a lo largo de la normal, entre el mínimo y el máximo de la pieza proyectada. */
  position: number;
  /**
   * Recorte: lo que, sobre el plano, se corta; en el marco (u, v) del propio
   * plano. `null` = el plano entero, que parte todo lo que cruza. Con ventana se
   * separa un brazo sin tocar lo que haya detrás.
   */
  window: CutWindow | null;
}

export const AXIS_NORMALS: Record<Axis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Sobre qué eje cae la normal, o `null` si el plano es libre. */
export function axisOf(normal: Vec3): Axis | null {
  if (normal[0] > 0.9999) return 'x';
  if (normal[1] > 0.9999) return 'y';
  if (normal[2] > 0.9999) return 'z';
  return null;
}

/** El marco del plano sobre una pieza y los rangos de su caja en él. */
export function cutFrame(part: Part, normal: Vec3): { basis: Basis; box: { u: Vec2; v: Vec2; n: Vec2 } } {
  const basis = planeBasis(normal);
  return { basis, box: projectBox(part.bounds.min, part.bounds.max, basis) };
}

const sameNormal = (a: Vec3, b: Vec3): boolean => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-6;

/** Ventana de partida: medio ancho de la pieza sobre el plano, centrada en ella. */
function defaultWindow(part: Part, normal: Vec3): CutWindow {
  const { box } = cutFrame(part, normal);
  return {
    center: [(box.u[0] + box.u[1]) / 2, (box.v[0] + box.v[1]) / 2],
    size: [Math.max(1, (box.u[1] - box.u[0]) * 0.5), Math.max(1, (box.v[1] - box.v[0]) * 0.5)],
    side: 1,
    depth: null,
  };
}

/** Lleva la ventana a otro centro; con contorno, el contorno viaja con ella. */
function movedWindow(window: CutWindow, center: [number, number]): CutWindow {
  const du = center[0] - window.center[0];
  const dv = center[1] - window.center[1];
  return {
    ...window,
    center,
    outline: window.outline ? window.outline.map(([u, v]) => [u + du, v + dv] as [number, number]) : window.outline,
  };
}
export interface JointState extends JointSpec {
  enabled: boolean;
}
export const JOINT_MODES: ReadonlyArray<{ value: JointMode; label: string; hint: string }> = [
  { value: 'dowel', label: 'Suelto', hint: 'Un conector aparte que entra en las dos mitades. Se imprime tumbado.' },
  { value: 'plug', label: 'Macho-hembra', hint: 'Tallado en las propias mitades. Sin pieza suelta.' },
];
export const JOINT_SHAPES: ReadonlyArray<{ value: JointShape; label: string; hint: string }> = [
  { value: 'round', label: 'Redondo', hint: 'Cilíndrico. El de siempre.' },
  { value: 'square', label: 'Cuadrado', hint: 'No gira. Para piezas con orientación.' },
  { value: 'hex', label: 'Hexagonal', hint: 'No gira y entra con menos fricción que el cuadrado.' },
  { value: 'triangle', label: 'Triangular', hint: 'No gira y solo encaja en una de tres posiciones.' },
  { value: 'cone', label: 'Cónico', hint: 'Ancho en el plano, estrecho en las puntas: entra guiado y centra solo.' },
];
const SHAPE_WORDS: Record<JointShape, [singular: string, plural: string]> = {
  round: ['redondo', 'redondos'],
  square: ['cuadrado', 'cuadrados'],
  hex: ['hexagonal', 'hexagonales'],
  triangle: ['triangular', 'triangulares'],
  cone: ['cónico', 'cónicos'],
};
export interface BaseState {
  height: number;
  margin: number;
}
export type ExportFormat = 'stl' | 'obj' | '3mf';
export type { Vec3 };

const VOLUME_KEY = 'jujo:mesh:volume';

/** Colores de filamento, no de interfaz: se ven sobre la mesa en claro y oscuro. */
const PALETTE: Rgb[] = [
  [0.16, 0.55, 0.92],
  [0.96, 0.45, 0.2],
  [0.2, 0.7, 0.45],
  [0.86, 0.26, 0.4],
  [0.6, 0.4, 0.85],
  [0.94, 0.72, 0.2],
  [0.15, 0.68, 0.68],
  [0.5, 0.5, 0.55],
];
const PIN_COLOR: Rgb = [0.72, 0.68, 0.6];

/** Más piezas que esto es un STL roto, no un ensamblaje: se agrupan las sobras. */
const MAX_ISLANDS = 48;

interface MeshStore {
  model: ModelInfo | null;
  parts: Part[];
  selectedId: string | null;
  select: (id: string | null) => void;
  load: (file: File) => Promise<void>;
  clear: () => void;
  removePart: (id: string) => void;
  setPartColor: (id: string, hex: string) => void;

  engine: EngineStatus;
  busy: string | null;
  error: string | null;
  notice: string | null;
  dismiss: () => void;

  detectObjects: () => void;
  separateByColor: () => void;
  repair: (id?: string) => void;

  volume: Vec3;
  setVolume: (volume: Vec3) => void;
  fits: (part: Part) => boolean;
  cut: CutState;
  setCut: (patch: Partial<CutState>) => void;
  /** Enciende o apaga el recorte, estrenándolo sobre la pieza elegida. */
  setCutWindow: (on: boolean) => void;
  /**
   * Lleva el corte a un punto del modelo: la posición sobre su normal y, si hay
   * recorte, el centro de la ventana. Es lo que hacen el clic para colocar y el
   * movimiento con eje bloqueado, que por dentro son el mismo gesto.
   */
  placeCut: (point: Vec3, partId: string) => void;
  /** El cuchillo: un plano cualquiera, en coordenadas de la pieza. La ventana se estrena sobre él. */
  setCutPlane: (normal: Vec3, offset: number, partId: string) => void;
  /** El lazo: un contorno cerrado en (u, v) que sustituye al rectángulo del recorte. */
  setCutOutline: (outline: [number, number][]) => void;
  /** Mueve la ventana (y su contorno, si lo hay) a otro centro. */
  moveCutWindow: (center: [number, number]) => void;
  /** Cuellos encontrados en la pieza elegida: propuestas de corte, no cortes. */
  appendages: Appendage[];
  findAppendages: () => Promise<void>;
  /** Coloca el corte sobre una de las propuestas, para revisarla antes de cortar. */
  useAppendage: (index: number) => void;
  joint: JointState;
  setJoint: (patch: Partial<JointState>) => void;
  base: BaseState;
  setBase: (patch: Partial<BaseState>) => void;

  cutSelected: () => Promise<void>;
  autosplit: () => Promise<void>;
  addBase: () => Promise<void>;

  exploded: boolean;
  setExploded: (value: boolean) => void;
  /** Apertura entre piezas de un mismo objeto en la vista separada. */
  spread: number;
  setSpread: (value: number) => void;

  format: ExportFormat;
  setFormat: (format: ExportFormat) => void;
  exportPart: (id: string) => Promise<void>;
  exportAll: () => Promise<void>;
  exporting: boolean;
}

const Context = createContext<MeshStore | null>(null);

export function useMesh(): MeshStore {
  const store = useContext(Context);
  if (!store) throw new Error('useMesh fuera de <MeshProvider>');
  return store;
}

/* ------------------------------------------------------------------ Ayudas */

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')}`;
}
function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Quita los vértices que ninguna cara usa: de un grupo de material solo queda lo suyo. */
function compact(mesh: TriMesh): TriMesh {
  return extract(mesh, new Int32Array(mesh.indices.length / 3), 0);
}

function makePart(
  name: string,
  raw: TriMesh,
  color: Rgb,
  origin: PartOrigin,
  sampler: Part['sampler'] = null,
  family: Part['family'] | null = null,
): Part {
  const mesh = weld(compact(raw));
  const id = crypto.randomUUID();
  const box = bounds(mesh.positions);
  return {
    id,
    name,
    mesh,
    color,
    origin,
    bounds: box,
    topology: topology(mesh),
    volumeHint: Math.abs(signedVolume(mesh)),
    stats: null,
    statsError: null,
    sampler,
    family: family ?? { id, name, center: box.center },
  };
}

/** Frase para el aviso: qué conectores se hicieron. */
function describeJoints(reports: JointReport[]): string | null {
  const done = reports.filter((r) => r.count > 0);
  const skipped = reports.filter((r) => r.skipped);
  const parts: string[] = [];
  if (done.length > 0) {
    const total = done.reduce((sum, r) => sum + r.count, 0);
    const sample = done[0]!;
    const size = `${sample.diameter.toFixed(1)} × ${sample.depth.toFixed(1)} mm`;
    const one = total === 1;
    const word = SHAPE_WORDS[sample.shape][one ? 0 : 1];
    parts.push(
      sample.mode === 'plug'
        ? `${total} ${one ? 'macho-hembra' : 'machos-hembra'} ${word} de ${size}, ${one ? 'tallado' : 'tallados'} en las mitades.`
        : `${total} ${one ? 'conector' : 'conectores'} ${word} de ${size}, ${one ? 'suelto: se imprime tumbado' : 'sueltos: se imprimen tumbados'}.`,
    );
  }
  const short = reports.find((r) => r.requested > r.count);
  if (short) {
    parts.push(
      `Se pidieron ${short.requested} por corte y solo ${short.count === 1 ? 'cabe uno' : `caben ${short.count}`}: no hay sitio para más dejando pared.`,
    );
  }
  if (skipped.length > 0) parts.push(`Sin conector en ${skipped.length === 1 ? 'un corte' : `${skipped.length} cortes`}: ${skipped[0]!.skipped}.`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Parte una pieza en sus islas. Una pieza de una sola isla vuelve tal cual. */
function islands(part: Part): { parts: Part[]; grouped: number } {
  const { labels, count } = components(part.mesh);
  if (count <= 1) return { parts: [part], grouped: 0 };

  const sizes = new Array<number>(count).fill(0);
  for (let t = 0; t < labels.length; t += 1) sizes[labels[t]!] = (sizes[labels[t]!] ?? 0) + 1;
  const order = sizes.map((size, id) => ({ size, id })).sort((a, b) => b.size - a.size);

  // Las islas que sobran del tope se funden en una sola pieza «Restos».
  const keep = order.slice(0, MAX_ISLANDS - 1).map((x) => x.id);
  const rest = new Set(order.slice(MAX_ISLANDS - 1).map((x) => x.id));
  const relabel = new Int32Array(labels.length);
  const slot = new Map(keep.map((id, i) => [id, i]));
  for (let t = 0; t < labels.length; t += 1) {
    const id = labels[t]!;
    relabel[t] = rest.has(id) ? keep.length : (slot.get(id) ?? keep.length);
  }
  const total = keep.length + (rest.size > 0 ? 1 : 0);
  const parts: Part[] = [];
  for (let i = 0; i < total; i += 1) {
    const isRest = rest.size > 0 && i === keep.length;
    parts.push(
      makePart(
        isRest ? `${part.name} · restos` : `${part.name} · ${i + 1}`,
        extract(part.mesh, relabel, i),
        part.color,
        'island',
        part.sampler,
      ),
    );
  }
  return { parts, grouped: rest.size };
}

function wire(mesh: TriMesh): { positions: Float32Array; indices: Uint32Array } {
  return { positions: mesh.positions, indices: mesh.indices };
}

function readVolume(): Vec3 {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length === 3 && parsed.every((n) => typeof n === 'number' && n > 0)) {
        return parsed as Vec3;
      }
    }
  } catch {
    /* sin almacenamiento */
  }
  return PRINTERS[1]!.size;
}

/* ------------------------------------------------------------------ Proveedor */

export function MeshProvider({ children }: { children: ReactNode }): ReactNode {
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [parts, setParts] = useState<Part[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineStatus>({ kind: 'idle' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [volume, setVolumeState] = useState<Vec3>(readVolume);
  const [cut, setCutState] = useState<CutState>({ normal: [0, 0, 1], position: 0.5, window: null });
  const [joint, setJointState] = useState<JointState>({
    enabled: true,
    mode: 'dowel',
    shape: 'round',
    auto: true,
    diameter: 6,
    depth: 10,
    clearance: 0.15,
    count: 0,
  });
  const [base, setBaseState] = useState<BaseState>({ height: 3, margin: 5 });
  const [appendages, setAppendages] = useState<Appendage[]>([]);
  const [exploded, setExploded] = useState(false);
  const [spread, setSpread] = useState(1);
  const [format, setFormat] = useState<ExportFormat>('stl');
  const [exporting, setExporting] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const pending = useRef(new Map<string, (message: MeshWorkerResponse) => void>());
  const colorCounter = useRef(0);
  const partsRef = useRef(parts);
  partsRef.current = parts;

  const nextColor = (): Rgb => PALETTE[colorCounter.current++ % PALETTE.length]!;

  /* ------------------------------------------------------------- El worker */

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<MeshWorkerResponse>) => {
      const message = event.data;
      if (message.t === 'ready') {
        setEngine({ kind: 'ready' });
        return;
      }
      if (message.t === 'init-failed') {
        setEngine({ kind: 'failed', message: message.message });
        return;
      }
      const waiter = pending.current.get(message.id);
      if (!waiter) return;
      pending.current.delete(message.id);
      waiter(message);
    });
    worker.postMessage({ t: 'init' } satisfies MeshWorkerRequest);
    setEngine({ kind: 'loading' });
    workerRef.current = worker;
    return worker;
  }, []);

  const request = useCallback(
    (message: Exclude<MeshWorkerRequest, { t: 'init' }>) =>
      new Promise<MeshWorkerResponse>((resolve) => {
        pending.current.set(message.id, resolve);
        ensureWorker().postMessage(message);
      }),
    [ensureWorker],
  );

  useEffect(() => () => workerRef.current?.terminate(), []);

  const patch = useCallback((id: string, changes: Partial<Part>) => {
    setParts((current) => current.map((part) => (part.id === id ? { ...part, ...changes } : part)));
  }, []);

  /** Pide a Manifold las medidas de una pieza. Solo tiene sentido si es cerrada. */
  const analyze = useCallback(
    async (part: Part) => {
      if (!part.topology.watertight) {
        patch(part.id, { stats: null, statsError: 'No es estanca' });
        return;
      }
      const reply = await request({ t: 'analyze', id: crypto.randomUUID(), mesh: wire(part.mesh) });
      if (reply.t === 'stats') patch(part.id, { stats: reply.stats, statsError: null });
      else if (reply.t === 'failed') patch(part.id, { stats: null, statsError: reply.message });
    },
    [patch, request],
  );

  /** Sustituye una pieza por varias, manteniendo su sitio en la bandeja. */
  const replace = useCallback(
    (id: string, replacements: Part[]) => {
      setParts((current) => current.flatMap((part) => (part.id === id ? replacements : [part])));
      setSelectedId((current) => (current === id ? (replacements[0]?.id ?? null) : current));
      for (const part of replacements) void analyze(part);
    },
    [analyze],
  );

  /* ----------------------------------------------------------------- Carga */

  const load = useCallback(
    async (file: File) => {
      setBusy('Leyendo el archivo…');
      setError(null);
      setNotice(null);
      // Un tick para que el estado «ocupado» llegue a pintarse antes del trabajo síncrono.
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        const loaded = await loadModel(file);
        colorCounter.current = 0;
        let grouped = 0;
        const created = loaded.parts
          .map((part) => makePart(part.name, part.mesh, part.color ?? nextColor(), 'file', part.sampleTexture))
          .flatMap((part) => {
            const result = islands(part);
            grouped += result.grouped;
            return result.parts;
          });
        // Islas de un mismo objeto de archivo comparten color: se les da uno propio
        // solo si el archivo no traía ninguno, para que se distingan en la mesa.
        if (loaded.colorSource !== 'materials') {
          colorCounter.current = 0;
          for (const part of created) part.color = nextColor();
        }
        setModel({
          filename: loaded.filename,
          format: loaded.format.toUpperCase(),
          colorSource: loaded.colorSource,
          notes: loaded.notes,
        });
        setParts(created);
        setSelectedId(created[0]?.id ?? null);
        // Nada que abrir todavía: separar mueve las piezas de un corte, no objetos
        // que ya venían sueltos.
        setExploded(false);
        const open = created.filter((part) => !part.topology.watertight).length;
        setNotice(
          [
            created.length === 1 ? 'Un objeto.' : `${created.length} objetos detectados.`,
            open > 0 ? `${open} sin cerrar: repára${open === 1 ? 'lo' : 'los'} antes de cortar.` : null,
            grouped > 0 ? `${grouped} islas diminutas agrupadas en «restos».` : null,
          ]
            .filter(Boolean)
            .join(' '),
        );
        for (const part of created) void analyze(part);
      } catch (cause) {
        setError(
          cause instanceof LoadError
            ? cause.message
            : `No se pudo cargar: ${String((cause as Error)?.message ?? cause)}`,
        );
      } finally {
        setBusy(null);
      }
    },
    [analyze],
  );

  /* ---------------------------------------------------- Detección y color */

  const detectObjects = useCallback(() => {
    let grouped = 0;
    let found = 0;
    const next = partsRef.current.flatMap((part) => {
      const result = islands(part);
      grouped += result.grouped;
      if (result.parts.length > 1) found += result.parts.length;
      return result.parts;
    });
    if (found === 0) {
      setNotice('Cada pieza ya es una sola isla: no hay nada más que separar.');
      return;
    }
    setParts(next);
    setSelectedId(next[0]?.id ?? null);
    setNotice(`${next.length} objetos.${grouped > 0 ? ` ${grouped} islas diminutas agrupadas.` : ''}`);
    for (const part of next) void analyze(part);
  }, [analyze]);

  const separateByColor = useCallback(() => {
    let produced = 0;
    const next = partsRef.current.flatMap((part) => {
      const faceColors =
        faceColorsFromVertices(part.mesh) ??
        (part.sampler ? faceColorsFromTexture(part.mesh, part.sampler) : null);
      if (!faceColors) return [part];
      let clustered = clusterFaceColors(faceColors, 6);
      // Una textura fotográfica da cientos de tonos; a grano grueso salen los materiales.
      if (clustered.palette.length > 12) clustered = clusterFaceColors(faceColors, 3);
      if (clustered.palette.length <= 1) return [part];
      produced += clustered.palette.length;
      return clustered.palette.map((color, i) =>
        makePart(`${part.name} · color ${i + 1}`, extract(part.mesh, clustered.labels, i), color, 'color', part.sampler, part.family),
      );
    });
    if (produced === 0) {
      setNotice('No hay más de un color en ninguna pieza.');
      return;
    }
    setParts(next);
    setSelectedId(next[0]?.id ?? null);
    setExploded(true);
    setNotice(`${next.length} piezas por color. Las regiones de color no suelen ser cerradas: repara antes de exportar.`);
    for (const part of next) void analyze(part);
  }, [analyze]);

  /* --------------------------------------------------------------- Reparar */

  // ponytail: cierra agujeros simples, invierte la malla si está del revés como un
  // todo y vuelve a soldar. Caras individuales con normal invertida dentro de una
  // malla bien orientada no se tocan; si aparece el caso, toca propagar orientación
  // por adyacencia.
  const repair = useCallback(
    (id?: string) => {
      let filled = 0;
      let skipped = 0;
      let flipped = 0;
      let fixed = 0;
      const touched: Part[] = [];
      const next = partsRef.current.map((part) => {
        if (id && part.id !== id) return part;
        if (part.topology.watertight && signedVolume(part.mesh) >= 0) return part;
        let mesh = part.mesh;
        if (part.topology.holes.length > 0) {
          const result = fillHoles(mesh, part.topology.holes);
          mesh = result.mesh;
          filled += result.filled;
          skipped += result.skipped;
        }
        if (signedVolume(mesh) < 0) {
          mesh = flip(mesh);
          flipped += 1;
        }
        mesh = weld(mesh);
        const repaired: Part = {
          ...part,
          mesh,
          topology: topology(mesh),
          bounds: bounds(mesh.positions),
          volumeHint: Math.abs(signedVolume(mesh)),
          stats: null,
          statsError: null,
        };
        if (repaired.topology.watertight && !part.topology.watertight) fixed += 1;
        touched.push(repaired);
        return repaired;
      });
      if (touched.length === 0) {
        setNotice('Nada que reparar: todo está cerrado y bien orientado.');
        return;
      }
      setParts(next);
      const stillOpen = touched.filter((part) => !part.topology.watertight).length;
      setNotice(
        [
          filled > 0 ? `${filled} ${filled === 1 ? 'agujero cerrado' : 'agujeros cerrados'}.` : null,
          flipped > 0 ? `${flipped} ${flipped === 1 ? 'malla invertida' : 'mallas invertidas'}.` : null,
          skipped > 0 ? `${skipped} demasiado grandes para cerrar en abanico.` : null,
          fixed > 0 ? `${fixed} ${fixed === 1 ? 'pieza ahora estanca' : 'piezas ahora estancas'}.` : null,
          stillOpen > 0 ? `${stillOpen} ${stillOpen === 1 ? 'sigue abierta' : 'siguen abiertas'}: aristas compartidas por más de dos caras o agujeros irregulares.` : null,
        ]
          .filter(Boolean)
          .join(' '),
      );
      for (const part of touched) void analyze(part);
    },
    [analyze],
  );

  /* ------------------------------------------------------------- Booleanas */

  const planeFor = (part: Part, state: CutState): Plane => {
    const { box } = cutFrame(part, state.normal);
    return {
      normal: state.normal,
      offset: box.n[0] + state.position * (box.n[1] - box.n[0]),
      window: state.window,
    };
  };

  const jointSpec = (): JointSpec | null => {
    if (!joint.enabled) return null;
    const { enabled: _enabled, ...spec } = joint;
    return spec;
  };

  const cutSelected = useCallback(async () => {
    const part = partsRef.current.find((candidate) => candidate.id === selectedId);
    if (!part) return;
    setBusy('Cortando…');
    setError(null);
    try {
      const reply = await request({
        t: 'cut',
        id: crypto.randomUUID(),
        mesh: wire(part.mesh),
        plane: planeFor(part, cut),
        joint: jointSpec(),
      });
      if (reply.t === 'failed') {
        setError(reply.message);
        return;
      }
      if (reply.t !== 'pieces') return;
      if (reply.pieces.length < 2) {
        setNotice('El plano no atraviesa la pieza: mueve el corte.');
        return;
      }
      const halves = reply.pieces.map((piece, i) =>
        makePart(`${part.name} · ${String.fromCharCode(65 + i)}`, piece, part.color, 'cut', part.sampler, part.family),
      );
      const pins = reply.pins.map((pin, i) =>
        makePart(`${part.name} · conector ${i + 1}`, pin, PIN_COLOR, 'pin', null, part.family),
      );
      replace(part.id, [...halves, ...pins]);
      setExploded(true);
      setNotice([`Cortada en ${halves.length}.`, describeJoints(reply.joints)].filter(Boolean).join(' '));
    } finally {
      setBusy(null);
    }
  }, [selectedId, cut, joint, request, replace]);

  const fits = useCallback(
    (part: Part): boolean => {
      // Comparación ordenada: si la pieza cabe girada sobre sus ejes, cabe.
      const a = [...part.bounds.size].sort((x, y) => x - y);
      const b = [...volume].sort((x, y) => x - y);
      return a.every((size, i) => size <= b[i]! + 1e-6);
    },
    [volume],
  );

  const autosplit = useCallback(async () => {
    const targets = partsRef.current.filter((part) => !fits(part));
    if (targets.length === 0) {
      setNotice('Todo cabe en el volumen de impresión.');
      return;
    }
    setBusy(`Cortando ${targets.length === 1 ? 'una pieza' : `${targets.length} piezas`}…`);
    setError(null);
    try {
      let produced = 0;
      const reports: JointReport[] = [];
      for (const part of targets) {
        const reply = await request({
          t: 'autosplit',
          id: crypto.randomUUID(),
          mesh: wire(part.mesh),
          volume,
          joint: jointSpec(),
        });
        if (reply.t === 'failed') {
          setError(`${part.name}: ${reply.message}`);
          continue;
        }
        if (reply.t !== 'pieces') continue;
        const pieces = reply.pieces.map((piece, i) =>
          makePart(`${part.name} · ${i + 1}`, piece, part.color, 'cut', part.sampler, part.family),
        );
        const pins = reply.pins.map((pin, i) =>
          makePart(`${part.name} · conector ${i + 1}`, pin, PIN_COLOR, 'pin', null, part.family),
        );
        produced += pieces.length;
        reports.push(...reply.joints);
        replace(part.id, [...pieces, ...pins]);
      }
      if (produced > 0) {
        setExploded(true);
        setNotice([`${produced} piezas que caben.`, describeJoints(reports)].filter(Boolean).join(' '));
      }
    } finally {
      setBusy(null);
    }
  }, [fits, volume, joint, request, replace]);

  /**
   * Busca cuellos en la pieza elegida. No corta: propone, con la ventana ya
   * medida, y quien mira la pieza decide. Una detección que además cortara sola
   * sería imposible de revisar.
   */
  const findAppendages = useCallback(async () => {
    const part = partsRef.current.find((candidate) => candidate.id === selectedId);
    if (!part) return;
    setBusy('Buscando partes que se desprenden…');
    setError(null);
    try {
      const reply = await request({ t: 'appendages', id: crypto.randomUUID(), mesh: wire(part.mesh) });
      if (reply.t === 'failed') {
        setError(reply.message);
        return;
      }
      if (reply.t !== 'appendages') return;
      setAppendages(reply.found);
      setNotice(
        reply.found.length === 0
          ? 'No se ve ningún cuello por donde desprender una parte. Si sabes dónde va el corte, colócalo a mano con el recorte.'
          : `${reply.found.length} ${reply.found.length === 1 ? 'parte que se desprende' : 'partes que se desprenden'}. Elige una para colocar el corte y revísalo antes de cortar.`,
      );
    } finally {
      setBusy(null);
    }
  }, [selectedId, request]);

  const useAppendage = useCallback(
    (index: number) => {
      const found = appendages[index];
      const part = partsRef.current.find((candidate) => candidate.id === selectedId);
      if (!found || !part) return;
      const normal = AXIS_NORMALS[(['x', 'y', 'z'] as Axis[])[found.axis]!];
      const { box } = cutFrame(part, normal);
      const span = box.n[1] - box.n[0];
      setCutState({
        normal,
        position: span > 0 ? Math.min(1, Math.max(0, (found.offset - box.n[0]) / span)) : 0.5,
        window: found.window,
      });
    },
    [appendages, selectedId],
  );

  // Las propuestas hablan de una pieza concreta: al cambiar de pieza, caducan.
  useEffect(() => setAppendages([]), [selectedId]);

  const addBase = useCallback(async () => {
    const part = partsRef.current.find((candidate) => candidate.id === selectedId);
    if (!part) return;
    setBusy('Uniendo la base…');
    setError(null);
    try {
      const reply = await request({
        t: 'base',
        id: crypto.randomUUID(),
        mesh: wire(part.mesh),
        height: base.height,
        margin: base.margin,
      });
      if (reply.t === 'failed') {
        setError(reply.message);
        return;
      }
      if (reply.t !== 'mesh') return;
      const withBase = { ...makePart(part.name, reply.mesh, part.color, part.origin, part.sampler, part.family), id: part.id };
      replace(part.id, [withBase]);
      setNotice(`Base de ${base.height} mm unida a ${part.name}.`);
    } finally {
      setBusy(null);
    }
  }, [selectedId, base, request, replace]);

  /* ------------------------------------------------------------ Exportación */

  const pieceOf = (part: Part): ExportPiece => ({ name: part.name, mesh: part.mesh, color: part.color });
  const blobFor = (pieces: ExportPiece[], target: ExportFormat): Blob =>
    target === 'stl' ? toStl(pieces) : target === 'obj' ? toObj(pieces) : to3mf(pieces);
  const baseName = (): string => safeName((model?.filename ?? 'pieza').replace(/\.[^.]+$/, ''));

  const exportPart = useCallback(
    async (id: string) => {
      const part = partsRef.current.find((candidate) => candidate.id === id);
      if (!part) return;
      saveBlob(blobFor([pieceOf(part)], format), `${baseName()}-${safeName(part.name)}.${format}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [format, model],
  );

  const exportAll = useCallback(async () => {
    const all = partsRef.current;
    if (all.length === 0) return;
    setExporting(true);
    try {
      if (format === '3mf') {
        // 3MF lleva varias piezas con su color en un solo archivo: es su gracia.
        saveBlob(to3mf(all.map(pieceOf)), `${baseName()}.3mf`);
        return;
      }
      // En serie y con pausa: los navegadores estrangulan descargas simultáneas.
      for (const part of all) {
        saveBlob(blobFor([pieceOf(part)], format), `${baseName()}-${safeName(part.name)}.${format}`);
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    } finally {
      setExporting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, model]);

  /* ----------------------------------------------------------------- Store */

  const store = useMemo<MeshStore>(
    () => ({
      model,
      parts,
      selectedId,
      select: (id) => {
        setSelectedId(id);
        // La ventana hablaba de dónde estaba la pieza anterior: se reestrena.
        setCutState((current) => {
          if (!current.window || !id) return current;
          const part = partsRef.current.find((candidate) => candidate.id === id);
          return part ? { ...current, window: defaultWindow(part, current.normal) } : current;
        });
      },
      load,
      clear: () => {
        setModel(null);
        setParts([]);
        setSelectedId(null);
        setError(null);
        setNotice(null);
        setExploded(false);
      },
      removePart: (id) => {
        setParts((current) => current.filter((part) => part.id !== id));
        setSelectedId((current) => (current === id ? null : current));
      },
      setPartColor: (id, hex) => patch(id, { color: hexToRgb(hex) }),

      engine,
      busy,
      error,
      notice,
      dismiss: () => {
        setError(null);
        setNotice(null);
      },

      detectObjects,
      separateByColor,
      repair,

      volume,
      setVolume: (next) => {
        setVolumeState(next);
        try {
          localStorage.setItem(VOLUME_KEY, JSON.stringify(next));
        } catch {
          /* sin almacenamiento */
        }
      },
      fits,
      cut,
      setCut: (changes) =>
        setCutState((current) => {
          const next = { ...current, ...changes };
          // Al cambiar de plano, la ventana vieja hablaba de otro marco.
          if (changes.normal && !sameNormal(changes.normal, current.normal) && next.window) {
            const part = partsRef.current.find((candidate) => candidate.id === selectedId);
            next.window = part ? defaultWindow(part, next.normal) : null;
          }
          return next;
        }),
      placeCut: (point, partId) => {
        const part = partsRef.current.find((candidate) => candidate.id === partId);
        if (!part) return;
        // Sin pasar por `select`: ese reestrena la ventana, y aquí el sitio lo
        // manda el punto, no el centro de la pieza.
        setSelectedId(partId);
        setCutState((current) => {
          const { basis, box } = cutFrame(part, current.normal);
          const span = box.n[1] - box.n[0];
          const along = point[0] * basis.n[0] + point[1] * basis.n[1] + point[2] * basis.n[2];
          return {
            ...current,
            position: span > 0 ? Math.min(1, Math.max(0, (along - box.n[0]) / span)) : 0.5,
            window: current.window ? movedWindow(current.window, toPlane(point, basis)) : null,
          };
        });
      },
      setCutPlane: (normal, offset, partId) => {
        const part = partsRef.current.find((candidate) => candidate.id === partId);
        if (!part) return;
        setSelectedId(partId);
        const oriented = orient(normal);
        const { box } = cutFrame(part, oriented);
        const span = box.n[1] - box.n[0];
        // `orient` puede haber dado la vuelta a la normal: el offset la sigue.
        const signed = oriented[0] === normal[0] && oriented[1] === normal[1] && oriented[2] === normal[2] ? offset : -offset;
        setCutState((current) => ({
          normal: oriented,
          position: span > 0 ? Math.min(1, Math.max(0, (signed - box.n[0]) / span)) : 0.5,
          window: current.window ? defaultWindow(part, oriented) : null,
        }));
      },
      setCutOutline: (outline) => {
        if (outline.length < 3) return;
        setCutState((current) => ({
          ...current,
          window: {
            side: current.window?.side ?? 1,
            depth: current.window?.depth ?? null,
            ...outlineBounds(outline),
            outline,
          },
        }));
      },
      moveCutWindow: (center) =>
        setCutState((current) => (current.window ? { ...current, window: movedWindow(current.window, center) } : current)),
      setCutWindow: (on) => {
        const part = partsRef.current.find((candidate) => candidate.id === selectedId);
        setCutState((current) => ({
          ...current,
          window: on && part ? defaultWindow(part, current.normal) : null,
        }));
      },
      joint,
      setJoint: (changes) => setJointState((current) => ({ ...current, ...changes })),
      base,
      setBase: (changes) => setBaseState((current) => ({ ...current, ...changes })),

      cutSelected,
      autosplit,
      addBase,
      appendages,
      findAppendages,
      useAppendage,

      exploded,
      setExploded,
      spread,
      setSpread,

      format,
      setFormat,
      exportPart,
      exportAll,
      exporting,
    }),
    [
      model, parts, selectedId, load, patch, engine, busy, error, notice,
      detectObjects, separateByColor, repair, volume, fits, cut, joint, base,
      cutSelected, autosplit, addBase, appendages, findAppendages, useAppendage,
      exploded, spread, format, exportPart, exportAll, exporting,
    ],
  );

  return <Context.Provider value={store}>{children}</Context.Provider>;
}
