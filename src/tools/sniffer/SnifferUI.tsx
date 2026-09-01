/*
 * Interfaz del capturador.
 *
 * Mismo vocabulario que las otras dos hojas: barra de entrada arriba, escena en el
 * centro, controles a la derecha. Lo específico de aquí es que la escena tiene dos
 * capas: lo que se ha pescado, que es lo que importa, y el logcat en crudo debajo,
 * plegado, para cuando no se pesca nada y hay que entender por qué.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useBridge } from '../../bridge/provider.tsx';
import { Button, Group, Row, SelectField, Toggle } from '../../components/controls.tsx';
import {
  AlertIcon,
  BrokenIcon,
  CheckIcon,
  DownloadIcon,
  HistoryIcon,
  InfoIcon,
  PhoneIcon,
  SearchIcon,
  StopIcon,
  TrashIcon,
} from '../../components/Icons.tsx';
import { formatBytes } from '../apk/checks.ts';
import { useSniffer, type Hit } from './store.tsx';

const KIND_LABEL: Record<string, string> = {
  direct: 'archivo directo',
  'hls-master': 'HLS con calidades',
  'hls-media': 'HLS',
  dash: 'DASH',
  unknown: 'tipo desconocido',
};

function seconds(value: number | null | undefined): string {
  if (!value) return '';
  const total = Math.round(value);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------ Zona de entrada */

