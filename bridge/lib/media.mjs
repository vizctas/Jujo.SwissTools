/**
 * Sondeo y descarga de media.
 *
 * Port del sniffer de Python con su lección principal intacta: **el formato se
 * decide por el contenido, no por la extensión**. Muchas URLs que acaban en .mp4
 * sirven un playlist HLS, y guardarlas como mp4 produce archivos de pocos KB que
 * ningún reproductor abre.
 *
 * Lo que añade sobre el script: se sondea *antes* de descargar, así que la interfaz
 * puede decir qué es y cuánto pesa sin bajar nada; los master playlists exponen sus
 * variantes para poder elegir calidad; y ffprobe rellena duración y resolución.
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, accept: '*/*' };

const HLS_MAGIC = '#EXTM3U';

export const URL_RE = /https?:\/\/[^\s"'<>\\]+/g;
export const MEDIA_RE = /\.(mp4|m3u8|mpd|ts|mkv|webm|m4s|flv|aac|mp3)(?:[?&/#]|$)/i;

export function cleanUrl(url) {
  return url.trim().replace(/[.,;:)\]}"']+$/, '');
}

/** Extrae URLs de media de una línea de logcat. */
export function extractUrls(line, { pattern = null } = {}) {
  const text = line.replace(/\\\//g, '/');
  if (pattern) {
    const found = [];
    const rx = new RegExp(pattern, 'g');
    for (const match of text.matchAll(rx)) {
      const value = match[1] ?? match[0];
      if (value) found.push(cleanUrl(value));
    }
    return found;
  }
  return [...text.matchAll(URL_RE)]
    .map((match) => cleanUrl(match[0]))
    .filter((url) => MEDIA_RE.test(url));
}

function hasBinary(name) {
  return new Promise((resolve) => {
    const child = spawn(name, ['-version'], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

let ffmpegAvailable = null;
let ffprobeAvailable = null;

export async function mediaTools() {
  ffmpegAvailable ??= await hasBinary('ffmpeg');
  ffprobeAvailable ??= await hasBinary('ffprobe');
  return { ffmpeg: ffmpegAvailable, ffprobe: ffprobeAvailable };
}

/* ------------------------------------------------------------------ Sondeo */

/**
 * Mira qué hay al otro lado sin descargarlo entero: lee la cabecera y los primeros
 * bytes. Es lo que permite a la interfaz decir «esto es un playlist de 4 calidades»
 * en vez de «esto acaba en .mp4».
 */
export async function probe(url, { timeout = 12_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!response.ok) {
      return { ok: false, status: response.status, detail: `El servidor respondió ${response.status}.` };
    }
    const contentType = response.headers.get('content-type') ?? '';
    const length = Number(response.headers.get('content-length')) || null;
    const acceptsRanges = response.headers.get('accept-ranges') === 'bytes';

    // Solo hacen falta unos KB para saber qué es.
    const reader = response.body?.getReader();
    const chunks = [];
    let read = 0;
    while (reader && read < 16_384) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      read += value.length;
    }
    void reader?.cancel();
    const head = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const text = head.toString('utf8');

    if (text.trimStart().startsWith(HLS_MAGIC)) {
      const variants = parseVariants(url, text);
      return {
        ok: true,
        kind: variants.length > 0 ? 'hls-master' : 'hls-media',
        contentType,
        size: null,
        encrypted: /#EXT-X-KEY(?!.*METHOD=NONE)/.test(text),
        variants,
        playlist: text,
      };
    }
    if (text.trimStart().startsWith('<?xml') && text.includes('<MPD')) {
      return { ok: true, kind: 'dash', contentType, size: length, variants: [] };
    }
    const isMp4 = head.subarray(4, 8).toString('latin1') === 'ftyp';
    return {
      ok: true,
      kind: isMp4 || contentType.startsWith('video/') || contentType.startsWith('audio/')
        ? 'direct'
        : 'unknown',
      contentType,
      size: length,
      resumable: acceptsRanges,
      variants: [],
    };
  } catch (error) {
    return { ok: false, detail: error?.name === 'AbortError' ? 'Sin respuesta a tiempo.' : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Variantes de un master playlist, con su ancho de banda y resolución. */
function parseVariants(baseUrl, text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const target = lines[index + 1];
    if (!target || target.startsWith('#')) continue;
    variants.push({
      url: new URL(target, baseUrl).toString(),
      bandwidth: Number(/BANDWIDTH=(\d+)/.exec(line)?.[1]) || null,
      resolution: /RESOLUTION=([\dx]+)/.exec(line)?.[1] ?? null,
      codecs: /CODECS="([^"]+)"/.exec(line)?.[1] ?? null,
    });
  }
  return variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
}

/* --------------------------------------------------------------- Metadatos */

export async function ffprobeInfo(path) {
  if (!(await mediaTools()).ffprobe) return null;
  return new Promise((resolve) => {
    const child = spawn(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path],
      { windowsHide: true },
    );
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try {
        const data = JSON.parse(out);
        const video = data.streams?.find((stream) => stream.codec_type === 'video');
        resolve({
          duration: Number(data.format?.duration) || null,
          resolution: video ? `${video.width}x${video.height}` : null,
          videoCodec: video?.codec_name ?? null,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

/* --------------------------------------------------------------- Descarga */

export class DownloadError extends Error {}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
}

/**
 * Descarga una URL. `onProgress({done,total,phase})` recibe bytes reales.
 * Devuelve `{ path, size, kind }`.
 */
export async function download(url, outDir, { onProgress, signal, name } = {}) {
  await mkdir(outDir, { recursive: true });
  const base = join(outDir, name ? name.replace(/[^\w.-]+/g, '_') : `captura_${stamp()}`);
  const info = await probe(url);
  if (!info.ok) throw new DownloadError(info.detail ?? 'No se pudo abrir la URL.');

  if (info.kind === 'hls-master' || info.kind === 'hls-media' || info.kind === 'dash') {
    if (info.encrypted) {
      // Frontera deliberada: aquí no se descifra contenido protegido.
      throw new DownloadError(
        'El playlist está cifrado. Esta herramienta no descifra contenido protegido.',
      );
    }
    const path = await downloadWithFfmpeg(url, `${base}.mp4`, { onProgress, signal });
    const size = (await stat(path)).size;
    return { path, size, kind: info.kind };
  }

  const path = await downloadDirect(url, base, info, { onProgress, signal });
  const size = (await stat(path)).size;
  return { path, size, kind: 'direct' };
}

async function downloadDirect(url, base, info, { onProgress, signal }) {
  const extension = (/\.(mp4|mkv|webm|ts|m4s|aac|mp3)(?:[?#]|$)/i.exec(url)?.[1] ?? 'mp4').toLowerCase();
  const dest = `${base}.${extension}`;
  const tmp = `${dest}.part`;
  const total = info.size;
  let done = 0;

  // Reanuda con Range cuando el servidor lo admite: un corte a los 400 MB no
  // puede obligar a empezar de cero.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const headers = { ...HEADERS };
    if (done > 0) headers.range = `bytes=${done}-`;
    const response = await fetch(url, { headers, signal });
    if (done > 0 && response.status !== 206) {
      done = 0;
      await rm(tmp, { force: true });
    }
    if (!response.ok) throw new DownloadError(`El servidor respondió ${response.status}.`);

    const handle = await open(tmp, done > 0 ? 'a' : 'w');
    try {
      const sink = handle.createWriteStream();
      const counter = new TransformStreamCounter((bytes) => {
        done += bytes;
        onProgress?.({ done, total, phase: 'downloading' });
      });
      await pipeline(Readable.fromWeb(response.body).pipe(counter), sink);
    } finally {
      await handle.close();
    }

    if (!total || done >= total) {
      await rename(tmp, dest);
      return dest;
    }
    if (attempt === 3) throw new DownloadError(`Incompleto: ${done} de ${total} bytes.`);
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  throw new DownloadError('No se pudo completar la descarga.');
}

/** Contador de bytes sin dependencias, para poder informar progreso real. */
class TransformStreamCounter extends Transform {
  #onBytes;
  constructor(onBytes) {
    super();
    this.#onBytes = onBytes;
  }
  _transform(chunk, _encoding, callback) {
    this.#onBytes(chunk.length);
    callback(null, chunk);
  }
}

/**
 * HLS y DASH: se remuxean a mp4 sin recodificar. ffmpeg entiende los dos y es el
 * único camino sensato; concatenar segmentos a mano produce .ts que muchos
 * reproductores no buscan bien.
 */
async function downloadWithFfmpeg(url, dest, { onProgress, signal }) {
  if (!(await mediaTools()).ffmpeg) {
    throw new DownloadError(
      'Esto es un stream por segmentos y hace falta ffmpeg para unirlo. Instálalo y vuelve a intentarlo.',
    );
  }
  const tmp = `${dest}.part.mp4`;
  const child = spawn(
    'ffmpeg',
    [
      '-y', '-nostdin', '-loglevel', 'error', '-nostats',
      '-user_agent', UA,
      '-i', url,
      '-c', 'copy', '-movflags', '+faststart',
      '-progress', 'pipe:1',
      tmp,
    ],
    { windowsHide: true },
  );

  signal?.addEventListener('abort', () => child.kill(), { once: true });

  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const [key, value] = line.split('=');
      if (key === 'out_time_ms' && value) {
        onProgress?.({ done: Number(value) / 1000, total: null, phase: 'remuxing' });
      }
      if (key === 'total_size' && value) {
        onProgress?.({ done: Number(value), total: null, phase: 'remuxing' });
      }
    }
  });

  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('close', resolve);
  });

  const written = await stat(tmp).catch(() => null);
  if (code !== 0 || !written || written.size === 0) {
    await rm(tmp, { force: true });
    const last = stderr.trim().split(/\r?\n/).pop();
    throw new DownloadError(last || 'ffmpeg no produjo nada.');
  }
  await rename(tmp, dest);
  return dest;
}

/** Comprobación barata: que lo guardado sea vídeo y no un playlist disfrazado. */
export async function verify(path) {
  const info = await stat(path);
  if (info.size < 1024) return { ok: false, why: `pesa solo ${info.size} B` };
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(12);
    await handle.read(buffer, 0, 12, 0);
    if (buffer.toString('utf8').trimStart().startsWith(HLS_MAGIC)) {
      return { ok: false, why: 'sigue siendo un playlist, no vídeo' };
    }
    if (path.endsWith('.mp4') && !['ftyp', 'styp'].includes(buffer.subarray(4, 8).toString('latin1'))) {
      return { ok: false, why: 'sin cabecera MP4 (ftyp)' };
    }
    if (path.endsWith('.ts') && buffer[0] !== 0x47) {
      return { ok: false, why: 'sin byte de sincronía TS (0x47)' };
    }
  } finally {
    await handle.close();
  }
  return { ok: true };
}
