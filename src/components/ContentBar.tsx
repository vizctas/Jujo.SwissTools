/*
 * La barra de contenido.
 *
 * Escribir el contenido son cinco segundos; diseñar es toda la sesión. Por eso el
 * contenido no tiene columna propia: vive arriba, ocupa lo que necesita y se para
 * en un tercio de la pantalla, con scroll interno para los tipos pesados.
 */

import { useId, type ReactNode } from 'react';
import { CONTENT_TYPES, contentType, type FieldDef } from '../lib/content.ts';
import { useStore } from '../state/store.tsx';
import { SelectField } from './controls.tsx';

function Field({
  field,
  value,
  error,
  onChange,
}: {
  field: FieldDef;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}): ReactNode {
  const id = useId();
  const describedBy = error ? `${id}-msg` : field.hint ? `${id}-msg` : undefined;

  const control = ((): ReactNode => {
    switch (field.kind) {
      case 'textarea':
        return (
          <textarea
            id={id}
            className="text-input"
            rows={2}
            value={value}
            placeholder={field.placeholder}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          />
        );
      case 'select':
        return (
          <SelectField
            id={id}
            label={field.label}
            value={value}
            options={field.options ?? []}
            onChange={onChange}
          />
        );
      case 'checkbox':
        return (
          <label className="checkbox-inline">
            <input
              id={id}
              type="checkbox"
              checked={value === 'true'}
              onChange={(event) => onChange(String(event.target.checked))}
            />
            <span>Sí</span>
          </label>
        );
      default:
        return (
          <input
            id={id}
            className="text-input"
            type={field.kind === 'password' ? 'password' : field.kind === 'date' ? 'date' : field.kind === 'time' ? 'time' : 'text'}
            value={value}
            placeholder={field.placeholder}
            inputMode={field.inputMode}
            autoComplete="off"
            spellCheck={field.kind === 'text' && field.inputMode === undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          />
        );
    }
  })();

  return (
    <div className={`field field-${field.width ?? 'full'}`}>
      <label className="row-label" htmlFor={id}>
        {field.label}
        {field.required ? <span aria-hidden="true"> ·</span> : null}
      </label>
      {control}
      {error ? (
        <p className="row-error" id={`${id}-msg`} role="alert">
          {error}
        </p>
      ) : field.hint ? (
        <p className="row-hint" id={`${id}-msg`}>
          {field.hint}
        </p>
      ) : null}
    </div>
  );
}

export function ContentBar(): ReactNode {
  const { state, dispatch, derived } = useStore();
  const type = contentType(state.typeId);
  const values = state.valuesByType[state.typeId];

  return (
    <section className="content-bar" aria-label="Contenido del código">
      <div className="type-tabs" role="tablist" aria-label="Tipo de contenido">
        {CONTENT_TYPES.map((candidate) => {
          const selected = candidate.id === state.typeId;
          return (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`type-tab${selected ? ' is-selected' : ''}`}
              title={candidate.blurb}
              onClick={() => dispatch({ type: 'set-content-type', id: candidate.id })}
            >
              {candidate.label}
            </button>
          );
        })}
      </div>

      <div className="field-grid">
        {type.fields.map((field) => (
          <Field
            key={field.name}
            field={field}
            value={values[field.name] ?? ''}
            error={derived.fieldErrors[field.name]}
            onChange={(value) => dispatch({ type: 'set-field', name: field.name, value })}
          />
        ))}
      </div>
    </section>
  );
}
