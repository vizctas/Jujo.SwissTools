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
import type { CutState, Part, Vec3 } from './store.tsx';

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

const AXIS_VECTORS: Record<CutState['axis'], THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/** Distancia en pantalla (coordenadas normalizadas) a partir de la cual un clic es un arrastre. */
const DRAG_THRESHOLD = 0.012;

class Stage3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private entries = new Map<string, Entry>();
  private grid: THREE.GridHelper | null = null;
  private volumeBox: THREE.LineSegments | null = null;
  private plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private planeEdges: THREE.LineSegments;
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
  private planeDrag: { startPointer: THREE.Vector2; startOffset: number; screenAxis: THREE.Vector2 } | null = null;
  private pieceDrag: { entry: Entry; startPointer: THREE.Vector2; startManual: THREE.Vector3; ground: THREE.Plane; startHit: THREE.Vector3; moving: boolean } | null = null;
  private pressAt: THREE.Vector2 | null = null;
  private resize: ResizeObserver;
  private themeWatch: MutationObserver;
  private colors = { primary: new THREE.Color(), ink: new THREE.Color(), faint: new THREE.Color() };

  constructor(
    private container: HTMLElement,
    private handlers: { onSelect: (id: string | null) => void; onCutPosition: (position: number) => void },
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'mesh-canvas';
    this.renderer.domElement.setAttribute('aria-label', 'Vista tridimensional de las piezas');
    this.renderer.domElement.setAttribute('role', 'img');
    container.appendChild(this.renderer.domElement);

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
    this.plane.material.color.copy(this.colors.primary);
    (this.planeEdges.material as THREE.LineBasicMaterial).color.copy(this.colors.primary);
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

  private updatePlane(): void {
    const entry = this.selectedEntry();
    if (!entry || !this.cut) {
      this.plane.visible = false;
      return;
    }
    const { min, size, center } = entry.part.bounds;
    const axis = this.cut.axis === 'x' ? 0 : this.cut.axis === 'y' ? 1 : 2;
    const others = [0, 1, 2].filter((a) => a !== axis) as [number, number];
    const width = Math.max(1, size[others[0]]! * 1.15);
    const height = Math.max(1, size[others[1]]! * 1.15);
    this.plane.geometry.dispose();
    this.plane.geometry = new THREE.PlaneGeometry(width, height);
    this.planeEdges.geometry.dispose();
    this.planeEdges.geometry = new THREE.EdgesGeometry(this.plane.geometry);

    const position = new THREE.Vector3(...center);
    position.setComponent(axis, min[axis]! + this.cut.position * size[axis]!);
    position.add(this.resolve(entry));
    this.plane.position.copy(position);
    // PlaneGeometry mira a +Z; se orienta hacia el eje del corte.
    this.plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), AXIS_VECTORS[this.cut.axis]);
    this.plane.visible = true;
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

    if (this.planeDrag) {
      const delta = this.pointer.clone().sub(this.planeDrag.startPointer);
      const { screenAxis } = this.planeDrag;
      const along = delta.dot(screenAxis) / Math.max(1e-6, screenAxis.lengthSq());
      const entry = this.selectedEntry();
      if (!entry || !this.cut) return;
      const axis = this.cut.axis === 'x' ? 0 : this.cut.axis === 'y' ? 1 : 2;
      const size = entry.part.bounds.size[axis]!;
      const position = Math.min(1, Math.max(0, this.planeDrag.startOffset + along / Math.max(1e-6, size)));
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
        this.renderer.domElement.setPointerCapture(event.pointerId);
        this.renderer.domElement.style.cursor = 'grabbing';
      }
      // Se mueve sobre la mesa: el plano horizontal a la altura del punto agarrado.
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(drag.ground, hit)) return;
      drag.entry.manual.copy(drag.startManual).add(hit.sub(drag.startHit));
      this.place(drag.entry);
      if (drag.entry.part.id === this.selectedId) this.updatePlane();
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

    if (this.cut && this.overPlane(point)) {
      const entry = this.selectedEntry();
      if (!entry) return;
      // Eje del corte proyectado a pantalla: el arrastre sigue al puntero 1:1.
      const origin = this.plane.position.clone();
      const tip = origin.clone().add(AXIS_VECTORS[this.cut.axis]);
      const a = origin.project(this.camera);
      const b = tip.project(this.camera);
      const screenAxis = new THREE.Vector2(b.x - a.x, b.y - a.y);
      this.planeDrag = { startPointer: point, startOffset: this.cut.position, screenAxis };
      this.controls.enabled = false;
      this.renderer.domElement.setPointerCapture(event.pointerId);
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
    if (this.planeDrag) {
      this.planeDrag = null;
      this.controls.enabled = true;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      canvas.style.cursor = '';
      return;
    }
    if (this.pieceDrag) {
      const drag = this.pieceDrag;
      this.pieceDrag = null;
      this.controls.enabled = true;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
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
    if (animating && this.plane.visible) this.updatePlane();

    const moved = this.controls.update();
    if (moved || animating || this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
  };

  dispose(): void {
    cancelAnimationFrame(this.frame);
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
    this.grid?.geometry.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    canvas.remove();
  }
}

/* ------------------------------------------------------------- Componente */

export function Viewport(props: ViewportProps): ReactNode {
  const container = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage3D | null>(null);
  const handlers = useRef({ onSelect: props.onSelect, onCutPosition: props.onCutPosition });
  handlers.current = { onSelect: props.onSelect, onCutPosition: props.onCutPosition };
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    try {
      stage.current = new Stage3D(container.current, {
        onSelect: (id) => handlers.current.onSelect(id),
        onCutPosition: (position) => handlers.current.onCutPosition(position),
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
