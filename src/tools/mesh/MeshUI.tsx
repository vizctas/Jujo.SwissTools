/*
 * Interfaz del taller 3D.
 *
 * Tres sitios, cada uno con un trabajo:
 *  - el lienzo manda: encima flotan las capas (qué piezas hay) y la barra de
 *    corte, anclada al plano de la pieza elegida, porque dónde y con qué cortar
 *    se decide mirando la pieza, no leyendo un panel;
 *  - el panel guarda lo que no se toca en cada corte —impresora, tamaño del
 *    conector, base, exportar— plegado en pasos con uno solo abierto;
 *  - la barra superior es la entrada del archivo y el sitio de los avisos.
 */

import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { Button, Group, NumberSlider, Row, Segmented, SelectField, Toggle } from '../../components/controls.tsx';
import {
  AlertIcon,
  BrokenIcon,
  CheckIcon,
  ChevronIcon,
  CubeIcon,
  DownloadIcon,
  GridIcon,
  InfoIcon,
  KnifeIcon,
  PenIcon,
  TargetIcon,
  TrashIcon,
  UndoIcon,
  UploadIcon,
} from '../../components/Icons.tsx';
import type { ColorSource } from './load.ts';
import { PRINTERS, type Vec3 } from './printers.ts';
import type { JointShape } from './protocol.ts';
import { AXIS_NORMALS, axisOf, cutFrame, JOINT_MODES, JOINT_SHAPES, rgbToHex, useMesh, type Axis, type Part } from './store.tsx';
import { Viewport } from './Viewport.tsx';

const COLOR_SOURCE: Record<ColorSource, string> = {
  materials: 'colores por material',
  vertices: 'color por vértice',
  texture: 'textura',
  none: 'sin color',
};

const AXES = [
  { value: 'x' as const, label: 'X' },
  { value: 'y' as const, label: 'Y' },
  { value: 'z' as const, label: 'Z' },
];

const REACH = [
  { value: 'all' as const, label: 'Todo' },
  { value: 'window' as const, label: 'Recorte' },
];

const AXIS_LETTERS = ['X', 'Y', 'Z'];
const AXIS_OF: Record<'x' | 'y' | 'z', number> = { x: 0, y: 1, z: 2 };

type DrawMode = 'knife' | 'lasso' | null;

/** Grados que el plano se aparta de la horizontal, para decirlo cuando es libre. */
const tilt = (normal: [number, number, number]): number => Math.round((Math.acos(Math.min(1, Math.abs(normal[2]))) * 180) / Math.PI);

/** Cuánto mide la pieza a lo largo de la normal del corte: el máximo de la profundidad. */
const depthAlong = (part: Part, normal: [number, number, number]): number => {
  const { box } = cutFrame(part, normal);
  return box.n[1] - box.n[0];
};

const mm = (value: number): string => (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1));
const cm3 = (mm3: number): string => {
  const value = mm3 / 1000;
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
};

/** Sección del conector, dibujada: se reconoce antes que la palabra. */
function ShapeGlyph({ shape }: { shape: JointShape }): ReactNode {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' as const };
  const path = {
    square: <rect x="3" y="3" width="10" height="10" {...common} />,
    hex: <path d="M8 2 13.2 5v6L8 14 2.8 11V5z" {...common} />,
    triangle: <path d="M8 2.5 13.5 13h-11z" {...common} />,
    cone: <path d="M5.5 2h5L13 8l-2.5 6h-5L3 8z" {...common} />,
    round: <circle cx="8" cy="8" r="5.5" {...common} />,
  }[shape];
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {path}
    </svg>
  );
}

const SHAPE_OPTIONS = JOINT_SHAPES.map(({ value, label }) => ({
  value,
  label,
  glyph: <ShapeGlyph shape={value} />,
}));

/* ------------------------------------------------------------- Zona de entrada */

