/*
 * Zona superior: el APK.
 *
 * Mismo papel que la barra de contenido del generador de QR. Elegir el archivo son
 * cinco segundos; lo que importa después es lo que dice de él.
 */

import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { AlertIcon, InfoIcon, PackageIcon, UploadIcon } from '../../components/Icons.tsx';
import { Button } from '../../components/controls.tsx';
import { formatBytes } from './checks.ts';
import { useApk } from './store.tsx';

function Fact({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="apk-fact">
      <dt>{label}</dt>
      <dd className="value">{value}</dd>
    </div>
  );
}

export function ApkInput(): ReactNode {
  const { apk, apkError, apkChecks, loadingApk, openFile, clearApk, library } = useApk();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const take = (files: FileList | null | undefined): void => {
    const file = files?.[0];
    if (file) void openFile(file);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    take(event.dataTransfer.files);
  };

  return (
    <section
      className={`content-bar apk-bar${dragging ? ' is-dragging' : ''}`}
      aria-label="APK a instalar"
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
        accept=".apk,application/vnd.android.package-archive"
        className="visually-hidden"
        onChange={(event) => {
          take(event.target.files);
          event.target.value = '';
        }}
      />

      {loadingApk ? (
        <div className="apk-summary">
          <span className="skeleton skeleton-logo" />
          <div className="apk-headline">
            <p className="apk-name">Leyendo el manifiesto…</p>
            <p className="row-hint">Se lee en tu equipo; el archivo aún no ha salido de aquí.</p>
          </div>
        </div>
      ) : apk ? (
        <div className="apk-summary">
          <span className="apk-icon" aria-hidden="true">
            <PackageIcon />
          </span>
          <div className="apk-headline">
            <p className="apk-name" title={apk.info.filename}>
              {apk.info.label ?? apk.info.packageName ?? apk.info.filename}
            </p>
            <p className="row-hint">{apk.info.filename}</p>
          </div>
          <dl className="apk-facts">
            {apk.info.packageName ? <Fact label="Paquete" value={apk.info.packageName} /> : null}
            <Fact
              label="Versión"
              value={`${apk.info.versionName ?? '—'}${
                apk.info.versionCode !== null ? ` (${apk.info.versionCode})` : ''
              }`}
            />
            <Fact label="Mínimo" value={apk.info.minSdk !== null ? `API ${apk.info.minSdk}` : '—'} />
            <Fact
              label="Arquitectura"
              value={apk.info.abis.length > 0 ? apk.info.abis.join(', ') : 'universal'}
            />
            <Fact label="Tamaño" value={formatBytes(apk.info.size)} />
          </dl>
          <div className="apk-actions">
            <Button variant="ghost" onClick={() => input.current?.click()}>
              Cambiar
            </Button>
            <Button variant="ghost" onClick={clearApk}>
              Quitar
            </Button>
          </div>
        </div>
      ) : (
        <div className="apk-drop">
          <span className="apk-icon" aria-hidden="true">
            <UploadIcon />
          </span>
          <div className="apk-headline">
            <p className="apk-name">Arrastra un APK aquí</p>
            <p className="row-hint">
              {library.length > 0
                ? 'O elígelo del disco, o recupera uno de la biblioteca en el panel.'
                : 'Se lee en tu equipo antes de enviarlo a ningún sitio.'}
            </p>
          </div>
          <Button variant="default" onClick={() => input.current?.click()}>
            <UploadIcon />
            Elegir archivo
          </Button>
        </div>
      )}

      {apkError ? (
        <p className="row-error" role="alert">
          <AlertIcon /> {apkError}
        </p>
      ) : null}

      {apkChecks.map((check) => (
        <p className="apk-note" key={check.id}>
          <InfoIcon />
          {check.message}
        </p>
      ))}
    </section>
  );
}
