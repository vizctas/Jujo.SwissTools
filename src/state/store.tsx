/*
 * Estado del generador.
 *
 * Un solo reducer. Los derivados (cadena codificada, matriz, validación, SVG) se
 * calculan a partir del estado, nunca se guardan: guardarlos sería abrir la puerta
 * a que la vista previa y la exportación se desincronicen.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type Dispatch,
  type ReactNode,
} from 'react';
import { CONTENT_TYPES, contentType, initialValues } from '../lib/content.ts';
import type { ContentTypeId, FieldValues } from '../lib/content.ts';
import { textMeasurer } from '../lib/export.ts';
import { EncodeError, encode } from '../lib/qr.ts';
import type { EncodeResult } from '../lib/qr.ts';
import { centerSlot, fitCenterTextSize, renderSvg } from '../lib/render.ts';
import type { HistoryEntry, Preset, SessionSnapshot } from '../lib/storage.ts';
import {
  clearHistory,
  loadHistory,
  loadPresets,
  loadSession,
  newId,
  pushHistory,
  savePresets,
  saveSession,
} from '../lib/storage.ts';
import { DEFAULT_DESIGN } from '../lib/types.ts';
import type { ErrorLevel, LogoAsset, QrDesign } from '../lib/types.ts';
import { CENTER_LIMIT, comfortableLevelForCenter, validate } from '../lib/validate.ts';
import type { ValidationResult } from '../lib/validate.ts';

const LEVEL_ORDER: readonly ErrorLevel[] = ['L', 'M', 'Q', 'H'];

/** Píxeles por módulo de la vista previa. Solo fija el tamaño intrínseco; el CSS escala. */
const PREVIEW_PX = 12;

export interface QrState {
  typeId: ContentTypeId;
  /** Por tipo, para que cambiar de pestaña no borre lo escrito. */
  valuesByType: Record<ContentTypeId, FieldValues>;
  design: QrDesign;
  /** Lo actualiza el proveedor tras cada codificación; lo necesita el auto-nivel. */
  matrixSize: number;
  activePresetId: string | null;
  /** Cuando la app sube la corrección por lo que hay en el centro, lo dice aquí. Nunca en silencio. */
  autoRaised: { from: ErrorLevel; to: ErrorLevel; kind: 'logo' | 'text' } | null;
}

export type QrAction =
  | { type: 'set-content-type'; id: ContentTypeId }
  | { type: 'set-field'; name: string; value: string }
  | { type: 'patch-design'; patch: Partial<QrDesign> }
  | { type: 'set-logo'; logo: LogoAsset | null }
  | { type: 'matrix-sized'; size: number }
  | { type: 'apply-preset'; preset: Preset }
  | { type: 'detach-preset' }
  | { type: 'restore'; snapshot: SessionSnapshot }
  | { type: 'load-entry'; entry: HistoryEntry }
  | { type: 'reset-design' };

function emptyValues(): Record<ContentTypeId, FieldValues> {
  const all = {} as Record<ContentTypeId, FieldValues>;
  for (const type of CONTENT_TYPES) all[type.id] = initialValues(type.id);
  return all;
}

/**
 * El primer arranque no muestra un hueco: muestra un QR real de esta misma app,
 * ya escaneable, con los controles poblados. El estado vacío enseña la herramienta.
 */
export function seedState(): QrState {
  const values = emptyValues();
  const origin = typeof window === 'undefined' ? 'https://localhost' : window.location.origin;
  values.url = { ...values.url, url: origin };
  return {
    typeId: 'url',
    valuesByType: values,
    design: {
      ...DEFAULT_DESIGN,
      caption: 'Jujo.SwissTools',
      subcaption: 'Escanéalo: es esta misma app',
    },
    matrixSize: 33,
    activePresetId: null,
    autoRaised: null,
  };
}

/**
 * Sube el nivel de corrección cuando el logo ya no cabe en el actual, y deja
 * constancia para que la tira lo diga. No lo baja nunca: bajarlo es decisión
 * del usuario.
 */
interface SettledDesign {
  design: QrDesign;
  autoRaised: QrState['autoRaised'];
}

function withAutoLevel(design: QrDesign, matrixSize: number): SettledDesign {
  const slot = centerSlot(design, matrixSize, textMeasurer());
  if (!slot) return { design, autoRaised: null };
  const needed = comfortableLevelForCenter(slot.widthRatio);
  if (needed && LEVEL_ORDER.indexOf(needed) > LEVEL_ORDER.indexOf(design.errorLevel)) {
    return {
      design: { ...design, errorLevel: needed },
      autoRaised: { from: design.errorLevel, to: needed, kind: slot.kind },
    };
  }
  return { design, autoRaised: null };
}