export function MeshInput(): ReactNode {
  const { model, parts, load, clear, busy, error, notice, engine, dismiss } = useMesh();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const take = (files: FileList | File[] | null): void => {
    const file = files ? [...files][0] : null;
    if (file) void load(file);
  };
  const onDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    setDragging(false);
    take(event.dataTransfer.files);
  };

  return (
    <section
      className={`content-bar mesh-bar${dragging ? ' is-dragging' : ''}`}
      aria-label="Modelo a preparar"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        ref={input}
        type="file"
        accept=".stl,.obj,.gltf,.glb,.ply,model/stl,model/obj,model/gltf-binary,model/gltf+json"
        className="visually-hidden"
        onChange={(event) => {
          take(event.target.files);
          event.target.value = '';
        }}
      />

      <div className="mesh-drop">
        <span className="apk-icon" aria-hidden="true">
          <CubeIcon />
        </span>
        <div className="apk-headline">
          <p className="apk-name">{model ? model.filename : 'Arrastra un modelo aquí'}</p>
          <p className="row-hint">
            {model
              ? `${model.format} · ${COLOR_SOURCE[model.colorSource]} · ${parts.length} ${parts.length === 1 ? 'pieza' : 'piezas'}${busy ? ` · ${busy}` : ''}`
              : 'STL, OBJ, glTF/GLB o PLY. Se trabaja en tu equipo; no sale de aquí.'}
          </p>
        </div>
        <div className="apk-actions">
          <Button variant="default" loading={busy !== null} onClick={() => input.current?.click()}>
            <UploadIcon />
            {model ? 'Otro modelo' : 'Abrir modelo'}
          </Button>
          {model ? (
            <Button variant="ghost" onClick={clear}>
              <TrashIcon />
              Vaciar
            </Button>
          ) : null}
        </div>
      </div>

      {engine.kind === 'failed' ? (
        <p className="row-error" role="alert">
          <AlertIcon /> El motor de cortes no arrancó: {engine.message}
        </p>
      ) : null}
      {error ? (
        <p className="row-error" role="alert">
          <AlertIcon /> {error}
          <button type="button" className="mesh-dismiss" onClick={dismiss}>
            Cerrar
          </button>
        </p>
      ) : null}
      {notice ? (
        <p className="apk-note" role="status">
          <InfoIcon />
          {notice}
        </p>
      ) : null}
      {model?.notes.map((note) => (
        <p className="apk-note" key={note}>
          <InfoIcon />
          {note}
        </p>
      ))}
    </section>
  );
}

/* ----------------------------------------------------------------- Estado */

type StateKind = 'ok' | 'warn' | 'bad';

function stateOf(part: Part, fits: boolean): { kind: StateKind; label: string } {
  const t = part.topology;
  if (t.nonManifoldEdges > 0) return { kind: 'bad', label: `No manifold · ${t.nonManifoldEdges} aristas` };
  if (t.holes.length > 0) {
    return { kind: 'warn', label: `${t.holes.length} ${t.holes.length === 1 ? 'agujero' : 'agujeros'}` };
  }
  if (t.boundaryEdges > 0) return { kind: 'warn', label: 'Abierta' };
  if (!fits) return { kind: 'warn', label: 'No cabe en la impresora' };
  return { kind: 'ok', label: 'Cerrada' };
}

function StateIcon({ kind }: { kind: StateKind }): ReactNode {
  if (kind === 'bad') return <BrokenIcon />;
  if (kind === 'warn') return <AlertIcon />;
  return <CheckIcon />;
}

/* ------------------------------------------------------------------ Capas */

