import { PackageIcon, RefreshIcon, TrashIcon } from '../../components/Icons.tsx';
import type { PaletteCommand, ToolCommandContext } from '../types.ts';
import { useApk } from './store.tsx';

/** Lo que el instalador de APK aporta a la navaja. */
export function useApkCommands({ close, activate }: ToolCommandContext): PaletteCommand[] {
  const { library, useLibraryEntry, dropLibraryEntry, refreshDevices, status } = useApk();

  const enter = (run: () => void) => () => {
    activate();
    run();
    close();
  };

  return [
    ...library.map<PaletteCommand>((entry) => ({
      id: `apk-library-${entry.id}`,
      group: 'APK guardados',
      label: entry.info.label ?? entry.info.packageName ?? entry.info.filename,
      hint: `${entry.info.versionName ?? 'sin versión'} · ${entry.info.filename}`,
      icon: <PackageIcon />,
      remove: {
        label: `Borrar ${entry.info.filename} de la biblioteca`,
        run: () => void dropLibraryEntry(entry.id),
      },
      run: enter(() => void useLibraryEntry(entry)),
    })),
    ...(status.kind === 'connected'
      ? [
          {
            id: 'apk-refresh',
            group: 'Acciones',
            label: 'Volver a leer los dispositivos',
            hint: 'Fuerza un sondeo de adb y relee las propiedades.',
            icon: <RefreshIcon />,
            run: enter(() => void refreshDevices()),
          } satisfies PaletteCommand,
        ]
      : []),
    ...(library.length > 0
      ? [
          {
            id: 'apk-clear-library',
            group: 'Acciones',
            label: 'Vaciar la biblioteca de APK',
            hint: `${library.length} archivos guardados en este dispositivo.`,
            icon: <TrashIcon />,
            run: () => {
              for (const entry of library) void dropLibraryEntry(entry.id);
              close();
            },
          } satisfies PaletteCommand,
        ]
      : []),
  ];
}
