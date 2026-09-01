/*
 * Estado del recortador.
 *
 * Dos ritmos distintos conviven aquí y por eso están separados: inferir tarda
 * segundos y ocurre una vez por imagen; recomponer es instantáneo y ocurre cada vez
 * que tocas un slider. La máscara se guarda para no volver a pagar lo caro.
 *
 * Las miniaturas se componen a baja resolución y la resolución completa solo se
 * pinta al exportar: con veinte imágenes de 12 megapíxeles, recomponer todo a
 * tamaño real en cada movimiento del ratón congelaría la pestaña.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  canvasToBlob,
  composeCanvas,
  coverage,
  outputName,
  DEFAULT_COMPOSE,
  type ComposeOptions,
  type MaskData,
} from './compose.ts';
import { DEFAULT_MODEL, findModel } from './models.ts';
import type { BgWorkerResponse } from './protocol.ts';

export type ItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface BgItem {
  id: string;
  file: File;
  name: string;
  width: number;
  height: number;
  /** La original, para el antes/después. */
  sourceUrl: string;
  /** Miniatura ya compuesta con las opciones actuales. */
  previewUrl: string | null;
  status: ItemStatus;
  mask: MaskData | null;
  /** Fracción del encuadre que ocupa el sujeto; avisa de recortes vacíos. */
  coverage: number | null;
  ms: number | null;
  error: string | null;
}

export type ModelStatus =
  | { kind: 'idle' }
  | { kind: 'loading'; progress: number; file: string | null }
  | { kind: 'ready'; device: string }
  | { kind: 'failed'; message: string };

/** Tamaño de las miniaturas compuestas. Suficiente para juzgar el borde. */
const PREVIEW_MAX = 480;

/** Aviso a partir de aquí: cada máscara ocupa ancho×alto bytes en memoria. */
const MANY_FILES = 30;

interface BgStore {
  items: BgItem[];
  addFiles: (files: FileList | File[]) => Promise<void>;
  removeItem: (id: string) => void;
  clearAll: () => void;
  retry: (id: string) => void;
  cancelAll: () => void;

  modelId: string;
  setModelId: (id: string) => void;
  modelStatus: ModelStatus;
  loadModel: () => void;

  options: ComposeOptions;
  setOption: <K extends keyof ComposeOptions>(key: K, value: ComposeOptions[K]) => void;

  exportOne: (id: string) => Promise<void>;
  exportAll: () => Promise<void>;
  exporting: boolean;

  busy: boolean;
  warning: string | null;
}

const Context = createContext<BgStore | null>(null);

