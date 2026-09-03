/**
 * Mensajes entre la interfaz y el worker de Manifold.
 *
 * Las mallas viajan como arrays planos transferibles: cero copias, y el mismo
 * formato que entienden three.js y la geometría pura.
 */

export interface WireMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface MeshStats {
  volume: number;
  surfaceArea: number;
  genus: number;
  triangles: number;
  vertices: number;
}

/** Plano en el espacio de la pieza: normal unitaria y distancia desde el origen. */
export interface Plane {
  normal: [number, number, number];
  offset: number;
}

/**
 * Conectores entre dos mitades. Dos decisiones independientes:
 *
 * Modo:
 *  - dowel: conector suelto que entra en un alojamiento de cada mitad.
 *  - plug: macho tallado en una mitad, hembra en la otra. Sin pieza suelta.
 *
 * Sección:
 *  - round: cilíndrica. La de siempre.
 *  - square, hex, triangle: no gira. Para piezas con orientación.
 *  - cone: más ancha en el plano y estrecha en las puntas. Entra guiada y centra sola.
 */
export type JointMode = 'dowel' | 'plug';
export type JointShape = 'round' | 'square' | 'hex' | 'triangle' | 'cone';

export interface JointSpec {
  mode: JointMode;
  shape: JointShape;
  /** Con `auto`, diámetro, profundidad y número salen de la sección del corte. */
  auto: boolean;
  /** Diámetro de la espiga (o lado, si es cuadrada), en unidades de la malla. */
  diameter: number;
  /** Profundidad del taladro en cada mitad. */
  depth: number;
  /** Holgura radial para que la espiga entre sin lija. */
  clearance: number;
  /** Número de espigas por corte; 0 = según el espacio disponible. */
  count: number;
}

/** Lo que se hizo de verdad en un corte, para enseñarlo. */
export interface JointReport {
  mode: JointMode;
  shape: JointShape;
  diameter: number;
  depth: number;
  count: number;
  /** Por qué no se pudo poner unión, si no se pudo. */
  skipped: string | null;
}

export type MeshWorkerRequest =
  | { t: 'init' }
  /** Convierte a Manifold y devuelve estadísticas. Falla si la malla no es cerrada. */
  | { t: 'analyze'; id: string; mesh: WireMesh }
  /** Parte en dos por un plano; con `joint`, une las dos caras. */
  | { t: 'cut'; id: string; mesh: WireMesh; plane: Plane; joint: JointSpec | null }
  /** Corta en rebanadas para que quepa en el volumen dado. */
  | {
      t: 'autosplit';
      id: string;
      mesh: WireMesh;
      volume: [number, number, number];
      joint: JointSpec | null;
    }
  /** Une una base plana bajo la pieza. */
  | { t: 'base'; id: string; mesh: WireMesh; height: number; margin: number };

export type MeshWorkerResponse =
  | { t: 'ready'; version: string }
  | { t: 'init-failed'; message: string }
  | { t: 'stats'; id: string; stats: MeshStats }
  | { t: 'pieces'; id: string; pieces: WireMesh[]; pins: WireMesh[]; joints: JointReport[] }
  | { t: 'mesh'; id: string; mesh: WireMesh }
  | { t: 'failed'; id: string; message: string };
