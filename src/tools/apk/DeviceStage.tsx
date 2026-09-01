/*
 * Zona central: los dispositivos y lo que le pasa a cada uno.
 *
 * Antes de que haya nada que listar, esta zona es la que explica cómo se levanta el
 * puente. Un estado vacío que solo dice «no hay dispositivos» sería inútil aquí:
 * la causa casi siempre es que falta el proceso local, y decirlo es el trabajo.
 */

import { useState, type ReactNode } from 'react';
import {
  AlertIcon,
  BrokenIcon,
  CheckIcon,
  InfoIcon,
  PhoneIcon,
  PlugIcon,
  RefreshIcon,
  StopIcon,
  WirelessIcon,
} from '../../components/Icons.tsx';
import { Button } from '../../components/controls.tsx';
import { formatBytes, isBlocked, worstSeverity, type DeviceCheck } from './checks.ts';
import type { BridgeDevice } from '../../bridge/protocol.ts';
import { useApk, type DeviceJob } from './store.tsx';

const BRIDGE_COMMAND = 'npx jujo-adb-bridge';

function CheckLine({ check }: { check: DeviceCheck }): ReactNode {
  const Symbol =
    check.severity === 'blocked' ? BrokenIcon : check.severity === 'warning' ? AlertIcon : InfoIcon;
  return (
    <li className={`device-check is-${check.severity}`}>
      <Symbol />
      <span>{check.message}</span>
    </li>
  );
}

/** Lo que se ve cuando el puente todavía no está. */
function BridgeGate(): ReactNode {
  const { status, config, setConfig, retry } = useApk();
  const [token, setToken] = useState('');
  const [port, setPort] = useState(String(config.port));
  const [copied, setCopied] = useState(false);

  const command = port === '8787' ? BRIDGE_COMMAND : `${BRIDGE_COMMAND} --port ${port}`;

  const explanation = ((): { title: string; body: ReactNode } => {
    switch (status.kind) {
      case 'no-adb':
        return {
          title: 'El puente está, pero no encuentra adb',
          body: (
            <>
              <p>{status.message}</p>
              <p>
                Las platform-tools de Android traen el binario. Si ya lo tienes, arranca el
                puente apuntándole: <code>{command} --adb "ruta/al/adb"</code>
              </p>
            </>
          ),
        };
      case 'protocol-mismatch':
        return {
          title: 'El puente habla otra versión',
          body: (
            <p>
              El puente usa el protocolo {status.theirs} y esta app el {status.ours}. Actualiza el
              que se haya quedado atrás; forzarlo daría fallos difíciles de leer.
            </p>
          ),
        };
      case 'needs-token':
        return {
          title: 'Falta el token de emparejamiento',
          body: (
            <p>
              El puente lo imprime al arrancar. Sin él, cualquier página abierta en tu navegador
              podría pedirle que instale cosas en tus dispositivos.
            </p>
          ),
        };
      case 'reconnecting':
        return {
          title: 'Se perdió la conexión con el puente',
          body: <p>Reintentando ({status.attempt}). Si cerraste la terminal, vuelve a abrirla.</p>,
        };
      default:
        return {
          title: 'El puente no está corriendo',
          body: (
            <p>
              La app no puede hablar con adb desde el navegador. Este proceso local hace de
              intermediario usando el adb que ya tienes instalado, y solo acepta conexiones desde
              tu propio equipo.
            </p>
          ),
        };
    }
  })();

  return (
    <div className="gate">
      <div className="gate-card">
        <span className="gate-icon" aria-hidden="true">
          <PlugIcon />
        </span>
        <h2>{explanation.title}</h2>
        <div className="gate-body">{explanation.body}</div>

        <div className="gate-command">
          <code>{command}</code>
          <Button
            variant="ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(command).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
          >
            {copied ? 'Copiado' : 'Copiar'}
          </Button>
        </div>

        <form
          className="gate-form"
          onSubmit={(event) => {
            event.preventDefault();
            setConfig({ port: Number(port) || 8787, token: token.trim() || config.token });
          }}
        >
          <label className="row-label" htmlFor="bridge-token">
            Token que imprimió el puente
          </label>
          <div className="gate-fields">
            <input
              id="bridge-token"
              className="text-input value"
              value={token}
              placeholder={config.token ? '•••••••• (ya guardado)' : 'pégalo aquí'}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setToken(event.target.value)}
            />
            <input
              className="text-input value gate-port"
              value={port}
              inputMode="numeric"
              aria-label="Puerto del puente"
              onChange={(event) => setPort(event.target.value)}
            />
            <Button variant="primary" type="submit">
              Conectar
            </Button>
          </div>
        </form>

        <Button variant="ghost" onClick={retry}>
          <RefreshIcon />
          Volver a comprobar
        </Button>
      </div>
    </div>
  );
}

function PhaseLabel({ job }: { job: DeviceJob }): ReactNode {
  if (job.result) return <>{job.result.ok ? 'Instalado' : 'Falló'}</>;
  switch (job.phase) {
    case 'uninstalling':
      return <>Desinstalando la versión anterior…</>;
    case 'transferring':
      return job.percent === null ? <>Transfiriendo…</> : <>Transfiriendo {job.percent}%</>;
    default:
      return <>Preparando…</>;
  }
}

