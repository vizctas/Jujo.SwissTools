import { SearchIcon } from '../../components/Icons.tsx';
import type { ToolDefinition } from '../types.ts';
import { SnifferInput, SnifferPanel, SnifferStage } from './SnifferUI.tsx';
import { useSnifferCommands } from './commands.tsx';
import { SnifferProvider } from './store.tsx';

export const snifferTool: ToolDefinition = {
  id: 'sniffer',
  label: 'Capturador de media',
  blurb: 'Escucha el logcat de un dispositivo y pesca las URLs de vídeo que pasan.',
  icon: <SearchIcon />,
  Provider: SnifferProvider,
  Input: SnifferInput,
  Stage: SnifferStage,
  Panel: SnifferPanel,
  useCommands: useSnifferCommands,
};
