/*
 * El visor. three.js a pelo, sin React por medio en cada fotograma.
 *
 * Un único movimiento con firma: cuando las piezas se separan, cada una sale del
 * centro por su propio vector, 240 ms con salida suave y 40 ms de escalón entre
 * piezas por orden de distancia. Reunirse son 180 ms sin escalón, porque volver
 * es una sola acción, no varias.
 *
 * La separación tiene dos niveles, como en un slicer: cada objeto del archivo se
 * aparta de los demás en horizontal, y dentro de un objeto las piezas que
 * salieron de un corte se apartan de su centro original en proporción —así un
 * corte en Z se abre en Z y se ve la cara con el alojamiento y el conector en el
 * hueco. El control de espaciado y el arrastre de piezas van 1:1, sin
 * transición: son herramienta.
 *
 * Y hay gravedad: nada baja de la cama. Cualquier posición se recorta contra
 * z = suelo, y al soltar una pieza que quedó en el aire cae hasta la cama o
 * hasta lo que tenga debajo en 180 ms ease-in-out, la misma curva de «reunir»,
 * porque posarse es volver al reposo.
 *
 * Con «reducir movimiento» todo es inmediato.
 *
 * Z es arriba, como en STL y 3MF, que es lo que va a salir de aquí.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { bedClamp, restingZ, shift, type Box } from './layout.ts';
import { cutFrame, type CutState, type Part, type Vec3 } from './store.tsx';
import { planeFromRays, simplify, toPlane, type Basis } from './plane.ts';
import type { CutWindow } from './protocol.ts';

export interface ViewportProps {
  parts: Part[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  exploded: boolean;
  /** Cuánto se abren las piezas de un mismo objeto: 0 = pegadas, 1 = su propio tamaño. */
  spread: number;
  /** Plano de corte sobre la pieza seleccionada, si hay una. */
  cut: CutState | null;
  onCutPosition: (position: number) => void;
  /** Centro de la ventana de recorte, al arrastrarla sobre el plano. */
  onCutWindow: (center: [number, number]) => void;
  /** Modo apuntar: el siguiente clic lleva el corte a donde se pinche. */
  placing: boolean;
  /** Punto del corte en coordenadas del modelo, y sobre qué pieza. */
  onCutPoint: (point: Vec3, partId: string) => void;
  /** Estado del movimiento con eje bloqueado, para poder anunciarlo. */
  onMoveMode: (state: { active: boolean; axis: number | null }) => void;
  /** Modo de dibujo: cuchillo (un trazo inclina el plano) o lazo (un contorno recorta). */
  drawing: 'knife' | 'lasso' | null;
  onDrawMode: (mode: 'knife' | 'lasso' | null) => void;
  /** El cuchillo, ya en coordenadas de la pieza. */
  onKnife: (normal: Vec3, offset: number, partId: string) => void;
  /** El lazo, en el marco (u, v) del plano actual. */
  onOutline: (outline: [number, number][]) => void;
  volume: Vec3;
  showVolume: boolean;
}

/* ----------------------------------------------------------------- Curvas */

function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const a = (p1: number, p2: number): number => 1 - 3 * p2 + 3 * p1;
  const b = (p1: number, p2: number): number => 3 * p2 - 6 * p1;
  const c = (p1: number): number => 3 * p1;
  const at = (t: number, p1: number, p2: number): number => ((a(p1, p2) * t + b(p1, p2)) * t + c(p1)) * t;
  const slope = (t: number, p1: number, p2: number): number => 3 * a(p1, p2) * t * t + 2 * b(p1, p2) * t + c(p1);
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const s = slope(t, x1, x2);
      if (Math.abs(s) < 1e-6) break;
      t -= (at(t, x1, x2) - x) / s;
    }
    return at(t, y1, y2);
  };
}
// Los mismos tokens que el CSS: --ease-out y --ease-in-out.
const EASE_OUT = cubicBezier(0.16, 1, 0.3, 1);
const EASE_IN_OUT = cubicBezier(0.65, 0, 0.35, 1);
const EXPLODE_MS = 240;
const EXPLODE_STAGGER_MS = 40;
const GATHER_MS = 180;
const DROP_MS = 180;
const HOVER_MS = 120;

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------ Color del CSS */

/**
 * Resuelve un token OKLCH a un color de three. Se pasa por un elemento para que
 * light-dark() se evalúe, y por un canvas porque three no entiende oklch().
 */
function cssColor(token: string, fallback: string): THREE.Color {
  try {
    const probe = document.createElement('span');
    probe.style.color = `var(${token})`;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) return new THREE.Color(fallback);
    context.fillStyle = '#ff00ff';
    context.fillStyle = resolved;
    if (context.fillStyle === '#ff00ff') return new THREE.Color(fallback);
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return new THREE.Color(r! / 255, g! / 255, b! / 255);
  } catch {
    return new THREE.Color(fallback);
  }
}

/* ------------------------------------------------------------------ Escena */

interface Entry {
  part: Part;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  edges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  /** Desplazamiento de separación que se está aplicando. */
  offset: THREE.Vector3;
  /** Lo que el usuario ha arrastrado a mano, encima de la separación. */
  manual: THREE.Vector3;
  tween: { from: THREE.Vector3; to: THREE.Vector3; start: number; duration: number; ease: (x: number) => number } | null;
  /** Caída al soltar: solo altura, solo sobre lo arrastrado a mano. */
  drop: { from: number; to: number; start: number } | null;
  /** 0–1: intensidad del contorno, con su propia transición corta. */
  outline: number;
}

const vec = (v: Vec3): THREE.Vector3 => new THREE.Vector3(v[0], v[1], v[2]);

/**
 * Si un punto (u, v) del plano cae dentro de la ventana: el rectángulo, o el
 * contorno por paridad, que es la misma regla con la que se extruye la columna.
 */
function insideWindow(window: CutWindow): (u: number, v: number) => boolean {
  const outline = window.outline;
  if (outline && outline.length >= 3) {
    return (u, v) => {
      let inside = false;
      for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
        const [ui, vi] = outline[i]!;
        const [uj, vj] = outline[j]!;
        if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
      }
      return inside;
    };
  }
  const [cu, cv] = window.center;
  const [w, h] = window.size;
  return (u, v) => Math.abs(u - cu) <= w / 2 && Math.abs(v - cv) <= h / 2;
}

