/*
 * Columna derecha: opciones de instalación, red y biblioteca.
 *
 * Mismo vocabulario de controles que el generador de QR: grupos, filas, toggles.
 * Que las dos herramientas se controlen igual es la mitad de la promesa de la navaja.
 */

import { useState, type ReactNode } from 'react';
import { Button, Group, Row, Toggle } from '../../components/controls.tsx';
import { PackageIcon, TrashIcon, WirelessIcon } from '../../components/Icons.tsx';
import { formatBytes } from './checks.ts';
import { useApk } from './store.tsx';

function BridgeStatusLine(): ReactNode {
  const { status } = useApk();
  const text = ((): string => {
    switch (status.kind) {
      case 'connected':
        return status.adb ? `adb ${status.adb.version}` : 'conectado';
      case 'checking':
        return 'buscando el puente…';
      case 'reconnecting':
        return `reconectando (${status.attempt})`;
      case 'absent':
        return 'sin puente';
      case 'needs-token':
        return 'falta el token';
      case 'no-adb':
        return 'sin adb';
      case 'protocol-mismatch':
        return 'versión incompatible';
      default:
        return 'inactivo';
    }
  })();

  return (
    <dl className="readout">
      <div>
        <dt>Puente</dt>
        <dd className="value">{status.kind === 'connected' ? 'conectado' : text}</dd>
      </div>
      {status.kind === 'connected' && status.adb ? (
        <div>
          <dt>adb</dt>
          <dd className="value">{status.adb.version}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function WirelessGroup(): ReactNode {
  const { connectAddress, devices, disconnectAddress } = useApk();
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const networkDevices = devices.filter((device) => device.transport === 'tcp');

  return (
    <Group title="Por red">
      <form
        className="wireless-form"
        onSubmit={(event) => {
          event.preventDefault();
          const value = address.trim();
          if (value === '') return;
          setBusy(true);
          setMessage(null);
          void connectAddress(value)
            .then((result) =>
              setMessage({ ok: result.ok, text: result.message ?? (result.ok ? 'Conectado.' : 'No se pudo conectar.') }),
            )
            .finally(() => setBusy(false));
        }}
      >
        <Row label="Dirección" htmlFor="adb-address" wide>
          <input
            id="adb-address"
            className="text-input value"
            value={address}
            placeholder="192.168.1.42:5555"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
          />
        </Row>
        <Button variant="default" type="submit" loading={busy}>
          <WirelessIcon />
          Conectar
        </Button>
      </form>

      {message ? (
        <p className={message.ok ? 'row-hint' : 'row-error'} role={message.ok ? undefined : 'alert'}>
          {message.text}
        </p>
      ) : (
        <p className="row-hint">
          En el móvil: Opciones de desarrollador, Depuración inalámbrica. Si pide emparejar,
          hazlo una vez con <code>adb pair</code> desde la terminal.
        </p>
      )}

      {networkDevices.length > 0 ? (
        <ul className="mini-list">
          {networkDevices.map((device) => (
            <li key={device.serial}>
              <span className="value" title={device.serial}>
                {device.details?.model ?? device.serial}
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Desconectar ${device.serial}`}
                title="Desconectar"
                onClick={() => void disconnectAddress(device.serial)}
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Group>
  );
}

function LibraryGroup(): ReactNode {
  const { library, libraryError, useLibraryEntry, dropLibraryEntry, apk } = useApk();

  return (
    <Group title="Biblioteca">
      {libraryError ? (
        <p className="row-error" role="alert">
          {libraryError}
        </p>
      ) : null}

      {library.length === 0 ? (
        <p className="row-hint">
          Los APK que cargues se guardan aquí, en este dispositivo, para que puedas volver a
          instalarlos sin buscar el archivo. Se conservan los doce últimos.
        </p>
      ) : (
        <ul className="mini-list">
          {library.map((entry) => (
            <li key={entry.id} className={entry.id === apk?.id ? 'is-current' : undefined}>
              <button
                type="button"
                className="library-pick"
                onClick={() => void useLibraryEntry(entry)}
                title={entry.info.filename}
              >
                <PackageIcon />
                <span className="library-text">
                  <span className="library-name">
                    {entry.info.label ?? entry.info.packageName ?? entry.info.filename}
                  </span>
                  <span className="library-meta value">
                    {entry.info.versionName ?? '—'} · {formatBytes(entry.info.size)}
                    {entry.installedOn.length > 0
                      ? ` · instalado en ${entry.installedOn.length}`
                      : ''}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Borrar ${entry.info.filename} de la biblioteca`}
                title="Borrar de la biblioteca"
                onClick={() => void dropLibraryEntry(entry.id)}
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Group>
  );
}

export function ApkPanel(): ReactNode {
  const { flags, setFlag, status } = useApk();

  return (
    <div className="panel-scroll">
      <Group title="Conexión">
        <BridgeStatusLine />
      </Group>

      <Group title="Instalación">
        <Toggle
          label="Reinstalar encima"
          checked={flags.reinstall}
          hint="Conserva los datos de la app. Sin esto, adb falla si ya está instalada."
          onChange={(value) => setFlag('reinstall', value)}
        />
        <Toggle
          label="Permitir bajar de versión"
          checked={flags.downgrade}
          hint="Necesario para poner una versión anterior. Borra los datos de la app."
          onChange={(value) => setFlag('downgrade', value)}
        />
        <Toggle
          label="Conceder todos los permisos"
          checked={flags.grantPermissions}
          hint="Otorga los permisos en tiempo de ejecución al instalar. Cómodo para QA."
          onChange={(value) => setFlag('grantPermissions', value)}
        />
        <Toggle
          label="Permitir APK de prueba"
          checked={flags.allowTest}
          hint="Para builds marcados como testOnly, lo habitual al compilar desde el IDE."
          onChange={(value) => setFlag('allowTest', value)}
        />
        <Toggle
          label="Desinstalar primero"
          checked={flags.uninstallFirst}
          hint="Única salida cuando la firma no coincide. Borra los datos de la app."
          onChange={(value) => setFlag('uninstallFirst', value)}
        />
      </Group>

      {status.kind === 'connected' ? <WirelessGroup /> : null}

      <LibraryGroup />
    </div>
  );
}
