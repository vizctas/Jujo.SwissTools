/*
 * La navaja.
 *
 * Ctrl/Cmd+K abre una sola lista buscable con las cuatro cosas que se navegan:
 * herramientas, presets, historial y acciones. Es la alternativa a gastar una
 * columna permanente de cromo en algo que se usa una vez por sesión.
 *
 * Es un <dialog> nativo: atrapa el foco, cierra con Escape y pinta su propio
 * backdrop sin reimplementar nada de eso. Las flechas mueven el foco de verdad,
 * así que Enter es el Enter del navegador y no hay estado "activo" paralelo que
 * pueda desincronizarse de lo que un lector de pantalla anuncia.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { contentType } from '../lib/content.ts';
import type { ThemeChoice } from '../lib/storage.ts';
import { useStore } from '../state/store.tsx';
import {
  GridIcon,
  HistoryIcon,
  MonitorIcon,
  MoonIcon,
  SaveIcon,
  SearchIcon,
  SunIcon,
  TrashIcon,
} from './Icons.tsx';

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  /** Marca el estado actual: herramienta abierta, preset aplicado, tema activo. */
  current?: boolean;
  /** Acción destructiva secundaria, como borrar un preset. */
  remove?: { label: string; run: () => void };
  run: () => void;
}

const RELATIVE = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

function relativeTime(timestamp: number): string {
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, 'hour');
  return RELATIVE.format(Math.round(hours / 24), 'day');
}

