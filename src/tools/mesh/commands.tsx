import { CubeIcon, DownloadIcon, TrashIcon } from '../../components/Icons.tsx';
import type { PaletteCommand, ToolCommandContext } from '../types.ts';
import { useMesh } from './store.tsx';

/** Lo que el taller de mallas aporta a la navaja. */
export function useMeshCommands({ close, activate }: ToolCommandContext): PaletteCommand[] {
  const { parts, exportAll, clear, exploded, setExploded, repair, format } = useMesh();
  const commands: PaletteCommand[] = [];
  if (parts.length === 0) return commands;

  const broken = parts.filter((part) => !part.topology.watertight).length;

  commands.push({
    id: 'mesh-export-all',
    group: 'Acciones',
    label: `Guardar las ${parts.length} piezas en ${format.toUpperCase()}`,
    hint: format === '3mf' ? 'Un solo archivo con color.' : 'Un archivo por pieza.',
    icon: <DownloadIcon />,
    run: () => {
      activate();
      void exportAll();
      close();
    },
  });
  commands.push({
    id: 'mesh-explode',
    group: 'Acciones',
    label: exploded ? 'Reunir las piezas en la vista' : 'Separar las piezas en la vista',
    icon: <CubeIcon />,
    current: exploded,
    run: () => {
      activate();
      setExploded(!exploded);
      close();
    },
  });
  if (broken > 0) {
    commands.push({
      id: 'mesh-repair',
      group: 'Acciones',
      label: `Reparar ${broken === 1 ? 'la pieza abierta' : `las ${broken} piezas abiertas`}`,
      hint: 'Cierra agujeros, endereza caras del revés, funde duplicados.',
      icon: <CubeIcon />,
      run: () => {
        activate();
        repair();
        close();
      },
    });
  }
  commands.push({
    id: 'mesh-clear',
    group: 'Acciones',
    label: 'Vaciar el taller 3D',
    hint: 'No borra nada del disco.',
    icon: <TrashIcon />,
    run: () => {
      activate();
      clear();
      close();
    },
  });
  return commands;
}