export function useBg(): BgStore {
  const store = useContext(Context);
  if (!store) throw new Error('useBg fuera de <BgProvider>');
  return store;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function BgProvider({ children }: { children: ReactNode }): ReactNode {
  const [items, setItems] = useState<BgItem[]>([]);
  const [modelId, setModelId] = useState(DEFAULT_MODEL);
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ kind: 'idle' });
  const [options, setOptions] = useState<ComposeOptions>(DEFAULT_COMPOSE);
  const [exporting, setExporting] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const bitmaps = useRef(new Map<string, ImageBitmap>());
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /* ------------------------------------------------------------- El worker */

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<BgWorkerResponse>) => {
      const message = event.data;
      switch (message.t) {
        case 'loading':
          setModelStatus({ kind: 'loading', progress: message.progress, file: message.file });
          break;
        case 'ready':
          setModelStatus({ kind: 'ready', device: message.device });
          break;
        case 'load-failed':
          setModelStatus({ kind: 'failed', message: message.message });
          break;
        case 'started':
          setItems((current) =>
            current.map((item) => (item.id === message.id ? { ...item, status: 'running' } : item)),
          );
          break;
        case 'done': {
          const mask: MaskData = {
            mask: message.mask,
            width: message.width,
            height: message.height,
          };
          setItems((current) =>
            current.map((item) =>
              item.id === message.id
                ? {
                    ...item,
                    status: 'done',
                    mask,
                    ms: message.ms,
                    coverage: coverage(mask),
                    error: null,
                  }
                : item,
            ),
          );
          break;
        }
        case 'failed':
          setItems((current) =>
            current.map((item) =>
              item.id === message.id
                ? { ...item, status: 'failed', error: message.message }
                : item,
            ),
          );
          break;
        case 'cancelled':
          setItems((current) =>
            current.map((item) =>
              item.id === message.id ? { ...item, status: 'cancelled' } : item,
            ),
          );
          break;
        default:
          break;
      }
    });
    workerRef.current = worker;
    return worker;
  }, []);

  const loadModel = useCallback(() => {
    const model = findModel(modelId);
    setModelStatus({ kind: 'loading', progress: 0, file: null });
    ensureWorker().postMessage({
      t: 'load',
      modelId: model.id,
      dtype: model.dtype,
      device: 'auto',
    });
  }, [modelId, ensureWorker]);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      for (const bitmap of bitmaps.current.values()) bitmap.close();
      bitmaps.current.clear();
    },
    [],
  );

  /* ------------------------------------------------- Alta de imágenes y cola */

  const addFiles = useCallback(
    async (input: FileList | File[]) => {
      const files = [...input].filter((file) => file.type.startsWith('image/'));
      if (files.length === 0) {
        setWarning('Ninguno de esos archivos es una imagen.');
        return;
      }
      setWarning(
        files.length > MANY_FILES
          ? `Has soltado ${files.length} imágenes. Se procesan todas, pero cada máscara ocupa memoria: si el navegador se queja, ve por tandas.`
          : null,
      );

      const created: BgItem[] = [];
      for (const file of files) {
        const id = crypto.randomUUID();
        try {
          const bitmap = await createImageBitmap(file);
          bitmaps.current.set(id, bitmap);
          created.push({
            id,
            file,
            name: file.name,
            width: bitmap.width,
            height: bitmap.height,
            sourceUrl: URL.createObjectURL(file),
            previewUrl: null,
            status: 'pending',
            mask: null,
            coverage: null,
            ms: null,
            error: null,
          });
        } catch {
          // Un archivo con extensión de imagen que el navegador no sabe decodificar
          // (HEIC en Chrome, por ejemplo) no debe tumbar el lote entero.
          created.push({
            id,
            file,
            name: file.name,
            width: 0,
            height: 0,
            sourceUrl: '',
            previewUrl: null,
            status: 'failed',
            mask: null,
            coverage: null,
            ms: null,
            error: 'El navegador no sabe abrir este formato.',
          });
        }
      }
      setItems((current) => [...current, ...created]);

      const worker = ensureWorker();
      if (modelStatus.kind !== 'ready') loadModel();
      for (const item of created) {
        if (item.status === 'failed') continue;
        worker.postMessage({ t: 'process', id: item.id, blob: item.file });
      }
    },
    [ensureWorker, loadModel, modelStatus.kind],
  );

  /* ------------------------------------------------------ Recomposición */

  // Cada cambio de opción repinta las miniaturas.
  //
  // `toBlob` y no `toDataURL`: el segundo codifica en el hilo principal y de forma
  // síncrona, y con tres imágenes grandes a la vez congela la pestaña — justo lo que
  // el worker existía para evitar. Además se cede el hilo entre imágenes.
  useEffect(() => {
    let cancelled = false;
    const pending = items.filter((item) => item.status === 'done' && item.mask);
    if (pending.length === 0) return;

    void (async () => {
      for (const item of pending) {
        if (cancelled) return;
        const bitmap = bitmaps.current.get(item.id);
        if (!bitmap || !item.mask) continue;

        const full = composeCanvas(bitmap, item.mask, optionsRef.current);
        const scale = Math.min(1, PREVIEW_MAX / Math.max(full.width, full.height));
        const preview = document.createElement('canvas');
        preview.width = Math.max(1, Math.round(full.width * scale));
        preview.height = Math.max(1, Math.round(full.height * scale));
        const context = preview.getContext('2d')!;
        context.imageSmoothingQuality = 'high';
        context.drawImage(full, 0, 0, preview.width, preview.height);

        const blob = await new Promise<Blob | null>((resolve) =>
          preview.toBlob(resolve, 'image/png'),
        );
        if (cancelled || !blob) return;
        const url = URL.createObjectURL(blob);

        setItems((current) =>
          current.map((candidate) => {
            if (candidate.id !== item.id) return candidate;
            // La anterior se revoca con retraso, no en el acto: el <img> puede
            // seguir pintándola este fotograma, y revocarla debajo lo deja en blanco.
            const stale = candidate.previewUrl;
            if (stale) setTimeout(() => URL.revokeObjectURL(stale), 5000);
            return { ...candidate, previewUrl: url };
          }),
        );
        // Cede el hilo: con un lote grande, encadenar sin respirar bloquea igual.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();

    return () => {
      cancelled = true;
    };
    // Solo cuando cambian las opciones o llega una máscara nueva; `items` entero
    // dispararía un bucle infinito porque este efecto escribe en `items`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, items.map((item) => (item.mask ? item.id : '')).join(',')]);

  /* --------------------------------------------------------- Exportación */

  const exportItem = useCallback(async (item: BgItem, current: ComposeOptions) => {
    const bitmap = bitmaps.current.get(item.id);
    if (!bitmap || !item.mask) return;
    const canvas = composeCanvas(bitmap, item.mask, current);
    saveBlob(await canvasToBlob(canvas, current.format), outputName(item.name, current.format));
  }, []);

  const store = useMemo<BgStore>(() => {
    const busy = items.some((item) => item.status === 'pending' || item.status === 'running');
    return {
      items,
      addFiles,
      removeItem: (id) => {
        bitmaps.current.get(id)?.close();
        bitmaps.current.delete(id);
        setItems((current) => {
          const target = current.find((item) => item.id === id);
          if (target?.sourceUrl) URL.revokeObjectURL(target.sourceUrl);
          if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
          return current.filter((item) => item.id !== id);
        });
        workerRef.current?.postMessage({ t: 'cancel', id });
      },
      clearAll: () => {
        workerRef.current?.postMessage({ t: 'cancel-all' });
        for (const item of items) {
          if (item.sourceUrl) URL.revokeObjectURL(item.sourceUrl);
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        }
        for (const bitmap of bitmaps.current.values()) bitmap.close();
        bitmaps.current.clear();
        setItems([]);
        setWarning(null);
      },
      retry: (id) => {
        const item = items.find((candidate) => candidate.id === id);
        if (!item) return;
        setItems((current) =>
          current.map((candidate) =>
            candidate.id === id ? { ...candidate, status: 'pending', error: null } : candidate,
          ),
        );
        ensureWorker().postMessage({ t: 'process', id, blob: item.file });
      },
      cancelAll: () => workerRef.current?.postMessage({ t: 'cancel-all' }),

      modelId,
      setModelId: (id) => {
        setModelId(id);
        setModelStatus({ kind: 'idle' });
      },
      modelStatus,
      loadModel,

      options,
      setOption: (key, value) => setOptions((current) => ({ ...current, [key]: value })),

      exportOne: async (id) => {
        const item = items.find((candidate) => candidate.id === id);
        if (item) await exportItem(item, options);
      },
      exportAll: async () => {
        setExporting(true);
        try {
          // En serie y con una pausa: los navegadores estrangulan las descargas
          // simultáneas y algunas se pierden en silencio.
          for (const item of items.filter((candidate) => candidate.status === 'done')) {
            await exportItem(item, options);
            await new Promise((resolve) => setTimeout(resolve, 350));
          }
        } finally {
          setExporting(false);
        }
      },
      exporting,

      busy,
      warning,
    };
  }, [items, addFiles, ensureWorker, modelId, modelStatus, loadModel, options, exportItem, exporting, warning]);

  return <Context.Provider value={store}>{children}</Context.Provider>;
}