export function SnifferInput(): ReactNode {
  const { devices, status } = useBridge();
  const { sessions, isRunning, start, stop, profiles, profileId, setProfileId, reconnecting, linesSeen } =
    useSniffer();
  const live = devices.filter((device) => device.state === 'device');
  const [serial, setSerial] = useState('');

  const target = serial || live[0]?.serial || '';
  const running = target !== '' && isRunning(target);

  return (
    <section className="content-bar sniffer-bar" aria-label="Escucha">
      <div className="sniffer-controls">
        <Row label="Dispositivo" wide>
          <SelectField
            label="Dispositivo a escuchar"
            value={target}
            options={
              live.length > 0
                ? live.map((device) => ({
                    value: device.serial,
                    label: device.label ?? device.details?.model ?? device.model ?? device.serial,
                  }))
                : [{ value: '', label: 'Ningún dispositivo conectado' }]
            }
            onChange={setSerial}
          />
        </Row>

        <Row label="Perfil" wide>
          <SelectField
            label="Perfil de escucha"
            value={profileId}
            options={profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
            onChange={setProfileId}
          />
        </Row>

        <div className="sniffer-actions">
          {running ? (
            <Button variant="danger" onClick={() => void stop(target)}>
              <StopIcon />
              Parar
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={target === '' || status.kind !== 'connected'}
              onClick={() => void start(target, profileId)}
            >
              <SearchIcon />
              Escuchar
            </Button>
          )}
        </div>
      </div>

      <div className="sniffer-status">
        {running ? (
          <>
            <span className="pulse" aria-hidden="true" />
            <span>
              Escuchando · <span className="value">{linesSeen.toLocaleString('es')}</span> líneas
              {sessions.length > 1 ? ` · ${sessions.length} sesiones` : ''}
            </span>
          </>
        ) : (
          <span className="row-hint">
            Arranca la escucha y reproduce algo en el dispositivo. Las URLs aparecen solas.
          </span>
        )}
        {reconnecting ? (
          <span className="sniffer-warn">
            <AlertIcon /> logcat se cortó, reintento {reconnecting.attempt}
          </span>
        ) : null}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- Escena */

function HitCard({ hit }: { hit: Hit }): ReactNode {
  const { captureUrl, cancelCapture, progress, ffmpeg } = useSniffer();
  const [copied, setCopied] = useState(false);
  const job = hit.captureId ? progress[hit.captureId] : null;
  const probe = hit.probe;
  const needsFfmpeg = probe?.kind !== 'direct' && probe?.ok === true;
  const blocked = probe?.encrypted === true || (needsFfmpeg && !ffmpeg);

  return (
    <li className="hit">
      <div className="hit-head">
        <span className={`hit-kind is-${probe?.kind ?? 'unknown'}`}>
          {hit.probing ? 'sondeando…' : probe?.ok ? (KIND_LABEL[probe.kind ?? 'unknown'] ?? probe.kind) : 'no responde'}
        </span>
        {probe?.size ? <span className="hit-meta value">{formatBytes(probe.size)}</span> : null}
        {probe?.variants && probe.variants.length > 0 ? (
          <span className="hit-meta">{probe.variants.length} calidades</span>
        ) : null}
        <span className="hit-time value">
          {new Date(hit.at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>

      <p className="hit-url value" title={hit.url}>
        {hit.url}
      </p>

      {probe?.ok === false ? (
        <p className="hit-problem">
          <BrokenIcon /> {probe.detail}
        </p>
      ) : null}
      {probe?.encrypted ? (
        <p className="hit-problem">
          <BrokenIcon /> El playlist está cifrado. Esta herramienta no descifra contenido protegido.
        </p>
      ) : needsFfmpeg && !ffmpeg ? (
        <p className="hit-problem">
          <AlertIcon /> Es un stream por segmentos y hace falta ffmpeg para unirlo.
        </p>
      ) : null}

      {probe?.variants && probe.variants.length > 0 ? (
        <ul className="hit-variants">
          {probe.variants.slice(0, 4).map((variant) => (
            <li key={variant.url}>
              <span className="value">{variant.resolution ?? 'sin resolución'}</span>
              {variant.bandwidth ? (
                <span className="row-hint"> {Math.round(variant.bandwidth / 1000)} kbps</span>
              ) : null}
              <Button variant="ghost" onClick={() => void captureUrl(variant.url, hit.serial)}>
                Bajar esta
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {job ? (
        <div className="hit-job">
          <div className="device-progress">
            <span
              className={`device-bar${job.result?.ok ? ' is-ok' : job.error ? ' is-failed' : ' is-indeterminate'}`}
              style={
                job.total && job.done ? { width: `${Math.min(100, (job.done / job.total) * 100)}%` } : undefined
              }
            />
          </div>
          <p className={`device-phase${job.error ? ' is-failed' : ''}`}>
            {job.result?.ok ? <CheckIcon /> : job.error ? <BrokenIcon /> : null}
            {job.error
              ? job.error
              : job.result
                ? `Guardado · ${formatBytes(job.result.size ?? 0)}${job.result.detail ? ` · ${job.result.detail}` : ''}`
                : job.total
                  ? `${formatBytes(job.done)} de ${formatBytes(job.total)}`
                  : job.phase === 'remuxing'
                    ? 'Uniendo segmentos…'
                    : `${formatBytes(job.done)} descargados`}
          </p>
          {!job.result && !job.error ? (
            <Button variant="ghost" onClick={() => void cancelCapture(job.id)}>
              Cancelar
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="hit-actions">
        <Button
          variant="default"
          disabled={hit.probing || blocked || probe?.ok === false || job !== null}
          onClick={() => void captureUrl(hit.url, hit.serial)}
        >
          <DownloadIcon />
          Descargar
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(hit.url).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copiada' : 'Copiar URL'}
        </Button>
      </div>
    </li>
  );
}

export function SnifferStage(): ReactNode {
  const { hits, clearHits, tail, sessions } = useSniffer();
  const tailRef = useRef<HTMLPreElement>(null);
  const [showTail, setShowTail] = useState(false);

  useEffect(() => {
    if (showTail && tailRef.current) tailRef.current.scrollTop = tailRef.current.scrollHeight;
  }, [tail, showTail]);

  return (
    <div className="sniffer">
      <div className="devices-head">
        <h2>
          Capturas
          <span className="devices-count value">{hits.length}</span>
        </h2>
        {hits.length > 0 ? (
          <Button variant="ghost" onClick={clearHits}>
            <TrashIcon />
            Vaciar la lista
          </Button>
        ) : null}
      </div>

      {hits.length === 0 ? (
        <div className="devices-empty">
          <PhoneIcon />
          <p>{sessions.length > 0 ? 'Escuchando. Todavía no ha pasado ninguna URL.' : 'Sin escucha activa.'}</p>
          <p className="row-hint">
            {sessions.length > 0
              ? 'Reproduce algo en el dispositivo. Si no aparece nada, abre el logcat de abajo para ver si el filtro es demasiado estrecho.'
              : 'Elige un dispositivo arriba y pulsa Escuchar.'}
          </p>
        </div>
      ) : (
        <ul className="hit-list">
          {hits.map((hit) => (
            <HitCard hit={hit} key={hit.url} />
          ))}
        </ul>
      )}

      <div className="tail">
        <button
          type="button"
          className="tail-toggle"
          aria-expanded={showTail}
          onClick={() => setShowTail((value) => !value)}
        >
          <InfoIcon />
          logcat en crudo
          <span className="devices-count value">{tail.length}</span>
        </button>
        {showTail ? (
          <pre className="tail-body value" ref={tailRef}>
            {tail.length === 0 ? 'Nada todavía.' : tail.join('\n')}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- Panel */

function ProfileEditor(): ReactNode {
  const { profiles, profileId, saveProfile, deleteProfile } = useSniffer();
  const current = profiles.find((profile) => profile.id === profileId);
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');
  const [pattern, setPattern] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(current ? `${current.name}${current.builtin ? ' (copia)' : ''}` : '');
    setFilter(current?.logFilter ?? '');
    setPattern(current?.pattern ?? '');
    setError(null);
  }, [current]);

  return (
    <Group title="Perfil">
      <Row label="Nombre" htmlFor="profile-name" wide>
        <input
          id="profile-name"
          className="text-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Row>
      <Row label="Pre-filtro" htmlFor="profile-filter" wide>
        <input
          id="profile-filter"
          className="text-input value"
          value={filter}
          placeholder="http"
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
        />
      </Row>
      <p className="row-hint">
        Texto que debe contener la línea para mirarla siquiera. Vacío significa todo el logcat.
      </p>
      <Row label="Regex" htmlFor="profile-pattern" wide>
        <input
          id="profile-pattern"
          className="text-input value"
          value={pattern}
          placeholder="url=&quot;([^&quot;]+)&quot;"
          spellCheck={false}
          onChange={(event) => setPattern(event.target.value)}
        />
      </Row>
      <p className="row-hint">
        Con un grupo entre paréntesis para la URL. Vacío usa la detección automática de
        mp4, m3u8, mpd y demás.
      </p>
      {error ? (
        <p className="row-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="sniffer-actions">
        <Button
          variant="default"
          onClick={() => {
            if (pattern.trim() !== '') {
              try {
                new RegExp(pattern);
              } catch (cause) {
                setError(`La expresión no compila: ${(cause as Error).message}`);
                return;
              }
            }
            setError(null);
            void saveProfile({
              // Un builtin nunca se sobrescribe: se guarda como copia propia.
              id: current && !current.builtin ? current.id : undefined,
              name: name.trim() || 'Perfil',
              logFilter: filter,
              pattern: pattern.trim() || null,
            });
          }}
        >
          Guardar perfil
        </Button>
        {current && !current.builtin ? (
          <Button variant="ghost" onClick={() => void deleteProfile(current.id)}>
            <TrashIcon />
            Borrar
          </Button>
        ) : null}
      </div>
    </Group>
  );
}

export function SnifferPanel(): ReactNode {
  const { autoDownload, setAutoDownload, history, clearHistory, reveal, downloadDir, ffmpeg } =
    useSniffer();

  return (
    <div className="panel-scroll">
      <Group title="Descarga">
        <Toggle
          label="Descargar automáticamente"
          checked={autoDownload}
          hint="Baja todo lo que se detecte y responda. Útil dejándolo corriendo; llena el disco si te olvidas."
          onChange={setAutoDownload}
        />
        <dl className="readout">
          <div>
            <dt>Carpeta</dt>
            <dd className="value" title={downloadDir ?? ''}>
              {downloadDir ? downloadDir.split(/[\\/]/).slice(-2).join('/') : '—'}
            </dd>
          </div>
          <div>
            <dt>ffmpeg</dt>
            <dd className="value">{ffmpeg ? 'disponible' : 'no está'}</dd>
          </div>
        </dl>
        {!ffmpeg ? (
          <p className="row-hint">
            Sin ffmpeg solo se pueden guardar archivos directos. Los streams por segmentos
            (HLS y DASH) necesitan unirse y eso lo hace ffmpeg.
          </p>
        ) : null}
        <Button variant="default" onClick={() => void reveal()}>
          Abrir la carpeta
        </Button>
      </Group>

      <ProfileEditor />

      <Group title="Historial">
        {history.length === 0 ? (
          <p className="row-hint">
            Lo que descargues queda aquí, con su tamaño y su duración, aunque cierres la app.
          </p>
        ) : (
          <ul className="mini-list">
            {history.slice(0, 12).map((capture) => (
              <li key={capture.id}>
                <span className="value" title={capture.url}>
                  {capture.path ? capture.path.split(/[\\/]/).pop() : capture.url.slice(0, 40)}
                </span>
                <span className="row-hint">
                  {capture.status === 'saved'
                    ? `${formatBytes(capture.size ?? 0)}${capture.duration ? ` · ${seconds(capture.duration)}` : ''}`
                    : capture.status}
                </span>
                {capture.path ? (
                  <button
                    type="button"
                    className="icon-btn"
                    title="Abrir en la carpeta"
                    aria-label={`Abrir ${capture.path}`}
                    onClick={() => void reveal(capture.path ?? undefined)}
                  >
                    <HistoryIcon />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {history.length > 0 ? (
          <Button variant="ghost" onClick={() => void clearHistory()}>
            <TrashIcon />
            Vaciar el historial
          </Button>
        ) : null}
      </Group>
    </div>
  );
}