/**
 * Rellena con los valores de fábrica lo que un diseño guardado no traiga. Un preset
 * escrito antes de que existiera un control llegaría sin ese campo, y el render
 * reventaría con undefined donde espera un número.
 */
function adopt(design: Partial<QrDesign> | undefined): QrDesign {
  return { ...DEFAULT_DESIGN, ...design };
}

export function reducer(state: QrState, action: QrAction): QrState {
  switch (action.type) {
    case 'set-content-type':
      return { ...state, typeId: action.id };

    case 'set-field':
      return {
        ...state,
        valuesByType: {
          ...state.valuesByType,
          [state.typeId]: {
            ...state.valuesByType[state.typeId],
            [action.name]: action.value,
          },
        },
      };

    case 'patch-design': {
      let design = { ...state.design, ...action.patch };

      // Primera letra en el centro: el tamaño inicial se ajusta a lo que el nivel
      // de corrección actual tolera. Es un valor de partida, no una decisión que
      // pise al usuario; a partir de ahí manda su slider.
      if (
        action.patch.centerText !== undefined &&
        state.design.centerText.trim() === '' &&
        design.centerText.trim() !== ''
      ) {
        design = {
          ...design,
          centerTextSize: fitCenterTextSize(
            design,
            state.matrixSize,
            CENTER_LIMIT[design.errorLevel] * 0.85,
            textMeasurer(),
          ),
        };
      }

      // Tocar el nivel a mano es una decisión explícita: no se pisa.
      if ('errorLevel' in action.patch) {
        return { ...state, design, autoRaised: null, activePresetId: null };
      }
      const settled = withAutoLevel(design, state.matrixSize);
      return {
        ...state,
        design: settled.design,
        autoRaised: settled.autoRaised ?? state.autoRaised,
        activePresetId: null,
      };
    }

    case 'set-logo': {
      const settled = withAutoLevel({ ...state.design, logo: action.logo }, state.matrixSize);
      return {
        ...state,
        design: settled.design,
        autoRaised: settled.autoRaised,
        activePresetId: null,
      };
    }

    case 'matrix-sized':
      return action.size === state.matrixSize ? state : { ...state, matrixSize: action.size };

    case 'apply-preset':
      return {
        ...state,
        design: adopt(action.preset.design),
        activePresetId: action.preset.id,
        autoRaised: null,
      };

    case 'detach-preset':
      return { ...state, activePresetId: null };

    case 'restore':
      return {
        ...state,
        typeId: action.snapshot.typeId,
        valuesByType: { ...emptyValues(), ...action.snapshot.valuesByType },
        design: adopt(action.snapshot.design),
        autoRaised: null,
      };

    case 'load-entry':
      return {
        ...state,
        typeId: action.entry.typeId,
        valuesByType: { ...state.valuesByType, [action.entry.typeId]: action.entry.values },
        design: adopt(action.entry.design),
        activePresetId: null,
        autoRaised: null,
      };

    case 'reset-design':
      return { ...state, design: { ...DEFAULT_DESIGN }, activePresetId: null, autoRaised: null };

    default:
      return state;
  }
}

export interface Derived {
  encoded: string;
  fieldErrors: Record<string, string>;
  result: EncodeResult | null;
  encodeError: EncodeError | null;
  validation: ValidationResult | null;
  svg: string;
  /** Proporción alto/ancho de la pieza, para reservar sitio en la mesa. */
  aspect: number;
  /** true cuando faltan campos obligatorios y todavía no hay nada que codificar. */
  incomplete: boolean;
}

interface Store {
  state: QrState;
  dispatch: Dispatch<QrAction>;
  derived: Derived;
  presets: Preset[];
  history: HistoryEntry[];
  savePreset(name: string): Promise<void>;
  renamePreset(id: string, name: string): Promise<void>;
  deletePreset(id: string): Promise<void>;
  recordExport(): Promise<void>;
  clearAllHistory(): Promise<void>;
}

const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore fuera de <StoreProvider>');
  return store;
}

/** Vuelve a renderizar una vez las fuentes están listas, para que medir sea real. */
function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    document.fonts.ready.then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return ready;
}

