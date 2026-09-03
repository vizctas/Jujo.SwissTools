import { CubeIcon } from '../../components/Icons.tsx';
import type { ToolDefinition } from '../types.ts';
import { useMeshCommands } from './commands.tsx';
import { MeshInput, MeshPanel, MeshStage } from './MeshUI.tsx';
import { MeshProvider } from './store.tsx';

export const meshTool: ToolDefinition = {
  id: 'mesh',
  label: 'Taller 3D',
  blurb: 'Separa, repara y divide modelos 3D para imprimirlos. STL, OBJ, glTF y PLY.',
  icon: <CubeIcon />,
  Provider: MeshProvider,
  Input: MeshInput,
  Stage: MeshStage,
  Panel: MeshPanel,
  useCommands: useMeshCommands,
};