function LayerRow({ part, index }: { part: Part; index: number }): ReactNode {
  const { selectedId, select, removePart, exportPart, setPartColor, fits, format } = useMesh();
  const selected = part.id === selectedId;
  const state = stateOf(part, fits(part));
  const [sx, sy, sz] = part.bounds.size;

  return (
    <li
      className={`layer${selected ? ' is-selected' : ''}`}
      style={{ '--i': index } as CSSProperties}
    >
      <div className="layer-row">
        <label className="layer-swatch" title="Color de la pieza">
          {/* El cuadro visible es pequeño; el objetivo apuntable es la etiqueta. */}
          <span className="layer-swatch-box">
            <input
              type="color"
              value={rgbToHex(part.color)}
              aria-label={`Color de ${part.name}`}
              onChange={(event) => setPartColor(part.id, event.target.value)}
            />
          </span>
        </label>
        <button
          type="button"
          className="layer-name"
          aria-pressed={selected}
          title={part.name}
          onClick={() => select(selected ? null : part.id)}
        >
          {part.name}
        </button>
        <span className={`layer-flag is-${state.kind}`} title={state.label}>
          <StateIcon kind={state.kind} />
          <span className="visually-hidden">{state.label}</span>
        </span>
      </div>

      {selected ? (
        <div className="layer-detail">
          <p className="value">
            {mm(sx)}×{mm(sy)}×{mm(sz)} mm · {cm3(part.stats?.volume ?? part.volumeHint)} cm³
          </p>
          <p className={`piece-state is-${state.kind}`}>
            <StateIcon kind={state.kind} /> {state.label}
          </p>
          <div className="layer-actions">
            <Button variant="ghost" onClick={() => void exportPart(part.id)}>
              <DownloadIcon />
              {format.toUpperCase()}
            </Button>
            <button
              type="button"
              className="icon-btn"
              title="Quitar la pieza"
              aria-label={`Quitar ${part.name}`}
              onClick={() => removePart(part.id)}
            >
              <TrashIcon />
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function Layers(): ReactNode {
  const { parts, undo, canUndo } = useMesh();
  const [open, setOpen] = useState(true);

  // Agrupadas por el objeto del que salieron, en el orden en que aparecen.
  const families: { id: string; name: string; parts: Part[] }[] = [];
  const at = new Map<string, number>();
  for (const part of parts) {
    let index = at.get(part.family.id);
    if (index === undefined) {
      index = families.length;
      at.set(part.family.id, index);
      families.push({ id: part.family.id, name: part.family.name, parts: [] });
    }
    families[index]!.parts.push(part);
  }
  const closed = parts.filter((part) => part.topology.watertight).length;
  let row = 0;

  return (
    <section className={`layers${open ? '' : ' is-collapsed'}`} aria-label="Piezas">
      <h2 className="layers-head">
        <button type="button" className="layers-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronIcon className="layers-chevron" />
          Piezas
          <span className="value">{parts.length}</span>
        </button>
        <span className="layers-tally value" title="Piezas cerradas">
          {closed}/{parts.length}
        </span>
        <button
          type="button"
          className="cut-aim"
          disabled={!canUndo}
          title={canUndo ? 'Deshacer la última operación (Ctrl+Z)' : 'Nada que deshacer'}
          onClick={undo}
        >
          <UndoIcon />
          <span className="visually-hidden">Deshacer</span>
        </button>
      </h2>
      <div className="layers-body">
        <ul className="layers-list">
          {families.map((family) => (
            <li key={family.id}>
              {/* Solo cuando el objeto se partió: si tiene una pieza, el encabezado
                  repetiría su propio nombre. */}
              {family.parts.length > 1 ? (
                <p className="layer-family" title={family.name}>
                  {family.name}
                </p>
              ) : null}
              <ul>
                {family.parts.map((part) => (
                  <LayerRow key={part.id} part={part} index={row++} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------- Tarjeta de corte */

/**
 * Acoplada al pie de la columna izquierda, no sobre la pieza: flotando sobre el
 * modelo tapaba justo lo que se está mirando y estorbaba el arrastre. Quien
 * señala dónde se corta es el plano, dibujado en la pieza; esto solo son los
 * mandos.
 */
function CutCard({
  placing,
  onPlacing,
  drawing,
  onDrawing,
}: {
  placing: boolean;
  onPlacing: (on: boolean) => void;
  drawing: DrawMode;
  onDrawing: (mode: DrawMode) => void;
}): ReactNode {
  const { cut, setCut, setCutWindow, joint, setJoint, parts, selectedId, cutSelected, busy, engine } = useMesh();
  const selected = parts.find((part) => part.id === selectedId) ?? null;
  if (!selected) return null;

  const working = busy !== null;
  const open = !selected.topology.watertight;
  const blocked = working || engine.kind === 'failed' || open;
  const axis = axisOf(cut.normal);

  return (
    <section className="cut-card" aria-label="Corte">
      <header className="cut-head">
        <h2 className="cut-title">Corte</h2>
        <span className="cut-target" title={selected.name}>
          {selected.name}
        </span>
        <span className="cut-gestures">
          <button
            type="button"
            className={`cut-aim${placing ? ' is-on' : ''}`}
            aria-pressed={placing}
            title="Colocar el corte con un clic sobre la pieza"
            onClick={() => onPlacing(!placing)}
          >
            <TargetIcon />
            <span className="visually-hidden">Colocar el corte apuntando</span>
          </button>
          <button
            type="button"
            className={`cut-aim${drawing === 'knife' ? ' is-on' : ''}`}
            aria-pressed={drawing === 'knife'}
            title="Cuchillo: dibuja la línea por donde pasa el corte (C)"
            onClick={() => onDrawing(drawing === 'knife' ? null : 'knife')}
          >
            <KnifeIcon />
            <span className="visually-hidden">Cuchillo</span>
          </button>
          <button
            type="button"
            className={`cut-aim${drawing === 'lasso' ? ' is-on' : ''}`}
            aria-pressed={drawing === 'lasso'}
            disabled={!cut.window}
            title={cut.window ? 'Contornea la pieza punto a punto: clic añade, arrastrar ajusta (D)' : 'Activa Recorte para contornear'}
            onClick={() => onDrawing(drawing === 'lasso' ? null : 'lasso')}
          >
            <PenIcon />
            <span className="visually-hidden">Contornear la pieza</span>
          </button>
        </span>
      </header>
      <div className="cut-row">
        <Segmented<Axis | 'none'>
          label="Eje del corte"
          value={axis ?? 'none'}
          options={AXES}
          onChange={(next) => next !== 'none' && setCut({ normal: AXIS_NORMALS[next] })}
        />
        <span className="cut-pos value">{Math.round(cut.position * 100)} %</span>
      </div>
      {axis === null ? (
        <p className="row-hint">Plano libre · {tilt(cut.normal)}° respecto a Z. Pulsa un eje para enderezarlo.</p>
      ) : null}
      <Segmented
        label="Alcance del corte"
        value={cut.window ? 'window' : 'all'}
        columns={2}
        options={REACH}
        onChange={(value) => setCutWindow(value === 'window')}
      />
      {joint.enabled ? (
        <Segmented
          label="Sección del conector"
          value={joint.shape}
          columns={5}
          options={SHAPE_OPTIONS}
          onChange={(shape) => setJoint({ shape })}
        />
      ) : null}
      <Button
        variant="primary"
        disabled={blocked}
        loading={working && busy === 'Cortando…'}
        title={open ? 'La pieza no está cerrada: repárala en el panel antes de cortar' : 'Cortar por el plano'}
        onClick={() => void cutSelected()}
      >
        Cortar
      </Button>
      {open ? <p className="cut-warn">Sin cerrar: repárala antes.</p> : null}
    </section>
  );
}

/* --------------------------------------------------------------------- Escena */

export function MeshStage(): ReactNode {
  const {
    parts, selectedId, select, exploded, setExploded, spread, setSpread,
    cut, setCut, placeCut, setCutPlane, setCutAnchors, moveCutWindow, volume, undo, canUndo,
  } = useMesh();
  const [showVolume, setShowVolume] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [drawing, setDrawing] = useState<DrawMode>(null);
  const [moving, setMoving] = useState<{ active: boolean; axis: number | null }>({ active: false, axis: null });

  // Apuntar y dibujar se excluyen: el siguiente clic es de uno solo.
  const startPlacing = (on: boolean): void => {
    setPlacing(on);
    if (on) setDrawing(null);
  };
  const startDrawing = (mode: DrawMode): void => {
    setDrawing(mode);
    if (mode) setPlacing(false);
  };

  // Sin pieza elegida no hay plano: un modo de dibujo que sobreviva a eso se
  // traga todos los clics y solo Esc lo saca.
  useEffect(() => {
    if (!selectedId) {
      setDrawing(null);
      setPlacing(false);
    }
  }, [selectedId]);

  // «E» separa y reúne, «C» cuchillo, «D» dibujar; solo cuando el foco no está escribiendo.
  const hasWindow = cut.window !== null;
  useEffect(() => {
    if (parts.length === 0) return;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      const typing = target instanceof Element && target.closest('input, textarea, select, [contenteditable]');
      if (typing) return;
      const key = event.key.toLowerCase();
      // Ctrl+Z (Cmd+Z en Mac) deshace la última operación sobre las piezas.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === 'z') {
        if (!canUndo) return;
        event.preventDefault();
        undo();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (key === 'e') {
        event.preventDefault();
        setExploded(!exploded);
      // Con el corte en movimiento (M) no se dibuja: dos modos a la vez confunden al badge y a Esc.
      } else if (key === 'c' && selectedId && !moving.active) {
        event.preventDefault();
        setPlacing(false);
        setDrawing((current) => (current === 'knife' ? null : 'knife'));
      } else if (key === 'd' && selectedId && hasWindow && !moving.active) {
        event.preventDefault();
        setPlacing(false);
        setDrawing((current) => (current === 'lasso' ? null : 'lasso'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [parts.length, exploded, setExploded, selectedId, hasWindow, moving.active, undo, canUndo]);

  if (parts.length === 0) {
    return (
      <div className="mesh-stage is-empty">
        <div className="devices-empty">
          <CubeIcon />
          <p>Sin modelo todavía.</p>
          <p className="row-hint">
            Abre uno arriba. Se detectan los objetos aunque vengan exportados como uno solo, se
            comprueba que cada uno esté cerrado y se divide lo que no quepa en tu impresora. Todo en
            tu navegador.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mesh-stage">
      <Viewport
        parts={parts}
        selectedId={selectedId}
        onSelect={select}
        exploded={exploded}
        spread={spread}
        cut={selectedId ? cut : null}
        onCutPosition={(position) => setCut({ position })}
        onCutWindow={moveCutWindow}
        placing={placing}
        drawing={drawing}
        onDrawMode={startDrawing}
        onKnife={setCutPlane}
        onAnchors={setCutAnchors}
        onCutPoint={placeCut}
        onMoveMode={setMoving}
        volume={volume}
        showVolume={showVolume}
      />

      <div className="mesh-tools">
        <Layers />
        <CutCard placing={placing} onPlacing={startPlacing} drawing={drawing} onDrawing={startDrawing} />

      {moving.active ? (
        <p className="mesh-mode" role="status">
          {moving.axis === null
            ? 'Moviendo el corte: pulsa X, Y o Z para fijar el eje'
            : `Moviendo en ${AXIS_LETTERS[moving.axis]} · Enter o clic confirma · Esc lo deja donde estaba`}
        </p>
      ) : drawing === 'knife' ? (
        <p className="mesh-mode" role="status">
          Dibuja la línea por donde pasa el corte · Esc cancela
        </p>
      ) : drawing === 'lasso' ? (
        <p className="mesh-mode" role="status">
          Clic sobre la pieza añade un punto · arrástralos para ajustar · Retroceso quita el último · Esc termina
        </p>
      ) : placing ? (
        <p className="mesh-mode" role="status">
          Clic sobre la pieza para llevar el corte ahí
        </p>
      ) : null}
      </div>

      <div className="mesh-hud" role="toolbar" aria-label="Vista">
        <button
          type="button"
          className={`hud-btn${exploded ? ' is-on' : ''}`}
          aria-pressed={exploded}
          title="Separar las piezas en la vista (E)"
          onClick={() => setExploded(!exploded)}
        >
          <CubeIcon />
          {exploded ? 'Reunir' : 'Separar'}
        </button>
        {exploded ? (
          <label className="hud-range" title="Cuánto se abren entre sí las piezas de un mismo objeto">
            <span className="hud-range-label">Separación</span>
            <input
              type="range"
              min={0.2}
              max={4}
              step={0.1}
              value={spread}
              aria-label="Separación entre piezas"
              onChange={(event) => setSpread(Number(event.target.value))}
            />
            <span className="value hud-range-value">{spread.toFixed(1)}×</span>
          </label>
        ) : null}
        <button
          type="button"
          className={`hud-btn${showVolume ? ' is-on' : ''}`}
          aria-pressed={showVolume}
          title="Mostrar el volumen de la impresora"
          onClick={() => setShowVolume(!showVolume)}
        >
          <GridIcon />
          Impresora
        </button>
      </div>

      <p className="mesh-legend row-hint">
        Arrastra el fondo para girar · clic en una pieza para elegirla · arrástrala para moverla, y cae
        sobre lo que la sostenga
        {selectedId ? ' · para colocar el corte: apunta y haz clic, o pulsa M y luego X, Y o Z' : ''}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------- Panel */

type Step = 'modelo' | 'impresora' | 'corte' | 'base' | 'exportar';

export function MeshPanel(): ReactNode {
  const {
    model, parts, selectedId, engine, busy,
    detectObjects, separateByColor, repair,
    volume, setVolume, fits, cut, setCut, setCutWindow, moveCutWindow, joint, setJoint, base, setBase,
    appendages, findAppendages, useAppendage,
    cutSelected, autosplit, addBase,
    format, setFormat, exportAll, exporting,
  } = useMesh();
  const [step, setStep] = useState<Step>('modelo');
  const toggle = (next: Step) => () => setStep((current) => (current === next ? ('' as Step) : next));

  const selected = parts.find((part) => part.id === selectedId) ?? null;
  const axis = axisOf(cut.normal);
  const watertight = parts.filter((part) => part.topology.watertight).length;
  const broken = parts.length - watertight;
  const oversized = parts.filter((part) => !fits(part)).length;
  const triangles = parts.reduce((sum, part) => sum + part.mesh.indices.length / 3, 0);
  const hasColor = parts.some((part) => part.mesh.colors || part.sampler);
  const working = busy !== null;
  const engineDown = engine.kind === 'failed';
  const printer = PRINTERS.find((candidate) => candidate.size.every((n, i) => n === volume[i]));
  const noPart = parts.length === 0;
  const shape = JOINT_SHAPES.find((s) => s.value === joint.shape);

  const setAxis = (axis: 0 | 1 | 2, value: number): void => {
    const next = [...volume] as Vec3;
    next[axis] = value;
    setVolume(next);
  };

  return (
    <div className="panel-scroll">
      <Group
        title="Modelo"
        collapsible
        step={1}
        done={!noPart && broken === 0}
        open={step === 'modelo'}
        onToggle={toggle('modelo')}
        summary={noPart ? 'sin modelo' : `${parts.length} piezas${broken > 0 ? ` · ${broken} abiertas` : ''}`}
      >
        <dl className="readout">
          <div>
            <dt>Piezas</dt>
            <dd className="value">{parts.length}</dd>
          </div>
          <div>
            <dt>Cerradas</dt>
            <dd className="value">
              {watertight}/{parts.length}
            </dd>
          </div>
          <div>
            <dt>Triángulos</dt>
            <dd className="value">{triangles.toLocaleString('es')}</dd>
          </div>
          <div>
            <dt>Motor</dt>
            <dd className="value">
              {engine.kind === 'ready' ? 'listo' : engine.kind === 'loading' ? 'cargando' : engineDown ? 'error' : '—'}
            </dd>
          </div>
        </dl>
        <p className="row-hint">
          Cerrada: sin agujeros y con las caras hacia fuera, lo que un slicer imprime sin inventarse
          nada. Reparar cierra agujeros simples, endereza modelos del revés y funde vértices duplicados.
        </p>
        <div className="mesh-buttons">
          <Button variant="default" disabled={noPart || working} onClick={detectObjects}>
            Detectar objetos
          </Button>
          <Button
            variant={broken > 0 ? 'primary' : 'default'}
            disabled={noPart || working || broken === 0}
            onClick={() => repair()}
          >
            {broken > 0 ? `Reparar ${broken === 1 ? 'la abierta' : `las ${broken} abiertas`}` : 'Nada que reparar'}
          </Button>
        </div>
        <p className="row-hint">
          {model
            ? model.colorSource === 'materials'
              ? 'El archivo trae materiales: cada uno ya es su pieza.'
              : model.colorSource === 'vertices'
                ? 'Color pintado por vértice. Se agrupa por tono y cada tono sale como pieza.'
                : model.colorSource === 'texture'
                  ? 'Textura UV. Se muestrea el centro de cada cara y se agrupa por tono.'
                  : 'El archivo no trae color. Cada pieza lleva el suyo en la lista, y se guarda en el 3MF.'
            : 'Se detecta de dónde sale el color al abrir el archivo.'}
        </p>
        <Button variant="default" disabled={!hasColor || working} onClick={separateByColor}>
          Separar por color
        </Button>
      </Group>

      <Group
        title="Impresora"
        collapsible
        step={2}
        done={!noPart && oversized === 0}
        open={step === 'impresora'}
        onToggle={toggle('impresora')}
        summary={`${printer?.label ?? 'a medida'} · ${volume.join('×')}`}
      >
        <Row label="Modelo" wide>
          <SelectField
            label="Impresora"
            value={printer?.id ?? 'custom'}
            options={[
              ...PRINTERS.map((candidate) => ({ value: candidate.id, label: candidate.label })),
              { value: 'custom', label: 'A medida' },
            ]}
            onChange={(id) => {
              const found = PRINTERS.find((candidate) => candidate.id === id);
              if (found) setVolume(found.size);
            }}
          />
        </Row>
        <NumberSlider label="Ancho (X)" value={volume[0]} min={50} max={600} step={1} unit="mm" onChange={(v) => setAxis(0, v)} />
        <NumberSlider label="Fondo (Y)" value={volume[1]} min={50} max={600} step={1} unit="mm" onChange={(v) => setAxis(1, v)} />
        <NumberSlider label="Alto (Z)" value={volume[2]} min={50} max={600} step={1} unit="mm" onChange={(v) => setAxis(2, v)} />
        <p className="row-hint">
          {noPart
            ? 'Se guarda para la próxima vez.'
            : oversized === 0
              ? 'Todo cabe, girando la pieza si hace falta.'
              : `${oversized} ${oversized === 1 ? 'pieza no cabe' : 'piezas no caben'}. Se dividen por planos medios hasta que quepan, con conectores si están activos.`}
        </p>
        <Button
          variant={oversized > 0 ? 'primary' : 'default'}
          disabled={oversized === 0 || working || engineDown}
          loading={working && busy?.startsWith('Cortando') === true}
          onClick={() => void autosplit()}
        >
          Dividir para la impresora
        </Button>
      </Group>

      <Group
        title="Corte y conectores"
        collapsible
        step={3}
        open={step === 'corte'}
        onToggle={toggle('corte')}
        summary={
          joint.enabled
            ? `${axis ? axis.toUpperCase() : 'Libre'} · ${Math.round(cut.position * 100)} % · ${shape?.label.toLowerCase()}`
            : `${axis ? axis.toUpperCase() : 'Libre'} · ${Math.round(cut.position * 100)} % · sin conector`
        }
      >
        <p className="row-hint">
          El eje, la sección y el botón de cortar también están sobre la pieza, en la mesa. Aquí
          queda lo que no se toca en cada corte.
        </p>

        <Button
          variant="default"
          disabled={!selected || working || engineDown}
          loading={working && busy?.startsWith('Buscando') === true}
          onClick={() => void findAppendages()}
        >
          Buscar partes que se desprenden
        </Button>
        <p className="row-hint">
          Barre la pieza en los tres ejes buscando cuellos: sitios donde la sección se estrecha de
          golpe y lo que queda más allá es poco. Un hombro, una muñeca, el borde de un ojo pegado a
          la cara. Propone dónde cortar y con qué ventana; cortar lo sigues decidiendo tú.
        </p>
        {appendages.length > 0 ? (
          <ul className="loose-list">
            {appendages.map((found, index) => (
              <li key={`${found.axis}-${found.side}-${found.offset.toFixed(2)}`}>
                <button type="button" className="loose" onClick={() => useAppendage(index)}>
                  <span className="loose-name">
                    Sale por {AXIS_LETTERS[found.axis]}
                    {found.side > 0 ? '+' : '−'} en {mm(found.offset)} mm
                  </span>
                  <span className="loose-meta value">
                    {cm3(found.volume)} cm³ · pegada por {found.area.toFixed(0)} mm² ·{' '}
                    {mm(found.window.size[0])}×{mm(found.window.size[1])} mm
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <Row label="Eje" wide>
          <Segmented<Axis | 'none'>
            label="Eje del corte"
            value={axis ?? 'none'}
            columns={3}
            options={AXES}
            onChange={(next) => next !== 'none' && setCut({ normal: AXIS_NORMALS[next] })}
          />
        </Row>
        {axis === null ? (
          <p className="row-hint">
            Plano libre, dibujado con el cuchillo: {tilt(cut.normal)}° respecto a Z. Pulsar un eje lo endereza.
          </p>
        ) : null}
        <NumberSlider
          label="Posición"
          value={cut.position * 100}
          min={0}
          max={100}
          step={0.5}
          decimals={1}
          unit="%"
          onChange={(value) => setCut({ position: value / 100 })}
          disabled={!selected}
          disabledReason="Elige una pieza en la lista o en la mesa."
        />
        <Row label="Alcance" wide>
          <Segmented
            label="Alcance del corte"
            value={cut.window ? 'window' : 'all'}
            columns={2}
            options={REACH}
            onChange={(value) => setCutWindow(value === 'window')}
          />
        </Row>
        <p className="row-hint">
          El plano entero parte todo lo que cruza. Con recorte solo se corta lo que cae dentro de la
          ventana: separa un brazo sin tocar lo que haya detrás. Se coloca arrastrándola sobre la
          pieza, con los números de aquí abajo, o dibujando su contorno con el lápiz de la tarjeta;
          la posición a lo largo de la normal sigue en el mando de arriba.
        </p>
        {cut.window && selected ? (
          <>
            <Row label="Se separa" wide>
              <Segmented
                label="Lado que se separa"
                value={cut.window.side > 0 ? 'plus' : 'minus'}
                columns={2}
                options={[
                  { value: 'minus' as const, label: axis ? `Hacia −${AXIS_LETTERS[AXIS_OF[axis]]}` : 'Lado −' },
                  { value: 'plus' as const, label: axis ? `Hacia +${AXIS_LETTERS[AXIS_OF[axis]]}` : 'Lado +' },
                ]}
                onChange={(value) => setCut({ window: { ...cut.window!, side: value === 'plus' ? 1 : -1 } })}
              />
            </Row>
            <NumberSlider
              label="Profundidad"
              value={cut.window.depth ?? Math.ceil(depthAlong(selected, cut.normal))}
              min={1}
              max={Math.ceil(depthAlong(selected, cut.normal))}
              step={1}
              unit="mm"
              onChange={(value) => {
                const full = Math.ceil(depthAlong(selected, cut.normal));
                setCut({ window: { ...cut.window!, depth: value >= full ? null : value } });
              }}
            />
            <p className="row-hint">
              {cut.window.depth === null
                ? 'Al máximo, el recorte llega hasta el final de la pieza: eso separa una extremidad entera. Bájalo para llevarte solo un trozo, como media pata.'
                : `Se lleva solo los ${cut.window.depth} mm que siguen al plano; lo que haya más allá se queda.`}
            </p>
            {cut.window.anchors ? (
              <p className="row-hint">
                {cut.window.anchors.length < 3
                  ? `${cut.window.anchors.length} ${cut.window.anchors.length === 1 ? 'punto' : 'puntos'} sobre la pieza: un contorno necesita al menos tres. Pulsa D y sigue añadiendo.`
                  : `Contorno de ${cut.window.anchors.length} puntos pegados a la pieza. Arrástralos sobre ella para ajustarlo; con D añades más. Tocar el ancho, el alto o el centro lo descarta.`}
              </p>
            ) : cut.window.outline ? (
              <p className="row-hint">
                Contorno de {cut.window.outline.length} puntos, ya sin anclas. Tocar el ancho o el alto lo
                descarta y vuelve al rectángulo.
              </p>
            ) : null}
            {(['Ancho', 'Alto'] as const).map((label, i) => {
              const range = i === 0 ? cutFrame(selected, cut.normal).box.u : cutFrame(selected, cut.normal).box.v;
              return (
                <NumberSlider
                  key={`size-${label}`}
                  label={label}
                  value={cut.window!.size[i]!}
                  min={1}
                  max={Math.max(10, Math.ceil((range[1] - range[0]) * 1.5))}
                  step={1}
                  unit="mm"
                  onChange={(value) => {
                    const size: [number, number] = [...cut.window!.size];
                    size[i] = value;
                    // Pedir un tamaño es pedir un rectángulo: el contorno se va.
                    setCut({ window: { ...cut.window!, size, outline: null, anchors: null } });
                  }}
                />
              );
            })}
            {(['Centro (ancho)', 'Centro (alto)'] as const).map((label, i) => {
              const range = i === 0 ? cutFrame(selected, cut.normal).box.u : cutFrame(selected, cut.normal).box.v;
              return (
                <NumberSlider
                  key={`center-${label}`}
                  label={label}
                  value={cut.window!.center[i]!}
                  min={Math.floor(range[0])}
                  max={Math.ceil(range[1])}
                  step={1}
                  unit="mm"
                  onChange={(value) => {
                    const center: [number, number] = [...cut.window!.center];
                    center[i] = value;
                    moveCutWindow(center);
                  }}
                />
              );
            })}
          </>
        ) : null}
        <Toggle
          label="Conectores"
          checked={joint.enabled}
          hint="Se dimensionan sobre la sección real del corte, no sobre la caja de la pieza."
          onChange={(enabled) => setJoint({ enabled })}
        />
        {joint.enabled ? (
          <>
            <Row label="Modo" wide>
              <Segmented
                label="Modo del conector"
                value={joint.mode}
                columns={2}
                options={JOINT_MODES.map(({ value, label }) => ({ value, label }))}
                onChange={(mode) => setJoint({ mode })}
              />
            </Row>
            <Row label="Sección" wide>
              <Segmented
                label="Sección del conector"
                value={joint.shape}
                columns={5}
                options={SHAPE_OPTIONS}
                onChange={(value) => setJoint({ shape: value })}
              />
            </Row>
            <p className="row-hint">
              {shape?.label}: {shape?.hint} {JOINT_MODES.find((m) => m.value === joint.mode)?.hint}
            </p>
            <Row label="Cantidad" wide>
              <Segmented
                label="Conectores por corte"
                value={String(joint.count)}
                columns={5}
                options={[
                  { value: '0', label: 'Auto' },
                  { value: '1', label: '1' },
                  { value: '2', label: '2' },
                  { value: '3', label: '3' },
                  { value: '4', label: '4' },
                ]}
                onChange={(value) => setJoint({ count: Number(value) })}
              />
            </Row>
            <p className="row-hint">
              Se reparten por la sección lo más lejos posible unos de otros, que es lo que impide
              que las mitades giren. Salen solo los que quepan con pared entre ellos y el borde: si
              pides cuatro y caben dos, salen dos y se avisa.
            </p>
            <Toggle
              label="Tamaño automático"
              checked={joint.auto}
              hint="Diámetro ≈ 40 % del mayor círculo que cabe en la sección, entre 2 y 12 mm. Profundidad 1,6 diámetros, sin pasar del 45 % de cada mitad."
              onChange={(auto) => setJoint({ auto })}
            />
            {!joint.auto ? (
              <>
                <NumberSlider label="Diámetro" value={joint.diameter} min={2} max={20} step={0.5} decimals={1} unit="mm" onChange={(diameter) => setJoint({ diameter })} />
                <NumberSlider label="Profundidad" value={joint.depth} min={3} max={40} step={1} unit="mm" onChange={(depth) => setJoint({ depth })} />
                <p className="row-hint">
                  Si el conector pedido no deja pared suficiente, se encoge hasta que quepa y se avisa.
                </p>
              </>
            ) : null}
            <NumberSlider label="Holgura" value={joint.clearance} min={0} max={0.6} step={0.05} decimals={2} unit="mm" onChange={(clearance) => setJoint({ clearance })} />
          </>
        ) : null}
        <Button
          variant="default"
          disabled={!selected || working || engineDown}
          loading={working && busy === 'Cortando…'}
          onClick={() => void cutSelected()}
        >
          {selected ? `Cortar ${selected.name}` : 'Cortar la pieza elegida'}
        </Button>
      </Group>

      <Group
        title="Base"
        collapsible
        step={4}
        open={step === 'base'}
        onToggle={toggle('base')}
        summary={`${base.height} mm`}
      >
        <NumberSlider label="Grosor" value={base.height} min={0.5} max={20} step={0.5} decimals={1} unit="mm" onChange={(height) => setBase({ height })} />
        <NumberSlider label="Margen" value={base.margin} min={0} max={30} step={1} unit="mm" onChange={(margin) => setBase({ margin })} />
        <p className="row-hint">
          Una placa bajo la pieza, unida a ella. Sirve de raft para figuras de pie pequeño.
        </p>
        <Button variant="default" disabled={!selected || working || engineDown} onClick={() => void addBase()}>
          {selected ? `Añadir base a ${selected.name}` : 'Añadir base a la elegida'}
        </Button>
      </Group>

      <Group
        title="Exportar"
        collapsible
        step={5}
        open={step === 'exportar'}
        onToggle={toggle('exportar')}
        summary={format.toUpperCase()}
      >
        <Row label="Formato" wide>
          <Segmented
            label="Formato de salida"
            value={format}
            columns={3}
            options={[
              { value: 'stl' as const, label: 'STL' },
              { value: '3mf' as const, label: '3MF' },
              { value: 'obj' as const, label: 'OBJ' },
            ]}
            onChange={setFormat}
          />
        </Row>
        <p className="row-hint">
          {format === '3mf'
            ? 'Un solo archivo con todas las piezas y su color. Lo que entienden Bambu Studio, PrusaSlicer y Cura.'
            : format === 'stl'
              ? 'Un archivo por pieza, binario. Sin color: el estándar de siempre.'
              : 'Un archivo por pieza, en texto. Cómodo para revisar o editar a mano.'}
        </p>
        <Button variant="primary" disabled={noPart} loading={exporting} onClick={() => void exportAll()}>
          <DownloadIcon />
          {format === '3mf'
            ? `Guardar ${parts.length === 1 ? 'la pieza' : `las ${parts.length} piezas`} en un 3MF`
            : parts.length > 1
              ? `Guardar las ${parts.length} piezas`
              : 'Guardar'}
        </Button>
        {broken > 0 ? (
          <p className="row-hint">
            <AlertIcon /> {broken === 1 ? 'Hay una pieza abierta' : `Hay ${broken} piezas abiertas`}: el slicer la cerrará a su manera.
          </p>
        ) : null}
      </Group>
    </div>
  );
}