export function StoreProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, dispatch] = useReducer(reducer, undefined, seedState);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [restored, setRestored] = useState(false);
  const fontsReady = useFontsReady();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [storedPresets, storedHistory, session] = await Promise.all([
        loadPresets(),
        loadHistory(),
        loadSession(),
      ]);
      if (cancelled) return;
      setPresets(storedPresets);
      setHistory(storedHistory);
      if (session) dispatch({ type: 'restore', snapshot: session });
      setRestored(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const derived = useMemo<Derived>(() => {
    const type = contentType(state.typeId);
    const values = state.valuesByType[state.typeId];
    const fieldErrors = type.validate(values);
    const encoded = type.encode(values);

    let result: EncodeResult | null = null;
    let encodeError: EncodeError | null = null;
    if (encoded !== '') {
      try {
        result = encode(encoded, state.design.errorLevel);
      } catch (error) {
        encodeError = error instanceof EncodeError ? error : null;
      }
    }

    if (!result) {
      return {
        encoded,
        fieldErrors,
        result: null,
        encodeError,
        validation: null,
        svg: '',
        aspect: 1,
        incomplete: encoded === '',
      };
    }

    const measure = textMeasurer();
    const rendered = renderSvg(result.matrix, state.design, {
      measureText: fontsReady ? measure : undefined,
      title: `Código QR: ${type.summarize(values)}`,
      // Dimensiones intrínsecas: sin ellas el SVG se comporta como una caja de 0×0
      // y no hay max-width que lo escale. Con ellas se encuadra como una imagen.
      pixelWidth: (result.matrix.size + state.design.quietZone * 2) * PREVIEW_PX,
    });

    // La ocupación del centro se mide con la misma fuente que se dibuja, para que
    // el guardián juzgue la pieza real y no una estimación.
    const slot = centerSlot(state.design, result.matrix.size, measure);

    return {
      encoded,
      fieldErrors,
      result,
      encodeError: null,
      validation: validate(state.design, result.matrix.size, slot ? {
        kind: slot.kind,
        widthRatio: slot.widthRatio,
        // Se calcula contra el mejor presupuesto posible (nivel H); si con eso basta
        // un nivel más bajo, el auto-nivel lo deja donde toque al aplicar la corrección.
        ...(slot.kind === 'text'
          ? {
              fittedSize: fitCenterTextSize(
                state.design,
                result.matrix.size,
                CENTER_LIMIT.H * 0.85,
                measure,
              ),
            }
          : {}),
      } : null),
      svg: rendered.svg,
      aspect: rendered.height / rendered.width,
      incomplete: false,
    };
  }, [state.typeId, state.valuesByType, state.design, fontsReady]);

  // El auto-nivel necesita el tamaño real de la matriz; se sincroniza tras codificar.
  useEffect(() => {
    if (derived.result) dispatch({ type: 'matrix-sized', size: derived.result.matrix.size });
  }, [derived.result]);

  // Sesión: se guarda con retardo para no escribir en cada tecla.
  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => {
      void saveSession({
        typeId: state.typeId,
        valuesByType: state.valuesByType,
        design: state.design,
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [restored, state.typeId, state.valuesByType, state.design]);

  const store = useMemo<Store>(
    () => ({
      state,
      dispatch,
      derived,
      presets,
      history,
      async savePreset(name) {
        const preset: Preset = {
          id: newId(),
          name: name.trim() || 'Preset sin nombre',
          design: { ...state.design },
          createdAt: Date.now(),
        };
        const next = [preset, ...presets];
        setPresets(next);
        await savePresets(next);
        dispatch({ type: 'apply-preset', preset });
      },
      async renamePreset(id, name) {
        const next = presets.map((preset) =>
          preset.id === id ? { ...preset, name: name.trim() || preset.name } : preset,
        );
        setPresets(next);
        await savePresets(next);
      },
      async deletePreset(id) {
        const next = presets.filter((preset) => preset.id !== id);
        setPresets(next);
        await savePresets(next);
      },
      async recordExport() {
        const type = contentType(state.typeId);
        const values = state.valuesByType[state.typeId];
        const next = await pushHistory({
          id: newId(),
          createdAt: Date.now(),
          typeId: state.typeId,
          values,
          design: state.design,
          label: type.summarize(values),
        });
        setHistory(next);
      },
      async clearAllHistory() {
        setHistory([]);
        await clearHistory();
      },
    }),
    [state, derived, presets, history],
  );

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