/** Distancia en pantalla (coordenadas normalizadas) a partir de la cual un clic es un arrastre. */
const DRAG_THRESHOLD = 0.012;

/**
 * Capturar el puntero puede fallar si se soltó entre eventos. Sin esto, la
 * excepción abortaría el arrastre a medio montar y dejaría la cámara bloqueada.
 */
function capture(element: HTMLElement, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    /* se sigue sin captura: el arrastre acaba con el pointerup normal */
  }
}
function release(element: HTMLElement, pointerId: number): void {
  try {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    /* ya no era nuestro */
  }
}

class Stage3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private entries = new Map<string, Entry>();
  private grid: THREE.GridHelper | null = null;
  private volumeBox: THREE.LineSegments | null = null;
  private plane: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private planeEdges: THREE.LineSegments;
  private windowBox: THREE.LineSegments;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private hoveredId: string | null = null;
  private selectedId: string | null = null;
  private exploded = false;
  private spread = 1;
  private cut: CutState | null = null;
  private volume: Vec3 = [256, 256, 256];
  private showVolume = false;
  private sceneCenter = new THREE.Vector3();
  private sceneRadius = 1;
  /** La cama: el suelo del modelo tal como se cargó. Nada baja de aquí. */
  private bedZ = 0;
  private framed = false;
  private dirty = true;
  private frame = 0;
  private lastTime = 0;
  private planeDrag: { startPointer: THREE.Vector2; startPosition: number; screenAxis: THREE.Vector2; span: number } | null = null;
  private windowDrag: { start: [number, number]; surface: THREE.Plane; hit: THREE.Vector3; basis: Basis } | null = null;
  private placing = false;
  private drawing: 'knife' | 'lasso' | null = null;
  /** El trazo en curso, en píxeles del lienzo. */
  private stroke: { points: [number, number][]; pointerId: number } | null = null;
  /** Puntero de un trazo cancelado con Esc: la órbita vuelve cuando ese puntero suelte, no antes. */
  private strokeCancelled: number | null = null;
  /** Encima del WebGL: el trazo se pinta en 2D, que es lo que es. */
  private ink: HTMLCanvasElement;
  /**
   * Mover con eje bloqueado, como en un editor 3D: M abre el modo, la letra del
   * eje lo fija, el ratón lo arrastra 1:1, Enter o clic confirma y Esc devuelve
   * el corte donde estaba. Apuntar con la mano sobre un rectángulo pequeño es
   * justo lo que no funcionaba.
   */
  private move: {
    axis: number | null;
    origin: THREE.Vector3;
    start: THREE.Vector3;
    startPointer: THREE.Vector2;
    screenAxis: THREE.Vector2 | null;
    primed?: boolean;
  } | null = null;
  private pieceDrag: { entry: Entry; startPointer: THREE.Vector2; startManual: THREE.Vector3; ground: THREE.Plane; startHit: THREE.Vector3; moving: boolean } | null = null;
  private pressAt: THREE.Vector2 | null = null;
  private resize: ResizeObserver;
  private themeWatch: MutationObserver;
  private colors = { primary: new THREE.Color(), ink: new THREE.Color(), faint: new THREE.Color(), warn: new THREE.Color() };
  /** La pieza teñida con la vista previa del corte, para desteñirla al cambiar. */
  private previewed: Entry | null = null;
  private previewDirty = false;

  constructor(
    private container: HTMLElement,
    private handlers: {
      onSelect: (id: string | null) => void;
      onCutPosition: (position: number) => void;
      onCutWindow: (center: [number, number]) => void;
      onCutPoint: (point: Vec3, partId: string) => void;
      onMoveMode: (state: { active: boolean; axis: number | null }) => void;
      onDrawMode: (mode: 'knife' | 'lasso' | null) => void;
      onKnife: (normal: Vec3, offset: number, partId: string) => void;
      onOutline: (outline: [number, number][]) => void;
    },
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'mesh-canvas';
    this.renderer.domElement.setAttribute('aria-label', 'Vista tridimensional de las piezas');
    this.renderer.domElement.setAttribute('role', 'img');
    container.appendChild(this.renderer.domElement);

    this.ink = document.createElement('canvas');
    this.ink.className = 'mesh-ink';
    this.ink.setAttribute('aria-hidden', 'true');
    container.appendChild(this.ink);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10_000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(200, -200, 160);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.invalidate());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, -0.8, 1.6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-1, 0.6, 0.4);
    this.scene.add(fill);

    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.plane.visible = false;
    this.planeEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.plane.geometry),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9 }),
    );
    this.plane.add(this.planeEdges);
    // La caja del recorte: sin verla, «hasta el final» y «solo este trozo» se
    // parecen demasiado, y uno se lleva medio modelo por delante.
    this.windowBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5 }),
    );
    this.windowBox.visible = false;
    this.plane.add(this.windowBox);
    this.scene.add(this.plane);

    this.refreshColors();
    this.themeWatch = new MutationObserver(() => {
      this.refreshColors();
      this.invalidate();
    });
    this.themeWatch.observe(document.documentElement, { attributes: true });

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();

    window.addEventListener('keydown', this.onKey);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);

    this.frame = requestAnimationFrame(this.tick);
  }

  /* ------------------------------------------------------------- Colores */

  private refreshColors(): void {
    this.colors.primary = cssColor('--primary', '#4f5bd5');
    this.colors.ink = cssColor('--ink', '#1a1b22');
    this.colors.faint = cssColor('--faint', '#9a9ca8');
    this.colors.warn = cssColor('--warning', '#a8731a');
    this.previewDirty = true;
    this.plane.material.color.copy(this.colors.primary);
    (this.planeEdges.material as THREE.LineBasicMaterial).color.copy(this.colors.primary);
    if (this.windowBox) (this.windowBox.material as THREE.LineBasicMaterial).color.copy(this.colors.primary);
    if (this.volumeBox) (this.volumeBox.material as THREE.LineBasicMaterial).color.copy(this.colors.faint);
    if (this.grid) this.grid.material.color.copy(this.colors.faint);
    for (const entry of this.entries.values()) this.applyOutline(entry);
  }

  private applyOutline(entry: Entry): void {
    const selected = entry.part.id === this.selectedId;
    entry.edges.material.color.copy(selected ? this.colors.primary : this.colors.ink);
    entry.edges.material.opacity = selected ? 0.9 : entry.outline * 0.55;
    entry.edges.visible = entry.edges.material.opacity > 0.01;
  }

  /* -------------------------------------------------------------- Tamaño */

  private fit(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.ink.width = Math.round(width * this.renderer.getPixelRatio());
    this.ink.height = Math.round(height * this.renderer.getPixelRatio());
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private invalidate(): void {
    this.dirty = true;
  }

  private frameScene(): void {
    const box = new THREE.Box3();
    for (const entry of this.entries.values()) box.expandByObject(entry.mesh);
    if (box.isEmpty()) return;
    box.getCenter(this.sceneCenter);
    this.sceneRadius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);

    // La rejilla se dibuja en la cama, no en el punto más bajo de lo que se ve:
    // si una pieza está levantada por la separación, el suelo no se mueve con ella.
    const floor = this.bedZ;
    const span = Math.ceil((this.sceneRadius * 4) / 50) * 50;
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
    }
    this.grid = new THREE.GridHelper(span, span / 10, this.colors.faint, this.colors.faint);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.set(this.sceneCenter.x, this.sceneCenter.y, floor - 0.05);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.35;
    this.scene.add(this.grid);

    this.placeVolume(box);

    if (!this.framed) {
      const distance = (this.sceneRadius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.15;
      const direction = new THREE.Vector3(1, -1, 0.8).normalize();
      this.camera.position.copy(this.sceneCenter).addScaledVector(direction, distance);
      this.camera.near = Math.max(0.01, distance / 200);
      this.camera.far = distance * 20;
      this.camera.updateProjectionMatrix();
      this.controls.target.copy(this.sceneCenter);
      this.controls.update();
      this.framed = true;
    }
  }

  private placeVolume(box?: THREE.Box3): void {
    if (this.volumeBox) {
      this.scene.remove(this.volumeBox);
      this.volumeBox.geometry.dispose();
      (this.volumeBox.material as THREE.Material).dispose();
      this.volumeBox = null;
    }
    if (!this.showVolume) return;
    const bounds = box ?? new THREE.Box3();
    if (!box) for (const entry of this.entries.values()) bounds.expandByObject(entry.mesh);
    if (bounds.isEmpty()) return;
    const [x, y, z] = this.volume;
    const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(x, y, z));
    this.volumeBox = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: this.colors.faint, transparent: true, opacity: 0.7 }),
    );
    const center = bounds.getCenter(new THREE.Vector3());
    this.volumeBox.position.set(center.x, center.y, bounds.min.z + z / 2);
    this.scene.add(this.volumeBox);
  }

  /* --------------------------------------------------------------- Piezas */

  setParts(parts: Part[]): void {
    const seen = new Set<string>();
    for (const part of parts) {
      seen.add(part.id);
      const existing = this.entries.get(part.id);
      if (existing) {
        if (existing.part.mesh !== part.mesh) {
          this.rebuild(existing, part);
          existing.manual.set(0, 0, 0);
        }
        if (existing.part.color !== part.color) existing.mesh.material.color.setRGB(...part.color);
        existing.part = part;
        continue;
      }
      this.entries.set(part.id, this.create(part));
    }
    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      this.destroy(entry);
      this.entries.delete(id);
    }
    if (parts.length === 0) this.framed = false;
    // La cama sale de las cajas sin desplazar: así no sube ni baja al separar.
    this.bedZ = parts.length > 0 ? Math.min(...parts.map((part) => part.bounds.min[2])) : 0;
    this.frameScene();
    this.layout(true);
    this.ensureVisible();
    this.updatePlane();
    this.invalidate();
  }

  private geometryFor(part: Part): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(part.mesh.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(part.mesh.indices, 1));
    geometry.computeVertexNormals();
    return geometry;
  }

  private create(part: Part): Entry {
    const geometry = this.geometryFor(part);
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(...part.color),
      roughness: 0.62,
      metalness: 0.05,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.partId = part.id;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 28),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0 }),
    );
    edges.visible = false;
    mesh.add(edges);
    this.scene.add(mesh);
    const entry: Entry = {
      part,
      mesh,
      edges,
      offset: new THREE.Vector3(),
      manual: new THREE.Vector3(),
      tween: null,
      drop: null,
      outline: 0,
    };
    this.applyOutline(entry);
    return entry;
  }

  private rebuild(entry: Entry, part: Part): void {
    entry.mesh.geometry.dispose();
    entry.edges.geometry.dispose();
    entry.mesh.geometry = this.geometryFor(part);
    entry.edges.geometry = new THREE.EdgesGeometry(entry.mesh.geometry, 28);
  }

  private destroy(entry: Entry): void {
    if (this.previewed === entry) this.previewed = null;
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entry.mesh.material.dispose();
    entry.edges.geometry.dispose();
    entry.edges.material.dispose();
  }

  /**
   * Posición efectiva de una pieza: separación más arrastre, recortada por la
   * cama. El recorte vive aquí y no en cada sitio que mueve algo, así que no hay
   * forma de colocar una pieza bajo el suelo.
   */
  private resolve(entry: Entry): THREE.Vector3 {
    const at = entry.offset.clone().add(entry.manual);
    at.z = bedClamp(entry.part.bounds.min[2], at.z, this.bedZ);
    return at;
  }

  private place(entry: Entry): void {
    entry.mesh.position.copy(this.resolve(entry));
  }

  /** Caja de la pieza donde está ahora mismo. */
  private boxOf(entry: Entry): Box {
    const at = this.resolve(entry);
    return shift({ min: entry.part.bounds.min, max: entry.part.bounds.max }, [at.x, at.y, at.z]);
  }

  /** Deja caer una pieza hasta su apoyo. Si ya está posada, no hace nada. */
  private settle(entry: Entry): void {
    const box = this.boxOf(entry);
    const others = [...this.entries.values()].filter((other) => other !== entry).map((other) => this.boxOf(other));
    const fall = box.min[2] - restingZ(box, others, this.bedZ);
    if (fall <= 1e-3) return;
    const to = entry.manual.z - fall;
    if (reducedMotion()) {
      entry.manual.z = to;
      this.place(entry);
      this.invalidate();
      return;
    }
    entry.drop = { from: entry.manual.z, to, start: performance.now() };
    this.invalidate();
  }

  /* ---------------------------------------------------------- Separación */

  setExploded(exploded: boolean): void {
    if (this.exploded === exploded) return;
    this.exploded = exploded;
    if (!exploded) {
      // Reunir devuelve todo a su sitio, también lo arrastrado a mano.
      for (const entry of this.entries.values()) {
        entry.manual.set(0, 0, 0);
        entry.drop = null;
      }
    }
    this.layout(false);
  }

  setSpread(spread: number): void {
    if (this.spread === spread) return;
    this.spread = spread;
    // Un control continuo va 1:1: sin tween.
    this.layout(true, true);
  }

  /**
   * Destino de separación de una pieza: se aleja del centro del objeto del que
   * salió, en proporción a dónde quedó. Un corte en Z se abre en Z, y el hueco
   * enseña el alojamiento con su conector dentro.
   *
   * Solo se abre lo que un corte partió. Dos objetos que nunca estuvieron unidos
   * ya están separados: apartarlos no enseña nada y desparrama la escena.
   */
  private target(entry: Entry): { to: THREE.Vector3; distance: number } {
    const to = new THREE.Vector3();
    if (!this.exploded) return { to, distance: 0 };
    const away = new THREE.Vector3(...entry.part.bounds.center).sub(new THREE.Vector3(...entry.part.family.center));
    to.addScaledVector(away, this.spread * 1.2);
    return { to, distance: away.length() };
  }

  /**
   * Que lo separado siga cabiendo en la mesa. Solo se aleja la cámara, nunca se
   * acerca: si ya cabía, no se toca lo que el usuario haya encuadrado a mano.
   */
  private ensureVisible(): void {
    const box = new THREE.Box3();
    for (const entry of this.entries.values()) box.expandByObject(entry.mesh);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
    const vertical = (this.camera.fov * Math.PI) / 180;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect);
    // Manda el lado más estrecho del encuadre: en apaisado, el alto.
    const needed = (radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.06;
    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.length() >= needed) return;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction.normalize(), needed);
    this.camera.far = Math.max(this.camera.far, needed * 8);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  /** Recoloca las piezas. `quiet` no re-anima las que ya están en su sitio; `instant` no anima nada. */
  private layout(quiet: boolean, instant = false): void {
    const now = performance.now();
    const immediate = instant || reducedMotion();
    const targets = [...this.entries.values()].map((entry) => ({ entry, ...this.target(entry) }));
    targets.sort((a, b) => a.distance - b.distance);

    let index = 0;
    for (const { entry, to } of targets) {
      const current = entry.tween ? entry.tween.to : entry.offset;
      if (quiet && current.distanceTo(to) < this.sceneRadius * 0.002) continue;
      if (immediate) {
        entry.tween = null;
        entry.offset.copy(to);
        this.place(entry);
        continue;
      }
      entry.tween = this.exploded
        ? { from: entry.offset.clone(), to, start: now + index * EXPLODE_STAGGER_MS, duration: EXPLODE_MS, ease: EASE_OUT }
        : { from: entry.offset.clone(), to, start: now, duration: GATHER_MS, ease: EASE_IN_OUT };
      index += 1;
    }
    // Se mide sobre el destino, no sobre el fotograma actual: la cámara llega
    // antes que las piezas y no hay que verlas asomar por el borde a mitad de camino.
    for (const { entry, to } of targets) {
      const at = to.clone().add(entry.manual);
      at.z = bedClamp(entry.part.bounds.min[2], at.z, this.bedZ);
      entry.mesh.position.copy(at);
    }
    this.ensureVisible();
    for (const entry of this.entries.values()) this.place(entry);
    this.invalidate();
  }

  /* ------------------------------------------------------------ Selección */

  setSelected(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    for (const entry of this.entries.values()) this.applyOutline(entry);
    this.updatePlane();
    this.invalidate();
  }

  setCut(cut: CutState | null): void {
    this.cut = cut;
    this.updatePlane();
    this.invalidate();
  }

  setVolume(volume: Vec3, show: boolean): void {
    this.volume = volume;
    this.showVolume = show;
    this.placeVolume();
    this.invalidate();
  }

  private selectedEntry(): Entry | null {
    return this.selectedId ? (this.entries.get(this.selectedId) ?? null) : null;
  }

  /** El marco del corte sobre la pieza elegida, o nada si no hay corte. */
  private planeFrame(): { entry: Entry; basis: Basis; box: ReturnType<typeof cutFrame>['box']; offset: number } | null {
    const entry = this.selectedEntry();
    if (!entry || !this.cut) return null;
    const { basis, box } = cutFrame(entry.part, this.cut.normal);
    return { entry, basis, box, offset: box.n[0] + this.cut.position * (box.n[1] - box.n[0]) };
  }

  private updatePlane(repaint = true): void {
    if (repaint) this.previewDirty = true;
    const frame = this.planeFrame();
    if (!frame || !this.cut) {
      this.plane.visible = false;
      return;
    }
    const { entry, basis, box, offset } = frame;
    const window = this.cut.window;

    // Sin recorte, el plano se dibuja algo más grande que la pieza; con él, es la ventana.
    const width = window ? Math.max(0.5, window.size[0]) : Math.max(1, (box.u[1] - box.u[0]) * 1.15);
    const height = window ? Math.max(0.5, window.size[1]) : Math.max(1, (box.v[1] - box.v[0]) * 1.15);
    const cu = window ? window.center[0] : (box.u[0] + box.u[1]) / 2;
    const cv = window ? window.center[1] : (box.v[0] + box.v[1]) / 2;

    this.plane.geometry.dispose();
    if (window?.outline && window.outline.length >= 3) {
      // El contorno se dibuja tal cual, relativo a su centro: es lo que se va a cortar.
      const shape = new THREE.Shape(window.outline.map(([u, v]) => new THREE.Vector2(u - cu, v - cv)));
      this.plane.geometry = new THREE.ShapeGeometry(shape);
    } else {
      this.plane.geometry = new THREE.PlaneGeometry(width, height);
    }
    this.planeEdges.geometry.dispose();
    this.planeEdges.geometry = new THREE.EdgesGeometry(this.plane.geometry);

    // El plano mira a +Z en local; se lleva al marco (u, v, n).
    const turn = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(vec(basis.u), vec(basis.v), vec(basis.n)),
    );
    const position = vec(basis.u).multiplyScalar(cu)
      .add(vec(basis.v).multiplyScalar(cv))
      .add(vec(basis.n).multiplyScalar(offset))
      .add(this.resolve(entry));
    this.plane.position.copy(position);
    this.plane.quaternion.copy(turn);

    // La caja se dibuja en el marco del plano: +Z local ya apunta a la normal.
    const depth = window?.depth ?? null;
    if (window && depth !== null && depth > 0) {
      this.windowBox.geometry.dispose();
      this.windowBox.geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(width, height, depth));
      this.windowBox.position.set(0, 0, (window.side * depth) / 2);
      this.windowBox.visible = true;
    } else {
      this.windowBox.visible = false;
    }
    this.plane.visible = true;
  }

  /* --------------------------------------------------------- Vista previa */

  /**
   * Tiñe la pieza elegida según lo que va a salir del corte: lo que se separa
   * en un color y lo que queda en otro. Se decide vértice a vértice con la misma
   * regla que la columna de recorte —lado de la normal, dentro de la ventana,
   * dentro de la profundidad—, así que lo que se ve es lo que se va a cortar,
   * salvo en los triángulos que cruzan el plano. Devuelve si algo cambió.
   */
  private paintPreview(): boolean {
    const frame = this.plane.visible && this.cut ? this.planeFrame() : null;
    let changed = false;
    if (this.previewed && this.previewed !== frame?.entry) {
      this.clearPreview(this.previewed);
      this.previewed = null;
      changed = true;
    }
    if (!frame || !this.cut) return changed;

    const { entry, basis, offset } = frame;
    const window = this.cut.window;
    const geometry = entry.mesh.geometry;
    const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
    let colors = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!colors || colors.count !== positions.count) {
      colors = new THREE.BufferAttribute(new Float32Array(positions.count * 3), 3);
      geometry.setAttribute('color', colors);
    }

    // Dos tintes sobre el color de la pieza, para que siga siendo esa pieza.
    const base = new THREE.Color().setRGB(...entry.part.color);
    const leaves = base.clone().lerp(this.colors.primary, 0.6);
    const stays = base.clone().lerp(this.colors.warn, 0.45);
    const [nx, ny, nz] = basis.n;
    const [ux, uy, uz] = basis.u;
    const [vx, vy, vz] = basis.v;
    const side = window?.side ?? 1;
    const depth = window?.depth ?? null;
    const inside = window ? insideWindow(window) : null;
    const source = positions.array as Float32Array;
    const target = colors.array as Float32Array;
    for (let i = 0; i < positions.count; i += 1) {
      const x = source[i * 3]!;
      const y = source[i * 3 + 1]!;
      const z = source[i * 3 + 2]!;
      const s = x * nx + y * ny + z * nz - offset;
      let separates: boolean;
      if (!inside) {
        separates = s > 0;
      } else {
        const along = side * s;
        separates =
          along > 0 &&
          (depth === null || along <= depth) &&
          inside(x * ux + y * uy + z * uz, x * vx + y * vy + z * vz);
      }
      const tint = separates ? leaves : stays;
      target[i * 3] = tint.r;
      target[i * 3 + 1] = tint.g;
      target[i * 3 + 2] = tint.b;
    }
    colors.needsUpdate = true;
    if (!entry.mesh.material.vertexColors) {
      // Cambiar esto recompila el shader: solo al entrar y salir de la vista previa.
      entry.mesh.material.vertexColors = true;
      entry.mesh.material.needsUpdate = true;
    }
    entry.mesh.material.color.setRGB(1, 1, 1);
    this.previewed = entry;
    return true;
  }

  private clearPreview(entry: Entry): void {
    entry.mesh.material.vertexColors = false;
    entry.mesh.material.needsUpdate = true;
    entry.mesh.material.color.setRGB(...entry.part.color);
  }

  /* ------------------------------------------------------------- Puntero */

  private pointerFrom(event: PointerEvent): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private pick(point: THREE.Vector2): { entry: Entry; point: THREE.Vector3 } | null {
    this.raycaster.setFromCamera(point, this.camera);
    const meshes = [...this.entries.values()].map((entry) => entry.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const entry = this.entries.get(hit.object.userData.partId as string);
    return entry ? { entry, point: hit.point } : null;
  }

  private overPlane(point: THREE.Vector2): boolean {
    if (!this.plane.visible) return false;
    this.raycaster.setFromCamera(point, this.camera);
    return this.raycaster.intersectObject(this.plane, false).length > 0;
  }

  private onPointerMove = (event: PointerEvent): void => {
    this.pointer.copy(this.pointerFrom(event));

    if (this.stroke) {
      // Un segundo dedo no dibuja: el trazo es del puntero que lo empezó.
      if (event.pointerId !== this.stroke.pointerId) return;
      // Puntos a menos de 3 px del anterior no aportan nada y engordan el contorno.
      const points = simplify([...this.stroke.points, this.pixelFrom(event)], 3);
      this.stroke = { ...this.stroke, points };
      this.paintStroke();
      return;
    }

    if (this.move) {
      const { axis, screenAxis, start, startPointer } = this.move;
      if (axis === null || !screenAxis) return;
      // El ancla se toma en el primer movimiento, no al pulsar la tecla: si el
      // puntero estaba sobre el panel, su última posición conocida es vieja y el
      // corte pegaría un salto.
      if (!this.move.primed) {
        this.move = { ...this.move, primed: true, startPointer: this.pointer.clone() };
        return;
      }
      const entry = this.selectedEntry();
      if (!entry) return;
      const delta = this.pointer.clone().sub(startPointer);
      const along = delta.dot(screenAxis) / Math.max(1e-6, screenAxis.lengthSq());
      const point = start.clone();
      point.setComponent(axis, start.getComponent(axis) + along);
      this.handlers.onCutPoint([point.x, point.y, point.z], entry.part.id);
      return;
    }

    if (this.windowDrag && this.cut?.window) {
      // El recorte se mueve sobre su propio plano, siguiendo al puntero 1:1.
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(this.windowDrag.surface, hit)) return;
      const { basis } = this.windowDrag;
      const delta = hit.sub(this.windowDrag.hit);
      const center: [number, number] = [
        this.windowDrag.start[0] + delta.dot(vec(basis.u)),
        this.windowDrag.start[1] + delta.dot(vec(basis.v)),
      ];
      this.cut = { ...this.cut, window: { ...this.cut.window, center } };
      this.updatePlane();
      this.invalidate();
      this.handlers.onCutWindow(center);
      return;
    }

    if (this.planeDrag) {
      const delta = this.pointer.clone().sub(this.planeDrag.startPointer);
      const { screenAxis, span, startPosition } = this.planeDrag;
      const along = delta.dot(screenAxis) / Math.max(1e-6, screenAxis.lengthSq());
      if (!this.cut) return;
      const position = Math.min(1, Math.max(0, startPosition + along / Math.max(1e-6, span)));
      this.cut = { ...this.cut, position };
      this.updatePlane();
      this.invalidate();
      this.handlers.onCutPosition(position);
      return;
    }

    if (this.pieceDrag) {
      const drag = this.pieceDrag;
      if (!drag.moving && this.pointer.distanceTo(drag.startPointer) < DRAG_THRESHOLD) return;
      if (!drag.moving) {
        drag.moving = true;
        drag.entry.drop = null;
        this.controls.enabled = false;
        capture(this.renderer.domElement, event.pointerId);
        this.renderer.domElement.style.cursor = 'grabbing';
      }
      // Se mueve sobre la mesa: el plano horizontal a la altura del punto agarrado.
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(drag.ground, hit)) return;
      drag.entry.manual.copy(drag.startManual).add(hit.sub(drag.startHit));
      this.place(drag.entry);
      if (drag.entry.part.id === this.selectedId) this.updatePlane(false);
      this.invalidate();
      return;
    }

    if (event.pointerType !== 'mouse') return;
    const overPlane = this.overPlane(this.pointer);
    const hovered = overPlane ? null : this.pick(this.pointer);
    const id = hovered?.entry.part.id ?? null;
    this.renderer.domElement.style.cursor = overPlane ? 'grab' : id ? 'grab' : '';
    if (id !== this.hoveredId) {
      this.hoveredId = id;
      this.invalidate();
    }
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const point = this.pointerFrom(event);
    this.pressAt = point.clone();

    // Un clic confirma el movimiento en curso, no empieza otra cosa.
    if (this.move) {
      this.pressAt = null;
      this.endMove();
      return;
    }

    // Dibujar: el trazo empieza aquí y la cámara se queda quieta hasta soltar.
    if (this.drawing) {
      this.pressAt = null;
      // Un trazo a la vez: el segundo dedo no empieza otro ni roba el primero.
      if (this.stroke) return;
      if (!this.planeFrame()) return;
      this.stroke = { points: [this.pixelFrom(event)], pointerId: event.pointerId };
      this.controls.enabled = false;
      capture(this.renderer.domElement, event.pointerId);
      this.paintStroke();
      return;
    }

    // Apuntar y colocar: el gesto más corto que hay para llevar el corte a un sitio.
    if (this.placing) {
      const hit = this.pick(point);
      this.pressAt = null;
      if (!hit) return;
      const local = hit.point.clone().sub(this.resolve(hit.entry));
      this.handlers.onCutPoint([local.x, local.y, local.z], hit.entry.part.id);
      return;
    }

    const frame = this.planeFrame();
    if (frame && this.cut?.window && this.overPlane(point)) {
      // Con recorte, arrastrar mueve la ventana; el plano se recorre con el mando
      // de posición, que es un número y no se pelea con este gesto.
      const surface = new THREE.Plane().setFromNormalAndCoplanarPoint(vec(frame.basis.n), this.plane.position);
      const hit = new THREE.Vector3();
      this.raycaster.setFromCamera(point, this.camera);
      if (this.raycaster.ray.intersectPlane(surface, hit)) {
        this.windowDrag = { start: [...this.cut.window.center], surface, hit: hit.clone(), basis: frame.basis };
        this.controls.enabled = false;
        capture(this.renderer.domElement, event.pointerId);
        this.renderer.domElement.style.cursor = 'grabbing';
        this.pressAt = null;
        return;
      }
    }

    if (frame && this.cut && this.overPlane(point)) {
      // Normal del corte proyectada a pantalla: el arrastre sigue al puntero 1:1.
      const origin = this.plane.position.clone();
      const tip = origin.clone().add(vec(frame.basis.n));
      const a = origin.project(this.camera);
      const b = tip.project(this.camera);
      const screenAxis = new THREE.Vector2(b.x - a.x, b.y - a.y);
      this.planeDrag = {
        startPointer: point,
        startPosition: this.cut.position,
        screenAxis,
        span: frame.box.n[1] - frame.box.n[0],
      };
      this.controls.enabled = false;
      capture(this.renderer.domElement, event.pointerId);
      this.renderer.domElement.style.cursor = 'grabbing';
      this.pressAt = null;
      return;
    }

    const hit = this.pick(point);
    if (hit) {
      // Aún no se mueve nada: si el puntero no se desplaza, será un clic de selección.
      this.pieceDrag = {
        entry: hit.entry,
        startPointer: point,
        startManual: hit.entry.manual.clone(),
        ground: new THREE.Plane(new THREE.Vector3(0, 0, 1), -hit.point.z),
        startHit: hit.point.clone(),
        moving: false,
      };
      // Que la cámara no orbite mientras se decide.
      this.controls.enabled = false;
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    const canvas = this.renderer.domElement;
    if (this.strokeCancelled !== null) {
      // Solo el puntero del trazo cancelado devuelve la órbita: otro dedo no cuenta.
      if (event.pointerId !== this.strokeCancelled) return;
      this.strokeCancelled = null;
      this.controls.enabled = true;
      release(canvas, event.pointerId);
      return;
    }
    if (this.stroke) {
      if (event.pointerId !== this.stroke.pointerId) return;
      this.controls.enabled = true;
      release(canvas, event.pointerId);
      this.finishStroke();
      return;
    }
    if (this.windowDrag) {
      this.windowDrag = null;
      this.controls.enabled = true;
      release(canvas, event.pointerId);
      canvas.style.cursor = '';
      return;
    }
    if (this.planeDrag) {
      this.planeDrag = null;
      this.controls.enabled = true;
      release(canvas, event.pointerId);
      canvas.style.cursor = '';
      return;
    }
    if (this.pieceDrag) {
      const drag = this.pieceDrag;
      this.pieceDrag = null;
      this.controls.enabled = true;
      release(canvas, event.pointerId);
      canvas.style.cursor = '';
      if (drag.moving) {
        // Soltar es soltar: la pieza cae hasta lo que la sostenga.
        this.settle(drag.entry);
        this.pressAt = null;
        return;
      }
    }
    if (!this.pressAt) return;
    const point = this.pointerFrom(event);
    const moved = point.distanceTo(this.pressAt);
    this.pressAt = null;
    // Un arrastre de cámara no es un clic.
    if (moved > DRAG_THRESHOLD) return;
    const hit = this.pick(point);
    this.handlers.onSelect(hit?.entry.part.id ?? null);
  };

  private onPointerLeave = (): void => {
    if (this.hoveredId !== null) {
      this.hoveredId = null;
      this.invalidate();
    }
  };

  /* ---------------------------------------------------------------- Bucle */

  private tick = (time: number): void => {
    this.frame = requestAnimationFrame(this.tick);
    const dt = this.lastTime ? time - this.lastTime : 16;
    this.lastTime = time;
    let animating = false;

    for (const entry of this.entries.values()) {
      if (entry.tween) {
        const { from, to, start, duration, ease } = entry.tween;
        const progress = Math.min(1, Math.max(0, (time - start) / duration));
        entry.offset.lerpVectors(from, to, ease(progress));
        this.place(entry);
        if (progress >= 1 && time >= start) entry.tween = null;
        animating = true;
      }
      if (entry.drop) {
        const { from, to, start } = entry.drop;
        const progress = Math.min(1, Math.max(0, (time - start) / DROP_MS));
        entry.manual.z = from + (to - from) * EASE_IN_OUT(progress);
        this.place(entry);
        if (progress >= 1) entry.drop = null;
        animating = true;
      }
      const target = entry.part.id === this.hoveredId ? 1 : 0;
      if (entry.outline !== target) {
        const step = reducedMotion() ? 1 : dt / HOVER_MS;
        entry.outline = target > entry.outline ? Math.min(1, entry.outline + step) : Math.max(0, entry.outline - step);
        this.applyOutline(entry);
        animating = true;
      }
    }
    if (animating && this.plane.visible) this.updatePlane(false);

    if (this.previewDirty) {
      this.previewDirty = false;
      if (this.paintPreview()) this.dirty = true;
    }

    const moved = this.controls.update();
    if (moved || animating || this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
  };

  setPlacing(placing: boolean): void {
    if (this.placing === placing) return;
    this.placing = placing;
    this.renderer.domElement.style.cursor = placing ? 'crosshair' : '';
  }

  setDrawing(mode: 'knife' | 'lasso' | null): void {
    if (this.drawing === mode) return;
    this.drawing = mode;
    this.cancelStroke();
    this.renderer.domElement.style.cursor = mode || this.placing ? 'crosshair' : '';
  }

  /** Abandona el trazo a medias. Si el puntero sigue pulsado, la órbita vuelve al soltarlo. */
  private cancelStroke(): void {
    if (!this.stroke) {
      // Sin trazo hay dos casos: no había nada que cancelar, o ya se canceló y su
      // puntero aún no ha soltado. En el segundo, la órbita la devuelve el
      // pointerup; tocarla aquí sería arrancar la cámara desde el trazo cancelado.
      if (this.strokeCancelled === null && !this.move) this.controls.enabled = true;
      return;
    }
    this.strokeCancelled = this.stroke.pointerId;
    this.stroke = null;
    this.paintStroke();
  }

  /** Píxeles del lienzo, para el trazo; lo demás usa coordenadas normalizadas. */
  private pixelFrom(event: PointerEvent): [number, number] {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  private ndcFrom([x, y]: [number, number]): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
  }

  private paintStroke(): void {
    const context = this.ink.getContext('2d');
    if (!context) return;
    const scale = this.renderer.getPixelRatio();
    // Se limpia en píxeles del dispositivo, sin la escala: con un zoom del
    // navegador por debajo del 100 % la escala es menor que 1 y, aplicada dos
    // veces, dejaría tinta sin borrar.
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.ink.width, this.ink.height);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const points = this.stroke?.points;
    if (!points || points.length === 0) return;
    context.strokeStyle = `#${this.colors.primary.getHexString()}`;
    context.lineWidth = 2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    if (this.drawing === 'knife') {
      // El cuchillo es recto: se enseña la recta que va a cortar, no el garabato.
      const [a, b] = [points[0]!, points[points.length - 1]!];
      context.moveTo(a[0], a[1]);
      context.lineTo(b[0], b[1]);
    } else {
      context.moveTo(points[0]![0], points[0]![1]);
      for (const [x, y] of points.slice(1)) context.lineTo(x, y);
      if (points.length >= 3) context.closePath();
    }
    context.stroke();
  }

  /** Cierra el trazo: cuchillo o lazo según el modo. Si no da para nada, el modo sigue. */
  private finishStroke(): void {
    const stroke = this.stroke;
    const frame = this.planeFrame();
    this.stroke = null;
    this.paintStroke();
    if (!stroke || !frame) return;
    const { entry, basis } = frame;

    if (this.drawing === 'knife') {
      const a = stroke.points[0]!;
      const b = stroke.points[stroke.points.length - 1]!;
      // Dos puntos casi iguales no son una línea: se ignora y se sigue en modo.
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 4) return;
      const rayA = new THREE.Raycaster();
      const rayB = new THREE.Raycaster();
      rayA.setFromCamera(this.ndcFrom(a), this.camera);
      rayB.setFromCamera(this.ndcFrom(b), this.camera);
      const origin = this.camera.position;
      const plane = planeFromRays(
        [origin.x, origin.y, origin.z],
        [rayA.ray.direction.x, rayA.ray.direction.y, rayA.ray.direction.z],
        [rayB.ray.direction.x, rayB.ray.direction.y, rayB.ray.direction.z],
      );
      if (!plane) return;
      // A coordenadas de la pieza: el plano del mundo menos la colocación.
      const placed = this.resolve(entry);
      const offset = plane.offset - (plane.normal[0] * placed.x + plane.normal[1] * placed.y + plane.normal[2] * placed.z);
      this.handlers.onKnife(plane.normal, offset, entry.part.id);
      this.handlers.onDrawMode(null);
      return;
    }

    // Lazo: cada punto del trazo, proyectado sobre el plano actual y pasado a (u, v).
    const surface = new THREE.Plane().setFromNormalAndCoplanarPoint(vec(basis.n), this.plane.position);
    const placed = this.resolve(entry);
    const outline: [number, number][] = [];
    for (const pixel of stroke.points) {
      this.raycaster.setFromCamera(this.ndcFrom(pixel), this.camera);
      const hit = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(surface, hit)) continue;
      const local = hit.sub(placed);
      outline.push(toPlane([local.x, local.y, local.z], basis));
    }
    if (outline.length < 3) return;
    this.handlers.onOutline(outline);
    this.handlers.onDrawMode(null);
  }

  /** El punto del corte en coordenadas del modelo: el plano menos la separación. */
  private cutPoint(): THREE.Vector3 | null {
    const entry = this.selectedEntry();
    if (!entry || !this.plane.visible) return null;
    return this.plane.position.clone().sub(this.resolve(entry));
  }

  private onKey = (event: KeyboardEvent): void => {
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();

    if (this.drawing && key === 'escape') {
      event.preventDefault();
      // Con un trazo a medias el puntero sigue pulsado: la órbita vuelve al
      // soltar, no ahora, o la cámara arrancaría desde el trazo cancelado.
      this.cancelStroke();
      this.handlers.onDrawMode(null);
      return;
    }

    // Dibujando no se entra en mover: dos modos a la vez dejan la órbita en un
    // estado que nadie ha pedido. Es el espejo de C/D bloqueados durante M.
    if (this.drawing) return;

    if (!this.move) {
      if (key !== 'm' || !this.cut || !this.selectedId) return;
      const origin = this.cutPoint();
      if (!origin) return;
      event.preventDefault();
      this.move = {
        axis: null,
        origin,
        start: origin.clone(),
        startPointer: this.pointer.clone(),
        screenAxis: null,
      };
      this.controls.enabled = false;
      this.renderer.domElement.style.cursor = 'crosshair';
      this.handlers.onMoveMode({ active: true, axis: null });
      return;
    }

    if (key === 'escape') {
      const { origin } = this.move;
      const entry = this.selectedEntry();
      if (entry) this.handlers.onCutPoint([origin.x, origin.y, origin.z], entry.part.id);
      this.endMove();
      return;
    }
    if (key === 'enter' || key === 'm') {
      this.endMove();
      return;
    }
    const axis = key === 'x' ? 0 : key === 'y' ? 1 : key === 'z' ? 2 : -1;
    if (axis < 0) return;
    event.preventDefault();
    // Al fijar el eje se ancla aquí: lo que se mueve a partir de ahora es el ratón.
    const world = new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
    const from = this.plane.position.clone().project(this.camera);
    const to = this.plane.position.clone().add(world).project(this.camera);
    this.move = {
      ...this.move,
      axis,
      start: this.cutPoint() ?? this.move.origin,
      startPointer: this.pointer.clone(),
      screenAxis: new THREE.Vector2(to.x - from.x, to.y - from.y),
    };
    this.handlers.onMoveMode({ active: true, axis });
  };

  private endMove(): void {
    if (!this.move) return;
    this.move = null;
    this.controls.enabled = true;
    this.renderer.domElement.style.cursor = this.placing ? 'crosshair' : '';
    this.handlers.onMoveMode({ active: false, axis: null });
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    window.removeEventListener('keydown', this.onKey);
    this.resize.disconnect();
    this.themeWatch.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    for (const entry of this.entries.values()) this.destroy(entry);
    this.entries.clear();
    this.plane.geometry.dispose();
    this.plane.material.dispose();
    this.planeEdges.geometry.dispose();
    (this.planeEdges.material as THREE.Material).dispose();
    this.windowBox.geometry.dispose();
    (this.windowBox.material as THREE.Material).dispose();
    this.grid?.geometry.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    canvas.remove();
    this.ink.remove();
  }
}

