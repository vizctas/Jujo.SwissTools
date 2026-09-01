import { apkTool } from './apk/index.tsx';
import { qrTool } from './qr/index.tsx';
import { snifferTool } from './sniffer/index.tsx';
import type { PaletteCommand, ToolCommandContext, ToolDefinition } from './types.ts';

const NO_COMMANDS = (): PaletteCommand[] => [];

/**
 * Las hojas de la navaja, en el orden en que se ofrecen.
 *
 * `useCommands` se normaliza aquí para que el shell pueda llamarlo en bucle sin
 * condicionales: llamar hooks condicionalmente es exactamente el tipo de detalle
 * que revienta seis meses después.
 */
export const TOOLS: ReadonlyArray<
  ToolDefinition & { useCommands: (context: ToolCommandContext) => PaletteCommand[] }
> = [qrTool, apkTool, snifferTool].map((tool) => ({
  ...tool,
  useCommands: tool.useCommands ?? NO_COMMANDS,
}));

export const DEFAULT_TOOL_ID = TOOLS[0]!.id;

export function findTool(id: string): (typeof TOOLS)[number] {
  return TOOLS.find((tool) => tool.id === id) ?? TOOLS[0]!;
}
