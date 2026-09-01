import { DownloadIcon, StopIcon, TrashIcon } from '../../components/Icons.tsx';
import type { PaletteCommand, ToolCommandContext } from '../types.ts';
import { useBg } from './store.tsx';

/** Lo que el recortador aporta a la navaja. */
export function useBgCommands({ close, activate }: ToolCommandContext): PaletteCommand[] {
  const { items, exportAll, clearAll, cancelAll, busy } = useBg();
  const ready = items.filter((item) => item.status === 'done').length;

  const commands: PaletteCommand[] = [];

  if (ready > 0) {
    commands.push({
      id: 'bg-export-all',
      group: 'Acciones',
      label: `Guardar los ${ready} recortes`,
      hint: 'Descarga en serie con las opciones actuales.',
      icon: <DownloadIcon />,
      run: () => {
        activate();
        void exportAll();
        close();
      },
    });
  }
  if (busy) {
    commands.push({
      id: 'bg-cancel',
      group: 'Acciones',
      label: 'Cancelar los recortes en cola',
      icon: <StopIcon />,
      run: () => {
        cancelAll();
        close();
      },
    });
  }
  if (items.length > 0) {
    commands.push({
      id: 'bg-clear',
      group: 'Acciones',
      label: 'Vaciar la lista de imágenes',
      hint: 'No borra nada del disco.',
      icon: <TrashIcon />,
      run: () => {
        activate();
        clearAll();
        close();
      },
    });
  }
  return commands;
}