/* ------------------------------------------------------------- Componente */

export function Viewport(props: ViewportProps): ReactNode {
  const container = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage3D | null>(null);
  const handlers = useRef({
    onSelect: props.onSelect,
    onCutPosition: props.onCutPosition,
    onCutWindow: props.onCutWindow,
    onCutPoint: props.onCutPoint,
    onMoveMode: props.onMoveMode,
    onDrawMode: props.onDrawMode,
    onKnife: props.onKnife,
    onOutline: props.onOutline,
  });
  handlers.current = {
    onSelect: props.onSelect,
    onCutPosition: props.onCutPosition,
    onCutWindow: props.onCutWindow,
    onCutPoint: props.onCutPoint,
    onMoveMode: props.onMoveMode,
    onDrawMode: props.onDrawMode,
    onKnife: props.onKnife,
    onOutline: props.onOutline,
  };
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    try {
      stage.current = new Stage3D(container.current, {
        onSelect: (id) => handlers.current.onSelect(id),
        onCutPosition: (position) => handlers.current.onCutPosition(position),
        onCutWindow: (center) => handlers.current.onCutWindow(center),
        onCutPoint: (point, partId) => handlers.current.onCutPoint(point, partId),
        onMoveMode: (state) => handlers.current.onMoveMode(state),
        onDrawMode: (mode) => handlers.current.onDrawMode(mode),
        onKnife: (normal, offset, partId) => handlers.current.onKnife(normal, offset, partId),
        onOutline: (outline) => handlers.current.onOutline(outline),
      });
    } catch {
      setUnsupported(true);
      return;
    }
    return () => {
      stage.current?.dispose();
      stage.current = null;
    };
  }, []);

  useEffect(() => stage.current?.setParts(props.parts), [props.parts]);
  useEffect(() => stage.current?.setSelected(props.selectedId), [props.selectedId]);
  useEffect(() => stage.current?.setExploded(props.exploded), [props.exploded]);
  useEffect(() => stage.current?.setSpread(props.spread), [props.spread]);
  useEffect(() => stage.current?.setCut(props.cut), [props.cut]);
  useEffect(() => stage.current?.setPlacing(props.placing), [props.placing]);
  useEffect(() => stage.current?.setDrawing(props.drawing), [props.drawing]);
  useEffect(() => stage.current?.setVolume(props.volume, props.showVolume), [props.volume, props.showVolume]);

  if (unsupported) {
    return (
      <div className="mesh-view is-unsupported">
        <p className="row-hint">
          Este navegador no ofrece WebGL, así que no hay vista tridimensional. Las comprobaciones,
          cortes y exportación siguen funcionando desde el panel.
        </p>
      </div>
    );
  }
  return <div className="mesh-view" ref={container} />;
}
