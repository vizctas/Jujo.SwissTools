import { useEffect, useState, type ReactNode } from 'react';
import { CommandPalette } from './components/CommandPalette.tsx';
import { MonitorIcon, MoonIcon, SunIcon } from './components/Icons.tsx';
import { loadTheme, saveTheme, type ThemeChoice } from './lib/storage.ts';
import { DEFAULT_TOOL_ID, findTool, TOOLS } from './tools/registry.ts';

const FIRST_RUN_KEY = 'jujo.seen';
const LAST_TOOL_KEY = 'jujo.tool';

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
}

/**
 * Todas las herramientas se montan a la vez aunque solo una se vea. Es deliberado:
 * cambiar de hoja para consultar algo y volver no puede costarte lo que llevabas
 * escrito.
 */
function ToolProviders({ children }: { children: ReactNode }): ReactNode {
  return TOOLS.reduceRight<ReactNode>(
    (inner, tool) => <tool.Provider key={tool.id}>{inner}</tool.Provider>,
    children,
  );
}

function ThemeButton({
  theme,
  onCycle,
}: {
  theme: ThemeChoice;
  onCycle: () => void;
}): ReactNode {
  const label =
    theme === 'system' ? 'Tema del sistema' : theme === 'light' ? 'Tema claro' : 'Tema oscuro';
  return (
    <button type="button" className="icon-btn" onClick={onCycle} title={label} aria-label={label}>
      {theme === 'system' ? <MonitorIcon /> : theme === 'light' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function Shell(): ReactNode {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(() => loadTheme());
  const [activeId, setActiveId] = useState<string>(() => {
    try {
      return localStorage.getItem(LAST_TOOL_KEY) ?? DEFAULT_TOOL_ID;
    } catch {
      return DEFAULT_TOOL_ID;
    }
  });

  const tool = findTool(activeId);

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(LAST_TOOL_KEY, tool.id);
    } catch {
      // Almacenamiento bloqueado: se abre siempre en la primera herramienta.
    }
  }, [tool.id]);

  // El primer arranque abre con la navaja desplegada: es la portada de la app.
  useEffect(() => {
    try {
      if (localStorage.getItem(FIRST_RUN_KEY) === null) {
        localStorage.setItem(FIRST_RUN_KEY, '1');
        setPaletteOpen(true);
      }
    } catch {
      // Almacenamiento bloqueado: se arranca directo en la herramienta.
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const Input = tool.Input;
  const Actions = tool.Actions;

  return (
    <div className={`app${Input ? '' : ' app-no-input'}`}>
      <a className="skip-link" href="#panel">
        Saltar al panel de controles
      </a>

      <header className="topbar">
        <button
          type="button"
          className="navaja"
          onClick={() => setPaletteOpen(true)}
          aria-haspopup="dialog"
        >
          {tool.icon}
          <span className="navaja-tool">{tool.label}</span>
          <kbd>{isMac() ? '⌘' : 'Ctrl'} K</kbd>
        </button>

        <div className="topbar-end">
          {Actions ? <Actions /> : null}
          <ThemeButton
            theme={theme}
            onCycle={() =>
              setTheme((current) =>
                current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system',
              )
            }
          />
        </div>
      </header>

      {Input ? <Input /> : null}

      <main className="stage">
        <tool.Stage />
      </main>

      <aside className="panel" id="panel" aria-label={`Controles: ${tool.label}`}>
        <tool.Panel />
      </aside>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        theme={theme}
        onTheme={setTheme}
        activeToolId={tool.id}
        onActivateTool={setActiveId}
      />
    </div>
  );
}

export function App(): ReactNode {
  return (
    <ToolProviders>
      <Shell />
    </ToolProviders>
  );
}
