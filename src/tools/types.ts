import type { ReactNode } from 'react';

/**
 * Una hoja de la navaja.
 *
 * El shell no sabe nada de ninguna herramienta concreta: monta sus proveedores,
 * pinta sus zonas y la registra en la paleta. Añadir una herramienta es escribir
 * este objeto, no tocar el shell.
 */
export interface ToolDefinition {
  id: string;
  label: string;
  /** Una línea para la paleta de comandos. */
  blurb: string;
  icon: ReactNode;

  /**
   * Estado propio de la herramienta. Se monta siempre, esté activa o no, para que
   * cambiar de hoja no borre el trabajo a medias.
   */
  Provider: (props: { children: ReactNode }) => ReactNode;

  /** Zona superior: entrada de datos. Opcional; no toda herramienta la necesita. */
  Input?: () => ReactNode;
  /** Zona central: la pieza, la mesa, el resultado. */
  Stage: () => ReactNode;
  /** Columna derecha: los controles. */
  Panel: () => ReactNode;
  /** Acciones propias en la barra superior, junto al tema. */
  Actions?: () => ReactNode;

  /**
   * Comandos que la herramienta aporta a la navaja. Se llama siempre, activa o no,
   * para que el historial de una herramienta siga siendo alcanzable desde otra.
   */
  useCommands?: (context: ToolCommandContext) => PaletteCommand[];
}

/** Una entrada de la navaja aportada por una herramienta. */
export interface PaletteCommand {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  /** Marca el estado actual: preset aplicado, tema activo, herramienta abierta. */
  current?: boolean;
  /** Acción destructiva secundaria, como borrar un preset. */
  remove?: { label: string; run: () => void };
  /**
   * Convierte el buscador en un campo de texto en lugar de ejecutar. Sirve para
   * pedir un nombre sin abrir un modal. El shell lo gestiona sin saber para qué es.
   */
  prompt?: {
    placeholder: string;
    hint: string;
    run: (value: string) => void;
  };
  run?: () => void;
}

export interface ToolCommandContext {
  /** Cierra la paleta. */
  close: () => void;
  /** Trae esta herramienta al frente. */
  activate: () => void;
  isActive: boolean;
}
