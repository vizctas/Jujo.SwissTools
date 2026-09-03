/*
 * El vocabulario de controles.
 *
 * Toda herramienta de la navaja usa estos y solo estos. Si una necesita un patrón
 * nuevo, la pregunta es si ese patrón debe existir para todas (principio 5).
 *
 * Regla que atraviesa el archivo: todo control con arrastre tiene entrada numérica
 * o por teclado equivalente. Nada depende de puntero fino.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
} from 'react';
import { isValidHex, normalizeHex } from '../lib/color.ts';
import { CheckIcon, ChevronIcon, PipetteIcon } from './Icons.tsx';

/* ---------------------------------------------------------------- Estructura */

export function Group({
  title,
  children,
  action,
  collapsible = false,
  open = true,
  onToggle,
  summary,
  step,
  done,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  /**
   * Convierte el grupo en un paso plegable. El panel que los usa mantiene uno
   * solo abierto: leer cinco grupos enteros para tocar uno era el desorden.
   */
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  /** Lo que hay dentro, dicho en corto, para no tener que abrirlo. */
  summary?: ReactNode;
  step?: number;
  /** El paso ya está resuelto: el número deja sitio a la marca. */
  done?: boolean;
}): ReactNode {
  if (!collapsible) {
    return (
      <section className="group">
        <header className="group-head">
          <h3>{title}</h3>
          {action}
        </header>
        <div className="group-body">{children}</div>
      </section>
    );
  }
  return (
    <section className={`group group-fold${open ? ' is-open' : ''}`}>
      <h3 className="group-fold-head">
        <button type="button" aria-expanded={open} onClick={onToggle}>
          {step !== undefined ? (
            <span className={`group-step${done ? ' is-done' : ''}`}>
              {done ? <CheckIcon /> : step}
            </span>
          ) : null}
          <span className="group-fold-title">{title}</span>
          {summary && !open ? <span className="group-summary">{summary}</span> : null}
          <ChevronIcon className="group-chevron" />
        </button>
      </h3>
      {/* La altura se anima por grid-rows: el contenido no necesita medirse. */}
      <div className="group-fold-body">
        <div className="group-fold-clip">
          <div className="group-body">{children}</div>
        </div>
      </div>
    </section>
  );
}

export function Row({
  label,
  htmlFor,
  hint,
  error,
  children,
  wide,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  /** El control ocupa su propia línea bajo la etiqueta. */
  wide?: boolean;
}): ReactNode {
  return (
    <div className={wide ? 'row row-wide' : 'row'}>
      <label className="row-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="row-control">{children}</div>
      {error ? (
        <p className="row-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="row-hint">{hint}</p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Botones */

type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger';

export function Button({
  variant = 'default',
  loading = false,
  children,
  ...props
}: {
  variant?: ButtonVariant;
  loading?: boolean;
} & ComponentPropsWithRef<'button'>): ReactNode {
  return (
    <button
      type="button"
      {...props}
      className={`btn btn-${variant}${props.className ? ` ${props.className}` : ''}`}
      disabled={props.disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="btn-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/* ------------------------------------------------- Slider con valor editable */

export function NumberSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  decimals = 0,
  disabled,
  disabledReason,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals?: number;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (value: number) => void;
}): ReactNode {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value.toFixed(decimals);

  const commit = (raw: string): void => {
    const parsed = Number(raw.replace(',', '.'));
    setDraft(null);
    if (Number.isNaN(parsed)) return;
    onChange(Math.min(max, Math.max(min, parsed)));
  };

  return (
    <div className={`slider${disabled ? ' is-disabled' : ''}`}>
      <div className="slider-head">
        <label className="row-label" htmlFor={id}>
          {label}
        </label>
        <span className="slider-value">
          <input
            className="value slider-input"
            value={shown}
            inputMode="decimal"
            disabled={disabled}
            aria-label={`${label}, valor`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit(event.currentTarget.value);
                event.currentTarget.blur();
              }
              if (event.key === 'Escape') setDraft(null);
            }}
          />
          {unit ? <span className="slider-unit">{unit}</span> : null}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {disabled && disabledReason ? <p className="row-hint">{disabledReason}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------ Campo de color */

interface EyeDropperResult {
  sRGBHex: string;
}
interface EyeDropperCtor {
  new (): { open(): Promise<EyeDropperResult> };
}

export function ColorField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
}): ReactNode {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const invalid = draft !== null && !isValidHex(draft);

  const pickerAvailable =
    typeof window !== 'undefined' && 'EyeDropper' in window && !disabled;

  const commit = (raw: string): void => {
    const normalized = normalizeHex(raw);
    setDraft(null);
    if (normalized) onChange(normalized);
  };

  return (
    <div className={`color-field${disabled ? ' is-disabled' : ''}`}>
      <span className="color-swatch">
        <input
          id={id}
          type="color"
          value={normalizeHex(value) ?? '#000000'}
          disabled={disabled}
          aria-label={`${label}, selector visual`}
          onChange={(event) => onChange(event.target.value)}
        />
      </span>
      <input
        className="value color-hex"
        value={shown}
        spellCheck={false}
        disabled={disabled}
        aria-label={`${label}, hexadecimal`}
        aria-invalid={invalid || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit(event.currentTarget.value);
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') setDraft(null);
        }}
      />
      {pickerAvailable ? (
        <button
          type="button"
          className="icon-btn"
          title="Tomar color de la pantalla"
          aria-label={`${label}, tomar color de la pantalla`}
          onClick={() => {
            const Ctor = (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper;
            void new Ctor()
              .open()
              .then((result) => onChange(result.sRGBHex))
              .catch(() => {
                /* el usuario canceló */
              });
          }}
        >
          <PipetteIcon />
        </button>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------- Control segmentado */

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Muestra la forma en vez de la palabra cuando el control es visual. */
  glyph?: ReactNode;
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  columns,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
  columns?: number;
}): ReactNode {
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      style={columns ? { gridTemplateColumns: `repeat(${columns}, 1fr)` } : undefined}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`segment${selected ? ' is-selected' : ''}`}
            title={option.label}
            onClick={() => onChange(option.value)}
          >
            {option.glyph ?? option.label}
            {option.glyph ? <span className="visually-hidden">{option.label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- Select nativo */

export function SelectField({
  label,
  value,
  options,
  onChange,
  id,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  id?: string;
}): ReactNode {
  return (
    <div className="select">
      <select
        id={id}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ---------------------------------------------------------------- Interruptor */

export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}): ReactNode {
  const id = useId();
  return (
    <div className="toggle-row">
      <div className="toggle-text">
        <label htmlFor={id}>{label}</label>
        {hint ? <p className="row-hint">{hint}</p> : null}
      </div>
      <input
        id={id}
        type="checkbox"
        className="toggle"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------- Popover */

/**
 * Popover anclado. Se cierra con Escape, con clic fuera, y devuelve el foco al
 * disparador. No es un modal: no bloquea la mesa, que es justo lo que hace falta
 * cuando el popover confirma algo que ya se está viendo.
 */
export function Popover({
  open,
  onClose,
  children,
  labelledBy,
  align = 'end',
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
  align?: 'start' | 'end';
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    const onPointer = (event: PointerEvent): void => {
      const node = ref.current;
      if (node && !node.contains(event.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    // `capture` para ganarle a los onClick que puedan detener la propagación.
    document.addEventListener('pointerdown', onPointer, true);
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className={`popover popover-${align}`} ref={ref} role="dialog" aria-labelledby={labelledBy}>
      {children}
    </div>
  );
}
