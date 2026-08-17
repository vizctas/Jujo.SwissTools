/*
 * La tira de validación. Adherida bajo la mesa, siempre visible.
 *
 * Es la función que da nombre al producto: cada mensaje dice problema, consecuencia
 * y acción en una línea, y trae la corrección aplicable. El estado nunca se comunica
 * solo por color: hay ícono, forma y texto.
 */

import type { ReactNode } from 'react';
import { formatRatio } from '../lib/color.ts';
import { useStore } from '../state/store.tsx';
import { AlertIcon, BrokenIcon, CheckIcon, InfoIcon } from './Icons.tsx';
import { Button } from './controls.tsx';

/**
 * Anuncia solo el estado, no el contenido de la tira. Poner `aria-live` sobre toda
 * la tira haría que un lector de pantalla recitara los hallazgos en cada pulsación;
 * lo que interesa anunciar es la transición: pasó a roto, volvió a verificado.
 */
function Announcer({ status }: { status: string }): ReactNode {
  return (
    <p className="visually-hidden" role="status" aria-live="polite">
      {status}
    </p>
  );
}

export function ValidationStrip(): ReactNode {
  const { state, dispatch, derived } = useStore();
  const { validation, encodeError, incomplete } = derived;

  if (incomplete) {
    return (
      <aside className="strip strip-idle">
        <Announcer status="Sin contenido" />
        <InfoIcon />
        <p>Completa el contenido para poder validar la pieza.</p>
      </aside>
    );
  }

  if (encodeError) {
    return (
      <aside className="strip strip-broken">
        <Announcer status="No se puede codificar" />
        <BrokenIcon />
        <div className="strip-body">
          <p className="strip-headline">No se puede codificar</p>
          <p>{encodeError.message}</p>
        </div>
      </aside>
    );
  }

  if (!validation) return null;

  const tone =
    validation.severity === 'ok'
      ? 'ok'
      : validation.severity === 'warning'
        ? 'warning'
        : 'broken';

  const headline =
    validation.severity === 'ok'
      ? 'Verificado'
      : validation.severity === 'warning'
        ? 'Escanea, con poco margen'
        : 'No va a escanear';

  const Symbol =
    validation.severity === 'ok' ? CheckIcon : validation.severity === 'warning' ? AlertIcon : BrokenIcon;

  return (
    <aside className={`strip strip-${tone}`}>
      <Announcer status={headline} />
      <Symbol />
      <div className="strip-body">
        <p className="strip-headline">
          {headline}
          <span className="strip-metric">
            contraste <span className="value">{formatRatio(validation.contrast)}</span>
          </span>
        </p>

        {validation.severity === 'ok' ? (
          <p>
            Contraste, zona de silencio y tamaño del logo están dentro de lo que el
            formato tolera.
          </p>
        ) : null}

        <ul className="strip-list">
          {validation.findings.map((finding) => (
            <li key={finding.id} className={`finding finding-${finding.severity}`}>
              <span>{finding.message}</span>
              {finding.fix ? (
                <Button
                  variant="ghost"
                  onClick={() => dispatch({ type: 'patch-design', patch: finding.fix!.patch })}
                >
                  {finding.fix.label}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>

        {state.autoRaised ? (
          <p className="strip-note">
            <InfoIcon />
            Subí la corrección de errores de {state.autoRaised.from} a {state.autoRaised.to} para
            que {state.autoRaised.kind === 'text' ? 'el texto del centro' : 'el logo'} quepa con
            margen. Puedes bajarla a mano.
          </p>
        ) : null}

        {validation.notes.map((note) => (
          <p className="strip-note" key={note}>
            <InfoIcon />
            {note}
          </p>
        ))}
      </div>
    </aside>
  );
}