function DeviceRow({ device }: { device: BridgeDevice }): ReactNode {
  const { selected, toggleDevice, checksFor, apk, job, setFlag, install } = useApk();
  const checks = apk ? checksFor(device.serial) : [];
  const blocked = isBlocked(checks);
  const severity = worstSeverity(checks);
  const state = job?.devices[device.serial] ?? null;
  const busy = state !== null && !state.result;

  const name = device.details?.model ?? device.model ?? device.serial;

  return (
    <li className={`device${blocked ? ' is-blocked' : ''}${busy ? ' is-busy' : ''}`}>
      <label className="device-pick">
        <input
          type="checkbox"
          checked={selected.has(device.serial)}
          disabled={blocked || device.state !== 'device' || busy}
          onChange={() => toggleDevice(device.serial)}
          aria-label={`Seleccionar ${name}`}
        />
      </label>

      <span className="device-icon" aria-hidden="true">
        {device.transport === 'tcp' ? <WirelessIcon /> : <PhoneIcon />}
      </span>

      <div className="device-main">
        <p className="device-name">
          {name}
          {severity ? <span className={`device-badge is-${severity}`}>{severity === 'blocked' ? 'no compatible' : severity === 'warning' ? 'con aviso' : 'listo'}</span> : null}
        </p>
        <p className="device-meta value">
          {device.serial}
          {device.details?.release ? ` · Android ${device.details.release}` : ''}
          {device.details?.sdk ? ` (API ${device.details.sdk})` : ''}
          {device.freeSpace !== null ? ` · ${formatBytes(device.freeSpace)} libres` : ''}
        </p>

        {checks.length > 0 ? (
          <ul className="device-checks">
            {checks.map((check) => (
              <CheckLine check={check} key={check.id} />
            ))}
          </ul>
        ) : null}

        {state ? (
          <div className="device-job">
            <div className="device-progress" role="progressbar" aria-label={`Progreso en ${name}`}>
              <span
                className={`device-bar${state.percent === null && !state.result ? ' is-indeterminate' : ''}${
                  state.result ? (state.result.ok ? ' is-ok' : ' is-failed') : ''
                }`}
                style={state.percent !== null ? { width: `${state.percent}%` } : undefined}
              />
            </div>
            <p className={`device-phase${state.result && !state.result.ok ? ' is-failed' : ''}`}>
              {state.result?.ok ? <CheckIcon /> : state.result ? <BrokenIcon /> : null}
              <PhaseLabel job={state} />
            </p>
            {state.result && !state.result.ok ? (
              <>
                <p className="device-failure">{state.result.message}</p>
                {state.result.flag ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setFlag(state.result!.flag!, true);
                      void install();
                    }}
                  >
                    {state.result.flagLabel} y reintentar
                  </Button>
                ) : null}
                {state.result.output ? (
                  <details className="device-output">
                    <summary>Salida de adb</summary>
                    <pre className="value">{state.result.output}</pre>
                  </details>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function DeviceStage(): ReactNode {
  const {
    status,
    devices,
    devicesError,
    apk,
    selected,
    selectAllInstallable,
    refreshDevices,
    job,
    install,
    cancel,
    dismissJob,
    checksFor,
  } = useApk();

  if (status.kind !== 'connected') return <BridgeGate />;

  const installable = devices.filter(
    (device) => device.state === 'device' && apk && !isBlocked(checksFor(device.serial)),
  );
  const running = job !== null && !job.finished;
  const chosen = [...selected];

  return (
    <div className="devices">
      <div className="devices-head">
        <h2>
          Dispositivos
          <span className="devices-count value">{devices.length}</span>
        </h2>
        <div className="devices-actions">
          <Button variant="ghost" onClick={() => void refreshDevices()}>
            <RefreshIcon />
            Actualizar
          </Button>
          {apk && installable.length > 1 ? (
            <Button variant="ghost" onClick={selectAllInstallable}>
              Seleccionar los {installable.length} compatibles
            </Button>
          ) : null}
        </div>
      </div>

      {devicesError ? (
        <p className="row-error" role="alert">
          {devicesError}
        </p>
      ) : null}

      {devices.length === 0 ? (
        <div className="devices-empty">
          <PhoneIcon />
          <p>No hay ningún dispositivo conectado.</p>
          <p className="row-hint">
            Conecta uno por cable con la depuración USB activada, o añade uno por red desde el
            panel de la derecha. Aparecerá aquí solo, sin recargar nada.
          </p>
        </div>
      ) : (
        <ul className="device-list">
          {devices.map((device) => (
            <DeviceRow device={device} key={device.serial} />
          ))}
        </ul>
      )}

      <div className="devices-foot">
        {job?.error ? (
          <p className="row-error" role="alert">
            {job.error}
          </p>
        ) : null}

        {running && job.uploadFraction < 1 ? (
          <div className="upload-progress">
            <div className="device-progress">
              <span className="device-bar" style={{ width: `${Math.round(job.uploadFraction * 100)}%` }} />
            </div>
            <p className="row-hint">
              Enviando el APK al puente · {Math.round(job.uploadFraction * 100)}%
            </p>
          </div>
        ) : null}

        <div className="devices-cta">
          {running ? (
            <Button variant="danger" onClick={() => void cancel()}>
              <StopIcon />
              Cancelar
            </Button>
          ) : job?.finished ? (
            <Button variant="ghost" onClick={dismissJob}>
              Cerrar el resultado
            </Button>
          ) : null}

          <Button
            variant="primary"
            disabled={!apk || chosen.length === 0 || running}
            onClick={() => void install()}
          >
            {chosen.length > 1
              ? `Instalar en ${chosen.length} dispositivos`
              : 'Instalar'}
          </Button>
        </div>

        {!apk ? (
          <p className="row-hint">Carga un APK arriba para poder instalar.</p>
        ) : chosen.length === 0 ? (
          <p className="row-hint">Marca al menos un dispositivo.</p>
        ) : null}
      </div>
    </div>
  );
}
