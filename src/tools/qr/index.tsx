import { ContentBar } from '../../components/ContentBar.tsx';
import { GridIcon } from '../../components/Icons.tsx';
import { PropertiesPanel } from '../../components/PropertiesPanel.tsx';
import { Table } from '../../components/Table.tsx';
import { ValidationStrip } from '../../components/ValidationStrip.tsx';
import { StoreProvider } from '../../state/store.tsx';
import type { ToolDefinition } from '../types.ts';
import { useQrCommands } from './commands.tsx';
import { QrActions } from './QrActions.tsx';

export const qrTool: ToolDefinition = {
  id: 'qr',
  label: 'Generador de QR',
  blurb: 'Códigos con control de diseño real y aviso antes de que dejen de escanear.',
  icon: <GridIcon />,
  Provider: StoreProvider,
  Input: ContentBar,
  Stage: () => (
    <>
      <Table />
      <ValidationStrip />
    </>
  ),
  Panel: PropertiesPanel,
  Actions: QrActions,
  useCommands: useQrCommands,
};