export function CommandPalette({
  open,
  onClose,
  theme,
  onTheme,
}: {
  open: boolean;
  onClose: () => void;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
}): ReactNode {
  const { state, dispatch, presets, history, savePreset, deletePreset, clearAllHistory } =
    useStore();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [naming, setNaming] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setNaming(false);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: 'tool-qr',
        group: 'Herramientas',
        label: 'Generador de QR',
        hint: 'La única hoja abierta por ahora.',
        icon: <GridIcon />,
        current: true,
        run: onClose,
      },
      {
        id: 'preset-save',
        group: 'Presets',
        label: 'Guardar el diseño actual como preset',
        hint: 'Colores, formas, logo y tipografía, listos para reaplicar.',
        icon: <SaveIcon />,
        run: () => {
          setNaming(true);
          setQuery('');
        },
      },
      ...presets.map<Command>((preset) => ({
        id: `preset-${preset.id}`,
        group: 'Presets',
        label: preset.name,
        hint: 'Aplica este diseño al contenido actual.',
        icon: <SaveIcon />,
        current: preset.id === state.activePresetId,
        remove: {
          label: `Borrar el preset ${preset.name}`,
          run: () => void deletePreset(preset.id),
        },
        run: () => {
          dispatch({ type: 'apply-preset', preset });
          onClose();
        },
      })),
      ...history.map<Command>((entry) => ({
        id: `history-${entry.id}`,
        group: 'Historial',
        label: entry.label,
        hint: `${contentType(entry.typeId).label} · ${relativeTime(entry.createdAt)}`,
        icon: <HistoryIcon />,
        run: () => {
          dispatch({ type: 'load-entry', entry });
          onClose();
        },
      })),
      {
        id: 'action-reset',
        group: 'Acciones',
        label: 'Restablecer el diseño',
        hint: 'Vuelve a los valores de fábrica. El contenido no se toca.',
        icon: <GridIcon />,
        run: () => {
          dispatch({ type: 'reset-design' });
          onClose();
        },
      },
      {
        id: 'action-theme-light',
        group: 'Acciones',
        label: 'Tema claro',
        icon: <SunIcon />,
        current: theme === 'light',
        run: () => {
          onTheme('light');
          onClose();
        },
      },
      {
        id: 'action-theme-dark',
        group: 'Acciones',
        label: 'Tema oscuro',
        icon: <MoonIcon />,
        current: theme === 'dark',
        run: () => {
          onTheme('dark');
          onClose();
        },
      },
      {
        id: 'action-theme-system',
        group: 'Acciones',
        label: 'Tema del sistema',
        icon: <MonitorIcon />,
        current: theme === 'system',
        run: () => {
          onTheme('system');
          onClose();
        },
      },
    ];

    if (history.length > 0) {
      list.push({
        id: 'action-clear-history',
        group: 'Acciones',
        label: 'Vaciar el historial',
        hint: `${history.length} piezas guardadas en este dispositivo.`,
        icon: <TrashIcon />,
        run: () => {
          void clearAllHistory();
          onClose();
        },
      });
    }

    return list;
  }, [
    presets,
    history,
    state.activePresetId,
    theme,
    dispatch,
    onClose,
    onTheme,
    clearAllHistory,
    deletePreset,
  ]);

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered =
      naming || needle === ''
        ? commands
        : commands.filter((command) =>
            `${command.label} ${command.hint ?? ''} ${command.group}`
              .toLowerCase()
              .includes(needle),
          );
    const map = new Map<string, Command[]>();
    for (const command of filtered) {
      const bucket = map.get(command.group);
      if (bucket) bucket.push(command);
      else map.set(command.group, [command]);
    }
    return [...map.entries()];
  }, [commands, query, naming]);

  const total = grouped.reduce((count, [, items]) => count + items.length, 0);

  /** Mueve el foco real por la lista; Enter y Espacio los gestiona el navegador. */
  const moveFocus = (delta: number): void => {
    const items = [
      ...(listRef.current?.querySelectorAll<HTMLElement>('[data-command]') ?? []),
    ];
    if (items.length === 0) return;
    const current = items.findIndex((item) => item === document.activeElement);
    const next = current === -1 ? 0 : (current + delta + items.length) % items.length;
    items[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (naming) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(1);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(-1);
    }
  };

  return (
    <dialog
      className="palette"
      ref={dialogRef}
      aria-label="Navaja: herramientas, presets, historial y acciones"
      onClose={onClose}
      onCancel={(event) => {
        // En modo "nombrar preset", Escape vuelve a la búsqueda antes de cerrar.
        if (naming) {
          event.preventDefault();
          setNaming(false);
        }
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className="palette-inner" onKeyDown={onKeyDown}>
        {naming ? (
          <form
            className="palette-search"
            onSubmit={(event) => {
              event.preventDefault();
              const name = query.trim();
              if (name === '') return;
              void savePreset(name);
              onClose();
            }}
          >
            <SaveIcon />
            <input
              autoFocus
              value={query}
              placeholder="Nombre del preset, por ejemplo «Cliente Marca Roja»"
              aria-label="Nombre del preset"
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd>Enter</kbd>
          </form>
        ) : (
          <div className="palette-search">
            <SearchIcon />
            <input
              autoFocus
              value={query}
              placeholder="Busca una herramienta, un preset o una acción"
              aria-label="Buscar en la navaja"
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd>Esc</kbd>
          </div>
        )}

        {naming ? (
          <p className="palette-empty">
            El preset guarda todo el diseño: formas, colores, logo y tipografía. El
            contenido no entra, para que puedas aplicarlo a cualquier código.
          </p>
        ) : total === 0 ? (
          <p className="palette-empty">
            Nada coincide con «{query}». Prueba con el nombre de un preset o de una
            acción.
          </p>
        ) : (
          <div className="palette-list" ref={listRef}>
            {grouped.map(([group, items]) => (
              <div className="palette-group" key={group}>
                <p className="palette-group-title">{group}</p>
                {items.map((command) => (
                  <div className="palette-row" key={command.id}>
                    <button type="button" className="palette-item" data-command onClick={command.run}>
                      <span className="palette-icon">{command.icon}</span>
                      <span className="palette-text">
                        <span className="palette-label">{command.label}</span>
                        {command.hint ? (
                          <span className="palette-hint">{command.hint}</span>
                        ) : null}
                      </span>
                      {command.current ? <span className="palette-tag">actual</span> : null}
                    </button>
                    {command.remove ? (
                      <button
                        type="button"
                        className="icon-btn palette-remove"
                        title={command.remove.label}
                        aria-label={command.remove.label}
                        onClick={command.remove.run}
                      >
                        <TrashIcon />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {!naming && presets.length === 0 ? (
          <p className="palette-foot">
            Todavía no hay presets. Guarda un diseño cuando tengas resuelta la marca de
            un cliente y reaplícalo a cualquier código con dos teclas.
          </p>
        ) : null}
      </div>
    </dialog>
  );
}
