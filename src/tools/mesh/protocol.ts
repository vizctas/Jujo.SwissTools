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

/**
 * Ventana del corte: lo que, sobre el plano, se separa. Centro y tamaño van en
 * el marco (u, v) del propio plano, el que da `planeBasis`; así vale igual para
 * un plano por eje que para uno inclinado.
 */
export interface CutWindow {
  center: [number, number];
  size: [number, number];
  /**
   * Hacia qué lado del plano queda lo que se separa. Sin ventana da igual —el
   * plano parte en dos—, pero con ventana decide si se lleva el brazo o el trozo
   * de cuerpo que hay al otro lado.
   */
  side: 1 | -1;
  /**
   * Cuánto avanza el corte a lo largo de su propia normal, en mm desde el plano.
   * `null` llega hasta el final de la pieza, que es lo que quiere una extremidad;
   * un número recorta solo ese trozo, que es lo que quiere media pata.
   */
  depth?: number | null;
  /**
   * Contorno cerrado en (u, v), dibujado a mano. Con él, la columna es ese
   * contorno extruido y `center`/`size` son solo su caja; sin él, el rectángulo.
   */
  outline?: [number, number][] | null;
}

/** Plano en el espacio de la pieza: normal unitaria y distancia desde el origen. */
export interface Plane {
  normal: [number, number, number];
  offset: number;
  /**
   * Con ventana, el corte solo alcanza lo que cae dentro de ella: separa un
   * brazo sin tocar lo que haya detrás. Sin ella, el plano es infinito y parte
   * todo lo que cruza.
   */
  window?: CutWindow | null;
}

/**
 * Una parte que se desprende: un brazo, una cabeza, un ojo pegado a la cara.
 * Es una propuesta de corte ya medida, no un corte hecho.
 */
export interface Appendage {
  /** Eje del mundo por el que conviene cortar: 0 = X, 1 = Y, 2 = Z. */
  axis: 0 | 1 | 2;
  /** Dónde, en coordenadas del mundo sobre ese eje. */
  offset: number;
  /** Hacia dónde queda lo que se desprende. */
  side: 1 | -1;
  window: CutWindow;
  /** Volumen aproximado de lo que se desprendería, en mm³. */
  volume: number;
  /** Área de la cara por la que está pegado, en mm². */
  area: number;
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
  /** Cuántos conectores por corte; 0 = los que pida la sección. */
  count: number;
}

/** Lo que se hizo de verdad en un corte, para enseñarlo. */
export interface JointReport {
  mode: JointMode;
  shape: JointShape;
  diameter: number;
  depth: number;
  /** Cuántos se pusieron de verdad. */
  count: number;
  /** Cuántos se pidieron; 0 si se dejó en automático. */
  requested: number;
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
  | { t: 'base'; id: string; mesh: WireMesh; height: number; margin: number }
  /** Busca cuellos: sitios por donde la pieza se desprende limpiamente. */
  | { t: 'appendages'; id: string; mesh: WireMesh };

export type MeshWorkerResponse =
  | { t: 'ready'; version: string }
  | { t: 'init-failed'; message: string }
  | { t: 'stats'; id: string; stats: MeshStats }
  | { t: 'pieces'; id: string; pieces: WireMesh[]; pins: WireMesh[]; joints: JointReport[] }
  | { t: 'mesh'; id: string; mesh: WireMesh }
  | { t: 'appendages'; id: string; found: Appendage[] }
  | { t: 'failed'; id: string; message: string };
