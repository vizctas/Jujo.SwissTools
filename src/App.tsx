import { useEffect, useState, type ReactNode } from 'react';
import { CommandPalette } from './components/CommandPalette.tsx';
import { ContentBar } from './components/ContentBar.tsx';
import { ExportPopover } from './components/ExportPopover.tsx';
import { GridIcon, MonitorIcon, MoonIcon, SunIcon } from './components/Icons.tsx';
import { PropertiesPanel } from './components/PropertiesPanel.tsx';
import { Table } from './components/Table.tsx';
import { ValidationStrip } from './components/ValidationStrip.tsx';
import { loadTheme, saveTheme, type ThemeChoice } from './lib/storage.ts';
import { useStore } from './state/store.tsx';

const FIRST_RUN_KEY = 'jujo.seen';

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
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

export function App(): ReactNode {
  const { state, presets } = useStore();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(() => loadTheme());

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    saveTheme(theme);
  }, [theme]);

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

  const activePreset = presets.find((preset) => preset.id === state.activePresetId);

  return (
    <div className="app">
      <a className="skip-link" href="#panel">
        Saltar al panel de propiedades
      </a>

      <header className="topbar">
        <button
          type="button"
          className="navaja"
          onClick={() => setPaletteOpen(true)}
          aria-haspopup="dialog"
        >
          <GridIcon />
          <span className="navaja-tool">Generador de QR</span>
          <kbd>{isMac() ? '⌘' : 'Ctrl'} K</kbd>
        </button>

        <div className="topbar-end">
          {activePreset ? (
            <p className="preset-chip" title={`Preset aplicado: ${activePreset.name}`}>
              <span className="preset-dot" aria-hidden="true" />
              {activePreset.name}
            </p>
          ) : null}
          <ThemeButton
            theme={theme}
            onCycle={() =>
              setTheme((current) =>
                current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system',
              )
            }
          />
          <ExportPopover />
        </div>
      </header>

      <ContentBar />

      <main className="stage">
        <Table />
        <ValidationStrip />
      </main>

      <aside className="panel" id="panel" aria-label="Propiedades de la pieza">
        <PropertiesPanel />
      </aside>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        theme={theme}
        onTheme={setTheme}
      />
    </div>
  );
}
