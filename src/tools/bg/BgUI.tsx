/*
 * Interfaz del recortador.
 *
 * Mismas tres zonas que el resto de la navaja. Lo propio de aquí es que la rejilla
 * muestra el recorte sobre damero, que es la única forma honesta de enseñar
 * transparencia, y que cada ficha deja comparar con la original: un recorte se
 * juzga por el borde, y el borde no se ve en una miniatura sin referencia.
 */

import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Button, ColorField, Group, NumberSlider, Row, Segmented, Toggle } from '../../components/controls.tsx';
import {
  AlertIcon,
  BrokenIcon,
  CheckIcon,
  DownloadIcon,
  InfoIcon,
  PackageIcon,
  RefreshIcon,
  TrashIcon,
  UploadIcon,
} from '../../components/Icons.tsx';
import { formatBytes } from '../apk/checks.ts';
import { MODELS, findModel } from './models.ts';
import { useBg, type BgItem } from './store.tsx';

/* ------------------------------------------------------------- Zona de entrada */

export function BgInput(): ReactNode {
  const { items, addFiles, clearAll, busy, warning, modelStatus } = useBg();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const done = items.filter((item) => item.status === 'done').length;
  const failed = items.filter((item) => item.status === 'failed').length;

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    setDragging(false);
    void addFiles(event.dataTransfer.files);
  };

  return (
    <section
      className={`content-bar bg-bar${dragging ? ' is-dragging' : ''}`}
      aria-label="Imágenes a recortar"
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
        accept="image/*"
        multiple
        className="visually-hidden"
        onChange={(event) => {
          void addFiles(event.target.files ?? []);
          event.target.value = '';
        }}
      />

      <div className="bg-drop">
        <span className="apk-icon" aria-hidden="true">
          <UploadIcon />
        </span>
        <div className="apk-headline">
          <p className="apk-name">
            {items.length === 0
              ? 'Arrastra imágenes aquí'
              : `${items.length} ${items.length === 1 ? 'imagen' : 'imágenes'}`}
          </p>
          <p className="row-hint">
            {items.length === 0
              ? 'Varias a la vez. Se recortan en tu equipo; no salen de aquí.'
              : `${done} listas${failed > 0 ? ` · ${failed} con error` : ''}${busy ? ' · trabajando…' : ''}`}
          </p>
        </div>
        <div className="apk-actions">
          <Button variant="default" onClick={() => input.current?.click()}>
            <UploadIcon />
            Añadir imágenes
          </Button>
          {items.length > 0 ? (
            <Button variant="ghost" onClick={clearAll}>
              <TrashIcon />
              Vaciar
            </Button>
          ) : null}
        </div>
      </div>

      {modelStatus.kind === 'loading' ? (
        <div className="bg-loading">
          <div className="device-progress">
            <span
              className={`device-bar${modelStatus.progress > 0 ? '' : ' is-indeterminate'}`}
              style={modelStatus.progress > 0 ? { width: `${modelStatus.progress}%` } : undefined}
            />
          </div>
          <p className="row-hint">
            Descargando el modelo · {modelStatus.progress}%
            {modelStatus.file ? ` · ${modelStatus.file}` : ''} — solo la primera vez, luego queda
            en caché.
          </p>
        </div>
      ) : null}

      {modelStatus.kind === 'failed' ? (
        <p className="row-error" role="alert">
          <AlertIcon /> No se pudo cargar el modelo: {modelStatus.message}
        </p>
      ) : null}

      {warning ? (
        <p className="apk-note">
          <InfoIcon />
          {warning}
        </p>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------------------------- Escena */

function ItemCard({ item }: { item: BgItem }): ReactNode {
  const { removeItem, retry, exportOne, options } = useBg();
  const [showOriginal, setShowOriginal] = useState(false);
  const thin = item.coverage !== null && item.coverage < 0.01;

  return (
    <li className={`shot is-${item.status}`}>
      <div
        className={`shot-frame${options.background ? '' : ' is-checkered'}`}
        onPointerDown={() => setShowOriginal(true)}
        onPointerUp={() => setShowOriginal(false)}
        onPointerLeave={() => setShowOriginal(false)}
      >
        {item.status === 'done' && item.previewUrl ? (
          <img
            src={showOriginal ? item.sourceUrl : item.previewUrl}
            alt={`Recorte de ${item.name}`}
            draggable={false}
          />
        ) : item.sourceUrl ? (
          <img className="shot-waiting" src={item.sourceUrl} alt={item.name} draggable={false} />
        ) : (
          <span className="shot-broken" aria-hidden="true">
            <BrokenIcon />
          </span>
        )}

        {item.status === 'running' ? <span className="shot-scan" aria-hidden="true" /> : null}

        {item.status === 'done' ? (
          <span className="shot-hint">mantén pulsado para ver la original</span>
        ) : null}
      </div>

      <div className="shot-body">
        <p className="shot-name" title={item.name}>
          {item.name}
        </p>
        <p className="shot-meta value">
          {item.width > 0 ? `${item.width}×${item.height}` : '—'}
          {' · '}
          {formatBytes(item.file.size)}
          {item.ms !== null ? ` · ${(item.ms / 1000).toFixed(1)} s` : ''}
        </p>

        {item.status === 'failed' ? (
          <p className="shot-problem">
            <BrokenIcon /> {item.error}
          </p>
        ) : null}
        {thin ? (
          <p className="shot-problem is-warning">
            <AlertIcon /> El modelo casi no encontró sujeto. Prueba otro modelo del panel.
          </p>
        ) : null}

        <div className="shot-actions">
          {item.status === 'done' ? (
            <Button variant="ghost" onClick={() => void exportOne(item.id)}>
              <DownloadIcon />
              Guardar
            </Button>
          ) : item.status === 'failed' ? (
            <Button variant="ghost" onClick={() => retry(item.id)}>
              <RefreshIcon />
              Reintentar
            </Button>
          ) : (
            <span className="row-hint">
              {item.status === 'running' ? 'Recortando…' : 'En cola'}
            </span>
          )}
          <button
            type="button"
            className="icon-btn"
            title="Quitar"
            aria-label={`Quitar ${item.name}`}
            onClick={() => removeItem(item.id)}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </li>
  );
}

export function BgStage(): ReactNode {
  const { items, modelStatus } = useBg();

  if (items.length === 0) {
    return (
      <div className="bg-stage">
        <div className="devices-empty">
          <PackageIcon />
          <p>Sin imágenes todavía.</p>
          <p className="row-hint">
            Suelta varias arriba. El modelo corre en tu navegador con la GPU si la hay, así que
            las imágenes no se suben a ningún servidor: lo único que se descarga, una vez, son
            los pesos del modelo.
          </p>
          {modelStatus.kind === 'ready' ? (
            <p className="row-hint">
              <CheckIcon /> Modelo listo en {modelStatus.device === 'webgpu' ? 'GPU' : 'CPU'}.
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-stage">
      <ul className="shot-grid">
        {items.map((item) => (
          <ItemCard item={item} key={item.id} />
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------------------- Panel */

export function BgPanel(): ReactNode {
  const { modelId, setModelId, modelStatus, loadModel, options, setOption, items, exportAll, exporting } =
    useBg();
  const model = findModel(modelId);
  const ready = items.filter((item) => item.status === 'done').length;

  return (
    <div className="panel-scroll">
      <Group title="Modelo">
        <div className="model-list">
          {MODELS.map((candidate) => (
            <label
              key={candidate.id}
              className={`model-option${candidate.id === modelId ? ' is-selected' : ''}`}
            >
              <input
                type="radio"
                name="bg-model"
                checked={candidate.id === modelId}
                onChange={() => setModelId(candidate.id)}
              />
              <span className="model-text">
                <span className="model-name">
                  {candidate.name}
                  <span className={`model-license is-${candidate.license}`}>
                    {candidate.licenseName}
                  </span>
                </span>
                <span className="row-hint">{candidate.blurb}</span>
                <span className="model-size value">{candidate.size} MB</span>
              </span>
            </label>
          ))}
        </div>

        {model.license === 'no-comercial' ? (
          <p className="apk-note">
            <AlertIcon />
            Este modelo no permite uso comercial. Para trabajo de cliente elige uno de los
            permisivos.
          </p>
        ) : null}

        <dl className="readout">
          <div>
            <dt>Estado</dt>
            <dd className="value">
              {modelStatus.kind === 'ready'
                ? modelStatus.device === 'webgpu'
                  ? 'listo · GPU'
                  : 'listo · CPU'
                : modelStatus.kind === 'loading'
                  ? `cargando ${modelStatus.progress}%`
                  : modelStatus.kind === 'failed'
                    ? 'error'
                    : 'sin cargar'}
            </dd>
          </div>
        </dl>
        {modelStatus.kind !== 'ready' && modelStatus.kind !== 'loading' ? (
          <Button variant="default" onClick={loadModel}>
            Cargar el modelo
          </Button>
        ) : null}
      </Group>

      <Group title="Borde">
        <NumberSlider
          label="Suavizado"
          value={options.feather}
          min={0}
          max={8}
          step={0.5}
          decimals={1}
          unit="px"
          onChange={(value) => setOption('feather', value)}
        />
        <NumberSlider
          label="Ajuste"
          value={options.threshold}
          min={-40}
          max={40}
          step={1}
          unit="%"
          onChange={(value) => setOption('threshold', value)}
        />
        <p className="row-hint">
          Negativo come sujeto y quita halos del fondo viejo; positivo lo engorda y recupera
          pelo. Se aplica sobre la máscara, no sobre la imagen, así que no ensucia el color.
        </p>
      </Group>

      <Group title="Fondo">
        <Toggle
          label="Transparente"
          checked={options.background === null}
          hint="Alfa de verdad en el PNG. Desactívalo para poner un color plano."
          onChange={(value) => setOption('background', value ? null : '#ffffff')}
        />
        {options.background !== null ? (
          <Row label="Color">
            <ColorField
              label="Color de fondo"
              value={options.background}
              onChange={(hex) => setOption('background', hex)}
            />
          </Row>
        ) : null}
        <Toggle
          label="Recortar al sujeto"
          checked={options.trim}
          hint="Ajusta el encuadre a lo que quedó, sin margen sobrante."
          onChange={(value) => setOption('trim', value)}
        />
      </Group>

      <Group title="Salida">
        <Row label="Formato" wide>
          <Segmented
            label="Formato de salida"
            value={options.format}
            columns={2}
            options={[
              { value: 'png', label: 'PNG' },
              { value: 'webp', label: 'WebP' },
            ]}
            onChange={(value) => setOption('format', value)}
          />
        </Row>
        <p className="row-hint">
          PNG conserva la transparencia sin pérdida. WebP pesa bastante menos y también admite
          alfa, pero comprime con pérdida.
        </p>
        <Button
          variant="primary"
          disabled={ready === 0}
          loading={exporting}
          onClick={() => void exportAll()}
        >
          <DownloadIcon />
          {ready > 1 ? `Guardar las ${ready}` : 'Guardar'}
        </Button>
      </Group>
    </div>
  );
}
