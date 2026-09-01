import { PackageIcon } from '../../components/Icons.tsx';
import type { ToolDefinition } from '../types.ts';
import { BgInput, BgPanel, BgStage } from './BgUI.tsx';
import { useBgCommands } from './commands.tsx';
import { BgProvider } from './store.tsx';

export const bgTool: ToolDefinition = {
  id: 'bg',
  label: 'Recorte de fondo',
  blurb: 'Quita el fondo de varias imágenes a la vez, en tu equipo y con GPU.',
  icon: <PackageIcon />,
  Provider: BgProvider,
  Input: BgInput,
  Stage: BgStage,
  Panel: BgPanel,
  useCommands: useBgCommands,
};
