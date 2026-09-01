import { PhoneIcon } from '../../components/Icons.tsx';
import type { ToolDefinition } from '../types.ts';
import { ApkInput } from './ApkInput.tsx';
import { ApkPanel } from './ApkPanel.tsx';
import { DeviceStage } from './DeviceStage.tsx';
import { useApkCommands } from './commands.tsx';
import { ApkProvider } from './store.tsx';

export const apkTool: ToolDefinition = {
  id: 'apk',
  label: 'Instalador de APK',
  blurb: 'Empuja un APK a los dispositivos conectados, por cable o por red.',
  icon: <PhoneIcon />,
  Provider: ApkProvider,
  Input: ApkInput,
  Stage: DeviceStage,
  Panel: ApkPanel,
  useCommands: useApkCommands,
};
