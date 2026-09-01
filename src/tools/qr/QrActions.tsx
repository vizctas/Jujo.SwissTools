import type { ReactNode } from 'react';
import { ExportPopover } from '../../components/ExportPopover.tsx';
import { useStore } from '../../state/store.tsx';

/** Lo que el generador de QR pone en la barra superior. */
export function QrActions(): ReactNode {
  const { state, presets } = useStore();
  const activePreset = presets.find((preset) => preset.id === state.activePresetId);

  return (
    <>
      {activePreset ? (
        <p className="preset-chip" title={`Preset aplicado: ${activePreset.name}`}>
          <span className="preset-dot" aria-hidden="true" />
          {activePreset.name}
        </p>
      ) : null}
      <ExportPopover />
    </>
  );
}
