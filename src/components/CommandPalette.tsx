/*
 * La navaja.
 *
 * Ctrl/Cmd+K abre una sola lista buscable. El shell aporta las herramientas y el
 * tema; todo lo demás lo aportan las propias herramientas vía `useCommands`.
 * Este archivo no sabe qué es un preset ni qué es un dispositivo, y esa ignorancia
 * es lo que permite añadir hojas a la navaja sin volver a tocarlo.
 *
 * Es un <dialog> nativo: atrapa el foco, cierra con Escape y pinta su propio
 * backdrop. Las flechas mueven el foco de verdad, así que Enter es el Enter del
 * navegador y no hay estado "activo" paralelo que pueda desincronizarse de lo que
 * un lector de pantalla anuncia.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { ThemeChoice } from '../lib/storage.ts';
import { TOOLS } from '../tools/registry.ts';
import type { PaletteCommand } from '../tools/types.ts';
import { MonitorIcon, MoonIcon, SearchIcon, SunIcon, TrashIcon } from './Icons.tsx';

export function CommandPalette({
  open,
  onClose,
  theme,
  onTheme,
  activeToolId,
  onActivateTool,
}: {
  open: boolean;
  onClose: () => void;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  activeToolId: string;
  onActivateTool: (id: string) => void;
}): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [prompting, setPrompting] = useState<PaletteCommand | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setPrompting(null);
    }
  }, [open]);

  // Bucle sobre un array estático: el orden de los hooks nunca cambia.
  const contributed = TOOLS.map((tool) =>
    tool.useCommands({
      close: onClose,
      activate: () => onActivateTool(tool.id),
      isActive: tool.id === activeToolId,
    }),
  ).flat();

  const toolCommands = TOOLS.map<PaletteCommand>((tool) => ({
    id: `tool-${tool.id}`,
    group: 'Herramientas',
    label: tool.label,
    hint: tool.blurb,
    icon: tool.icon,
    current: tool.id === activeToolId,
    run: () => {
      onActivateTool(tool.id);
      onClose();
    },
  }));

  const themeCommands: PaletteCommand[] = [
    { id: 'theme-light', label: 'Tema claro', icon: <SunIcon />, choice: 'light' as const },
    { id: 'theme-dark', label: 'Tema oscuro', icon: <MoonIcon />, choice: 'dark' as const },
    {
      id: 'theme-system',
      label: 'Tema del sistema',
      icon: <MonitorIcon />,
      choice: 'system' as const,
    },
  ].map(({ id, label, icon, choice }) => ({
    id,
    group: 'Apariencia',
    label,
    icon,
    current: theme === choice,
    run: () => {
      onTheme(choice);
      onClose();
    },
  }));

  const commands = [...toolCommands, ...contributed, ...themeCommands];

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered =
      prompting || needle === ''
        ? commands
        : commands.filter((command) =>
            `${command.label} ${command.hint ?? ''} ${command.group}`
              .toLowerCase()
              .includes(needle),
          );
    const map = new Map<string, PaletteCommand[]>();
    for (const command of filtered) {
      const bucket = map.get(command.group);
      if (bucket) bucket.push(command);
      else map.set(command.group, [command]);
    }
    return [...map.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands, query, prompting]);

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
    if (prompting) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(1);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(-1);
    }
  };

  const activate = (command: PaletteCommand): void => {
    if (command.prompt) {
      setPrompting(command);
      setQuery('');
      return;
    }
    command.run?.();
  };

  return (
    <dialog
      className="palette"
      ref={dialogRef}
      aria-label="Navaja: herramientas, acciones e historial"
      onClose={onClose}
      onCancel={(event) => {
        // En modo pregunta, Escape vuelve a la búsqueda antes de cerrar.
        if (prompting) {
          event.preventDefault();
          setPrompting(null);
          setQuery('');
        }
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className="palette-inner" onKeyDown={onKeyDown}>
        {prompting ? (
          <form
            className="palette-search"
            onSubmit={(event) => {
              event.preventDefault();
              const value = query.trim();
              if (value === '') return;
              prompting.prompt?.run(value);
            }}
          >
            {prompting.icon}
            <input
              autoFocus
              value={query}
              placeholder={prompting.prompt?.placeholder}
              aria-label={prompting.label}
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
              placeholder="Busca una herramienta, una acción o algo del historial"
              aria-label="Buscar en la navaja"
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd>Esc</kbd>
          </div>
        )}

        {prompting ? (
          <p className="palette-empty">{prompting.prompt?.hint}</p>
        ) : total === 0 ? (
          <p className="palette-empty">
            Nada coincide con «{query}». Prueba con el nombre de una herramienta o de
            una acción.
          </p>
        ) : (
          <div className="palette-list" ref={listRef}>
            {grouped.map(([group, items]) => (
              <div className="palette-group" key={group}>
                <p className="palette-group-title">{group}</p>
                {items.map((command) => (
                  <div className="palette-row" key={command.id}>
                    <button
                      type="button"
                      className="palette-item"
                      data-command
                      onClick={() => activate(command)}
                    >
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
      </div>
    </dialog>
  );
}
