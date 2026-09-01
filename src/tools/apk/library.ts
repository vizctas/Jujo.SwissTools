/*
 * La biblioteca de APK.
 *
 * Guardar binarios de cientos de megas en el navegador es lo que rompe estas
 * funciones cuando nadie mira: la cuota se agota, la escritura falla a mitad y la
 * app se queda con una entrada que apunta a nada. Aquí se pregunta el espacio antes
 * de escribir, se escribe el binario antes que el índice, y si algo falla se limpia.
 */

import { del, get, set } from 'idb-keyval';
import type { ApkInfo } from './apk-info.ts';

export interface LibraryEntry {
  id: string;
  addedAt: number;
  info: ApkInfo;
  /** Serial de los dispositivos donde ya se instaló, para dar contexto al reabrir. */
  installedOn: string[];
}

const INDEX_KEY = 'jujo.apk.library';
const blobKey = (id: string): string => `jujo.apk.blob.${id}`;

/** Tope de la biblioteca. Sin esto, un mes de builds llena el disco del usuario. */
export const MAX_ENTRIES = 12;

export interface QuotaReport {
  usage: number;
  quota: number;
  /** Lo que quedaría libre tras guardar `size` bytes. Negativo significa que no cabe. */
  headroom: number;
}

export async function estimateQuota(size: number): Promise<QuotaReport | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  // Se deja un 10% de colchón: apurar la cuota hasta el último byte hace que falle
  // cualquier otra escritura de la app, incluida la sesión del generador de QR.
  return { usage, quota, headroom: quota * 0.9 - usage - size };
}

export async function loadLibrary(): Promise<LibraryEntry[]> {
  return (await get<LibraryEntry[]>(INDEX_KEY)) ?? [];
}

export async function readBlob(id: string): Promise<Blob | null> {
  return (await get<Blob>(blobKey(id))) ?? null;
}

export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaError';
  }
}

/**
 * Guarda un APK. El binario primero y el índice después: si el disco se llena a
 * mitad, queda un blob huérfano —invisible y recuperable— en lugar de una entrada
 * en la lista que al pulsarla no encuentra nada.
 */
export async function addToLibrary(
  id: string,
  file: Blob,
  info: ApkInfo,
): Promise<LibraryEntry[]> {
  const report = await estimateQuota(file.size);
  if (report && report.headroom < 0) {
    throw new QuotaError(
      `No cabe: el navegador te da ${Math.round(report.quota / 1048576)} MB y ya hay ${Math.round(report.usage / 1048576)} MB usados. Borra algún APK de la biblioteca.`,
    );
  }

  try {
    await set(blobKey(id), file);
  } catch (error) {
    await del(blobKey(id)).catch(() => {});
    throw new QuotaError(
      error instanceof DOMException && error.name === 'QuotaExceededError'
        ? 'El navegador se quedó sin espacio al guardar el APK. Borra alguno de la biblioteca.'
        : `No se pudo guardar el APK: ${String(error)}`,
    );
  }

  const existing = await loadLibrary();
  const entry: LibraryEntry = { id, addedAt: Date.now(), info, installedOn: [] };
  const next = [entry, ...existing.filter((item) => item.id !== id)];

  // Por encima del tope se descartan los más viejos, y sus blobs con ellos.
  const dropped = next.slice(MAX_ENTRIES);
  await Promise.all(dropped.map((item) => del(blobKey(item.id)).catch(() => {})));
  const trimmed = next.slice(0, MAX_ENTRIES);

  await set(INDEX_KEY, trimmed);
  return trimmed;
}

export async function markInstalled(id: string, serials: string[]): Promise<LibraryEntry[]> {
  const entries = await loadLibrary();
  const next = entries.map((entry) =>
    entry.id === id
      ? { ...entry, installedOn: [...new Set([...entry.installedOn, ...serials])] }
      : entry,
  );
  await set(INDEX_KEY, next);
  return next;
}

export async function removeFromLibrary(id: string): Promise<LibraryEntry[]> {
  const entries = (await loadLibrary()).filter((entry) => entry.id !== id);
  await set(INDEX_KEY, entries);
  await del(blobKey(id)).catch(() => {});
  return entries;
}
