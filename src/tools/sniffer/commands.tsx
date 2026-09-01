import { HistoryIcon, StopIcon, TrashIcon } from '../../components/Icons.tsx';
import type { PaletteCommand, ToolCommandContext } from '../types.ts';
import { useSniffer } from './store.tsx';

/** Lo que el capturador aporta a la navaja. */
export function useSnifferCommands({ close, activate }: ToolCommandContext): PaletteCommand[] {
  const { sessions, stop, reveal, history, clearHits } = useSniffer();

  return [
    ...sessions.map<PaletteCommand>((session) => ({
      id: `sniffer-stop-${session.serial}`,
      group: 'Acciones',
      label: `Parar la escucha en ${session.serial}`,
      hint: `${session.urls} URL de ${session.lines.toLocaleString('es')} líneas.`,
      icon: <StopIcon />,
      run: () => {
        void stop(session.serial);
        close();
      },
    })),
    {
      id: 'sniffer-open-folder',
      group: 'Acciones',
      label: 'Abrir la carpeta de capturas',
      hint: history.length > 0 ? `${history.length} descargas registradas.` : undefined,
      icon: <HistoryIcon />,
      run: () => {
        void reveal();
        close();
      },
    },
    {
      id: 'sniffer-clear',
      group: 'Acciones',
      label: 'Vaciar la lista de URLs capturadas',
      hint: 'No borra los archivos, solo lo que se ve en pantalla.',
      icon: <TrashIcon />,
      run: () => {
        activate();
        clearHits();
        close();
      },
    },
  ];
}
