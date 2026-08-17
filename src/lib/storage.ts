/*
 * Persistencia. Todo en el dispositivo, sin cuenta y sin red.
 *
 * Presets e historial viven en IndexedDB, no en localStorage: un preset lleva el
 * logo embebido y varios logos se comen los 5 MB de localStorage sin avisar.
 * En localStorage queda solo la preferencia de tema, que se lee de forma síncrona
 * antes del primer pintado.
 */

import { del, get, set } from 'idb-keyval';
import type { ContentTypeId, FieldValues } from './content.ts';
import type { QrDesign } from './types.ts';

export interface Preset {
  id: string;
  name: string;
  design: QrDesign;
  createdAt: number;
}

export interface HistoryEntry {
  id: string;
  createdAt: number;
  typeId: ContentTypeId;
  values: FieldValues;
  design: QrDesign;
  /** Resumen de una línea, ya calculado, para no reconstruirlo al listar. */
  label: string;
}

export interface SessionSnapshot {
  typeId: ContentTypeId;
  valuesByType: Partial<Record<ContentTypeId, FieldValues>>;
  design: QrDesign;
}

const PRESETS_KEY = 'jujo.presets';
const HISTORY_KEY = 'jujo.history';
const SESSION_KEY = 'jujo.session';

/** Tope del historial. Más allá deja de ser útil y empieza a ser peso. */
const HISTORY_LIMIT = 60;

export function newId(): string {
  return crypto.randomUUID();
}

export async function loadPresets(): Promise<Preset[]> {
  return (await get<Preset[]>(PRESETS_KEY)) ?? [];
}

export async function savePresets(presets: Preset[]): Promise<void> {
  await set(PRESETS_KEY, presets);
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  return (await get<HistoryEntry[]>(HISTORY_KEY)) ?? [];
}

export async function pushHistory(entry: HistoryEntry): Promise<HistoryEntry[]> {
  const existing = await loadHistory();
  const next = [entry, ...existing].slice(0, HISTORY_LIMIT);
  await set(HISTORY_KEY, next);
  return next;
}

export async function clearHistory(): Promise<void> {
  await del(HISTORY_KEY);
}

export async function loadSession(): Promise<SessionSnapshot | null> {
  return (await get<SessionSnapshot>(SESSION_KEY)) ?? null;
}

export async function saveSession(snapshot: SessionSnapshot): Promise<void> {
  await set(SESSION_KEY, snapshot);
}

export type ThemeChoice = 'system' | 'light' | 'dark';

export function loadTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem('jujo.theme');
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem('jujo.theme');
    else localStorage.setItem('jujo.theme', choice);
  } catch {
    // Modo privado con almacenamiento bloqueado: el tema simplemente no persiste.
  }
}
