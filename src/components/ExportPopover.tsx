/*
 * Exportación.
 *
 * Popover, no modal: la mesa ya mostraba los límites reales de la pieza, así que
 * esto confirma, no revela. Y bloquear la mesa para elegir un formato sería
 * exactamente el modal-como-primera-idea que DESIGN.md prohíbe.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { contentType } from '../lib/content.ts';
import {
  downloadBlob,
  embeddedFontsFor,
  safeFilename,
  svgToPngBlob,
  textMeasurer,
} from '../lib/export.ts';
import { renderSvg } from '../lib/render.ts';
import type { CaptionFont } from '../lib/types.ts';
import { useStore } from '../state/store.tsx';
import { Button, Popover, Row, Segmented } from './controls.tsx';
import { BrokenIcon, DownloadIcon } from './Icons.tsx';

type Format = 'svg' | 'png';

/** Píxeles por módulo en 1×. A 12 px un QR corriente sale sobre 500 px de lado. */
const BASE_PX = 12;

export function ExportPopover(): ReactNode {
  const { state, derived, recordExport } = useStore();
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<Format>('svg');
  const [scale, setScale] = useState<'1' | '2' | '4'>('2');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const type = contentType(state.typeId);
  const values = state.valuesByType[state.typeId];
  const blocked = derived.validation?.severity === 'broken' || derived.result === null;

  const geometry = useMemo(() => {
    const size = derived.result?.matrix.size ?? state.matrixSize;
    const width = size + state.design.quietZone * 2;
    return { width, height: width * derived.aspect };
  }, [derived.result, derived.aspect, state.design.quietZone, state.matrixSize]);

  const pngWidth = Math.round(geometry.width * BASE_PX * Number(scale));
  const pngHeight = Math.round(geometry.height * BASE_PX * Number(scale));
  const filename = safeFilename(name || type.summarize(values), format);

  const run = async (): Promise<void> => {
    if (!derived.result) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const design = state.design;
      // Solo las fuentes que la pieza usa de verdad: embeber las tres subiría el
      // archivo unos 150 KB por nada.
      const needed: CaptionFont[] = [];
      if (design.caption.trim() !== '' || design.subcaption.trim() !== '') {
        needed.push(design.captionFont);
      }
      if (!design.logo && design.centerText.trim() !== '') needed.push(design.centerTextFont);
      const fontCss = needed.length > 0 ? await embeddedFontsFor(needed) : '';

      const rendered = renderSvg(derived.result.matrix, design, {
        measureText: textMeasurer(),
        embeddedFontCss: fontCss,
        title: `Código QR: ${type.summarize(values)}`,
        pixelWidth: format === 'png' ? pngWidth : geometry.width * BASE_PX,
      });

      if (format === 'svg') {
        downloadBlob(
          new Blob([rendered.svg], { type: 'image/svg+xml;charset=utf-8' }),
          filename,
        );
      } else {
        downloadBlob(await svgToPngBlob(rendered.svg, pngWidth, pngHeight), filename);
      }
      await recordExport();
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo exportar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="export-anchor">
      <Button
        ref={triggerRef}
        variant="primary"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={derived.result === null}
        onClick={() => {
          setOpen((value) => !value);
          setDone(false);
        }}
      >
        <DownloadIcon />
        Exportar
      </Button>

      <Popover
        open={open}
        align="end"
        labelledBy="export-title"
        onClose={() => {
          setOpen(false);
          triggerRef.current?.focus();
        }}
      >
        <h2 className="popover-title" id="export-title">
          Exportar
        </h2>

        {blocked ? (
          <p className="export-block" role="alert">
            <BrokenIcon />
            La pieza no va a escanear. Resuelve lo que dice la tira antes de exportar.
          </p>
        ) : null}

        <Row label="Formato" wide>
          <Segmented
            label="Formato de exportación"
            value={format}
            columns={2}
            options={[
              { value: 'svg', label: 'SVG' },
              { value: 'png', label: 'PNG' },
            ]}
            onChange={(value) => setFormat(value)}
          />
        </Row>

        {format === 'png' ? (
          <Row label="Escala" wide>
            <Segmented
              label="Escala del PNG"
              value={scale}
              columns={3}
              options={[
                { value: '1', label: `1× · ${Math.round(geometry.width * BASE_PX)} px` },
                { value: '2', label: `2× · ${Math.round(geometry.width * BASE_PX * 2)} px` },
                { value: '4', label: `4× · ${Math.round(geometry.width * BASE_PX * 4)} px` },
              ]}
              onChange={setScale}
            />
          </Row>
        ) : null}

        <Row label="Nombre del archivo" htmlFor="export-name" wide>
          <input
            id="export-name"
            className="text-input"
            data-autofocus
            value={name}
            placeholder={type.summarize(values)}
            onChange={(event) => setName(event.target.value)}
          />
        </Row>

        <dl className="readout">
          <div>
            <dt>Archivo</dt>
            <dd className="value">{filename}</dd>
          </div>
          <div>
            <dt>{format === 'png' ? 'Píxeles' : 'Vectorial'}</dt>
            <dd className="value">
              {format === 'png'
                ? `${pngWidth} × ${pngHeight}`
                : `${geometry.width} × ${Math.round(geometry.height * 100) / 100} mód.`}
            </dd>
          </div>
          {state.design.bgTransparent ? (
            <div>
              <dt>Fondo</dt>
              <dd className="value">transparente</dd>
            </div>
          ) : null}
        </dl>

        {format === 'svg' ? (
          <p className="row-hint">
            La tipografía del texto va embebida en el archivo: se abre igual en
            Illustrator y en InDesign.
          </p>
        ) : null}

        {error ? (
          <p className="row-error" role="alert">
            {error}
          </p>
        ) : null}
        {done ? <p className="export-done">Descargado como {filename}.</p> : null}

        <Button variant="primary" loading={busy} disabled={blocked} onClick={() => void run()}>
          <DownloadIcon />
          Descargar {format.toUpperCase()}
        </Button>
      </Popover>
    </div>
  );
}
