/*
 * La mesa.
 *
 * The Artboard Is Not Themed Rule: la mesa cambia con el tema, la pieza no. El fondo
 * del QR es el color del usuario y punto; cuando es transparente se dibuja damero,
 * nunca el fondo del tema haciéndose pasar por transparencia.
 *
 * Las guías son cromo de vista previa y se ven distintas de la pieza a propósito:
 * no salen en la exportación.
 */

import { useRef, useState, type ReactNode } from 'react';
import { useStore } from '../state/store.tsx';
import { InfoIcon } from './Icons.tsx';

export function Table(): ReactNode {
  const { state, derived } = useStore();
  const [guides, setGuides] = useState(false);
  const lastGood = useRef<string>('');

  if (derived.svg !== '') lastGood.current = derived.svg;

  const stale = derived.svg === '' && lastGood.current !== '';
  const svg = derived.svg || lastGood.current;

  const size = derived.result?.matrix.size ?? state.matrixSize;
  const quiet = state.design.quietZone;
  const pieceWidth = size + quiet * 2;
  const pieceHeight = pieceWidth * derived.aspect;

  return (
    <div className="table">
      <div className="table-surface">
        {svg === '' ? (
          <p className="table-empty">
            Escribe algo arriba y la pieza aparece aquí.
          </p>
        ) : (
          <div
            className={`piece${stale ? ' is-stale' : ''}${
              state.design.bgTransparent ? ' is-transparent' : ''
            }`}
          >
            <div className="piece-art" dangerouslySetInnerHTML={{ __html: svg }} />
            {guides ? (
              <svg
                className="piece-guides"
                viewBox={`0 0 ${pieceWidth} ${pieceHeight}`}
                aria-hidden="true"
              >
                <rect
                  x={quiet}
                  y={quiet}
                  width={size}
                  height={size}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
                <rect
                  x="0.5"
                  y="0.5"
                  width={pieceWidth - 1}
                  height={pieceHeight - 1}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                  opacity="0.5"
                />
              </svg>
            ) : null}
          </div>
        )}
      </div>

      <div className="table-bar">
        <label className="guides-toggle">
          <input
            type="checkbox"
            checked={guides}
            onChange={(event) => setGuides(event.target.checked)}
          />
          <span>Guías</span>
        </label>
        {derived.result ? (
          <p className="table-readout">
            <span className="value">{pieceWidth}</span>
            <span aria-hidden="true"> × </span>
            <span className="value">{Math.round(pieceHeight * 100) / 100}</span>
            <span className="table-unit"> módulos</span>
            <span className="table-sep" aria-hidden="true">
              ·
            </span>
            zona de silencio <span className="value">{quiet}</span>
          </p>
        ) : null}
        {stale ? (
          <p className="table-note">
            <InfoIcon />
            Falta contenido. Se muestra la última pieza válida.
          </p>
        ) : null}
      </div>
    </div>
  );
}
