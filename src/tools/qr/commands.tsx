import { contentType } from '../../lib/content.ts';
import { HistoryIcon, SaveIcon, TrashIcon } from '../../components/Icons.tsx';
import { useStore } from '../../state/store.tsx';
import type { PaletteCommand, ToolCommandContext } from '../types.ts';

const RELATIVE = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

function relativeTime(timestamp: number): string {
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, 'hour');
  return RELATIVE.format(Math.round(hours / 24), 'day');
}

/** Presets, historial y acciones del generador de QR. */
export function useQrCommands({ close, activate }: ToolCommandContext): PaletteCommand[] {
  const { state, dispatch, presets, history, savePreset, deletePreset, clearAllHistory } =
    useStore();

  const enter = (run: () => void) => () => {
    activate();
    run();
    close();
  };

  return [
    {
      id: 'qr-preset-save',
      group: 'Presets',
      label: 'Guardar el diseño actual como preset',
      hint: 'Colores, formas, centro y tipografía, listos para reaplicar.',
      icon: <SaveIcon />,
      prompt: {
        placeholder: 'Nombre del preset, por ejemplo «Cliente Marca Roja»',
        hint: 'El preset guarda todo el diseño. El contenido no entra, para que puedas aplicarlo a cualquier código.',
        run: (name) => {
          activate();
          void savePreset(name);
          close();
        },
      },
    },
    ...presets.map<PaletteCommand>((preset) => ({
      id: `qr-preset-${preset.id}`,
      group: 'Presets',
      label: preset.name,
      hint: 'Aplica este diseño al contenido actual.',
      icon: <SaveIcon />,
      current: preset.id === state.activePresetId,
      remove: { label: `Borrar el preset ${preset.name}`, run: () => void deletePreset(preset.id) },
      run: enter(() => dispatch({ type: 'apply-preset', preset })),
    })),
    ...history.map<PaletteCommand>((entry) => ({
      id: `qr-history-${entry.id}`,
      group: 'Historial',
      label: entry.label,
      hint: `${contentType(entry.typeId).label} · ${relativeTime(entry.createdAt)}`,
      icon: <HistoryIcon />,
      run: enter(() => dispatch({ type: 'load-entry', entry })),
    })),
    {
      id: 'qr-reset',
      group: 'Acciones',
      label: 'Restablecer el diseño del QR',
      hint: 'Vuelve a los valores de fábrica. El contenido no se toca.',
      icon: <TrashIcon />,
      run: enter(() => dispatch({ type: 'reset-design' })),
    },
    ...(history.length > 0
      ? [
          {
            id: 'qr-clear-history',
            group: 'Acciones',
            label: 'Vaciar el historial de QR',
            hint: `${history.length} piezas guardadas en este dispositivo.`,
            icon: <TrashIcon />,
            run: () => {
              void clearAllHistory();
              close();
            },
          } satisfies PaletteCommand,
        ]
      : []),
  ];
}
