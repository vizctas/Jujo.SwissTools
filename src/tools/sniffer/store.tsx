/*
 * Estado del capturador.
 *
 * El script original escuchaba un dispositivo, guardaba las URLs en un `set` y
 * descargaba en serie. Aquí lo que cambia de fondo es que la URL se **sondea** en
 * cuanto aparece: antes de decidir nada ya sabes si es un mp4 directo, un playlist
 * con cuatro calidades o un enlace muerto. Eso es lo que convierte una lista de
 * texto en algo sobre lo que decidir.
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
import { useBridge } from '../../bridge/provider.tsx';
import type {
  BridgeEvent,
  Capture,
  MediaProbe,
  SnifferProfile,
  SnifferSession,
} from '../../bridge/protocol.ts';

export interface Hit {
  url: string;
  serial: string;
  at: number;
  probe: MediaProbe | null;
  probing: boolean;
  /** Descarga en curso o terminada para esta URL. */
  captureId: string | null;
}

export interface CaptureProgress {
  id: string;
  url: string;
  done: number;
  total: number | null;
  phase: string;
  result: { ok: boolean; path?: string; size?: number; detail?: string | null } | null;
  error: string | null;
}

interface SnifferStore {
  sessions: SnifferSession[];
  isRunning: (serial: string) => boolean;
  start: (serial: string, profileId: string) => Promise<void>;
  stop: (serial: string) => Promise<void>;

  profiles: SnifferProfile[];
  profileId: string;
  setProfileId: (id: string) => void;
  saveProfile: (profile: { id?: string; name: string; logFilter: string; pattern: string | null }) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;

  hits: Hit[];
  clearHits: () => void;
  tail: string[];
  linesSeen: number;
  reconnecting: { serial: string; attempt: number } | null;

  autoDownload: boolean;
  setAutoDownload: (value: boolean) => void;

  captureUrl: (url: string, serial: string, name?: string) => Promise<void>;
  cancelCapture: (id: string) => Promise<void>;
  progress: Record<string, CaptureProgress>;

  history: Capture[];
  refreshHistory: () => Promise<void>;
  clearHistory: () => Promise<void>;
  reveal: (path?: string) => Promise<void>;
  downloadDir: string | null;
  ffmpeg: boolean;
}

const Context = createContext<SnifferStore | null>(null);

export function useSniffer(): SnifferStore {
  const store = useContext(Context);
  if (!store) throw new Error('useSniffer fuera de <SnifferProvider>');
  return store;
}

/** Tope del tail en memoria; el puente ya recorta, esto protege de una ráfaga. */
const TAIL_LIMIT = 300;

export function SnifferProvider({ children }: { children: ReactNode }): ReactNode {
  const { command, subscribe, profiles, downloadDir, tools, status } = useBridge();

  const [sessions, setSessions] = useState<SnifferSession[]>([]);
  const [hits, setHits] = useState<Hit[]>([]);
  const [tail, setTail] = useState<string[]>([]);
  const [linesSeen, setLinesSeen] = useState(0);
  const [reconnecting, setReconnecting] = useState<{ serial: string; attempt: number } | null>(null);
  const [profileId, setProfileId] = useState('any-media');
  const [autoDownload, setAutoDownload] = useState(false);
  const [progress, setProgress] = useState<Record<string, CaptureProgress>>({});
  const [history, setHistory] = useState<Capture[]>([]);
  const [localProfiles, setLocalProfiles] = useState<SnifferProfile[]>([]);

  // `autoDownload` se lee dentro del manejador de eventos, que se registra una vez.
  // Sin ref leería el valor del primer render para siempre.
  const autoRef = useRef(autoDownload);
  autoRef.current = autoDownload;

  const allProfiles = localProfiles.length > 0 ? localProfiles : profiles;

  const captureUrl = useCallback(
    async (url: string, serial: string, name?: string) => {
      const id = crypto.randomUUID();
      setProgress((current) => ({
        ...current,
        [id]: { id, url, done: 0, total: null, phase: 'starting', result: null, error: null },
      }));
      setHits((current) =>
        current.map((hit) => (hit.url === url ? { ...hit, captureId: id } : hit)),
      );
      await command({ t: 'media.download', captureId: id, url, serial, name });
    },
    [command],
  );

  /* -------------------------------------------------------------- Eventos */

  useEffect(
    () =>
      subscribe((event: BridgeEvent) => {
        switch (event.t) {
          case 'hello':
            if (event.sessions) setSessions(event.sessions);
            if (event.profiles) setLocalProfiles(event.profiles);
            break;

          case 'sniffer.started':
            setReconnecting(null);
            void command<{ ok: boolean; sessions: SnifferSession[] }>({ t: 'sniffer.status' }).then(
              (result) => result.ok && setSessions(result.sessions),
            );
            break;

          case 'sniffer.stopped':
            setSessions((current) => current.filter((item) => item.serial !== event.serial));
            break;

          case 'sniffer.lines':
            setLinesSeen(event.total);
            setTail((current) => {
              const next = [...current, ...event.lines];
              return next.length > TAIL_LIMIT ? next.slice(next.length - TAIL_LIMIT) : next;
            });
            break;

          case 'sniffer.reconnecting':
            setReconnecting({ serial: event.serial, attempt: event.attempt });
            break;

          case 'sniffer.url': {
            const hit: Hit = {
              url: event.url,
              serial: event.serial,
              at: event.at,
              probe: null,
              probing: true,
              captureId: null,
            };
            setHits((current) =>
              current.some((item) => item.url === event.url) ? current : [hit, ...current],
            );
            // Sondeo inmediato: saber qué es cuesta unos KB y evita descargar basura.
            void command<{ ok: boolean; info: MediaProbe }>({ t: 'media.probe', url: event.url })
              .then((result) => {
                setHits((current) =>
                  current.map((item) =>
                    item.url === event.url
                      ? { ...item, probe: result.info ?? null, probing: false }
                      : item,
                  ),
                );
                if (autoRef.current && result.info?.ok) {
                  void captureUrl(event.url, event.serial);
                }
              })
              .catch(() =>
                setHits((current) =>
                  current.map((item) =>
                    item.url === event.url ? { ...item, probing: false } : item,
                  ),
                ),
              );
            break;
          }

          case 'capture.progress':
            setProgress((current) =>
              current[event.id]
                ? {
                    ...current,
                    [event.id]: {
                      ...current[event.id]!,
                      done: event.done,
                      total: event.total,
                      phase: event.phase,
                    },
                  }
                : current,
            );
            break;

          case 'capture.done':
            setProgress((current) =>
              current[event.id]
                ? {
                    ...current,
                    [event.id]: {
                      ...current[event.id]!,
                      phase: 'done',
                      result: {
                        ok: event.ok,
                        path: event.path,
                        size: event.size,
                        detail: event.detail,
                      },
                    },
                  }
                : current,
            );
            void command<{ ok: boolean; captures: Capture[] }>({ t: 'media.history' }).then(
              (result) => result.ok && setHistory(result.captures),
            );
            break;

          case 'capture.failed':
            setProgress((current) =>
              current[event.id]
                ? { ...current, [event.id]: { ...current[event.id]!, phase: 'done', error: event.message } }
                : current,
            );
            break;

          default:
            break;
        }
      }),
    [subscribe, command, captureUrl],
  );

  useEffect(() => {
    if (status.kind !== 'connected') return;
    void command<{ ok: boolean; captures: Capture[] }>({ t: 'media.history' }).then(
      (result) => result.ok && setHistory(result.captures),
    );
    void command<{ ok: boolean; profiles: SnifferProfile[] }>({ t: 'sniffer.profiles' }).then(
      (result) => result.ok && setLocalProfiles(result.profiles),
    );
  }, [status.kind, command]);

  const store = useMemo<SnifferStore>(
    () => ({
      sessions,
      isRunning: (serial) => sessions.some((session) => session.serial === serial),
      start: async (serial, id) => {
        setTail([]);
        setLinesSeen(0);
        await command({ t: 'sniffer.start', serial, profileId: id });
      },
      stop: async (serial) => {
        await command({ t: 'sniffer.stop', serial });
      },

      profiles: allProfiles,
      profileId,
      setProfileId,
      saveProfile: async (profile) => {
        const result = await command<{ ok: boolean; profiles: SnifferProfile[] }>({
          t: 'sniffer.saveProfile',
          ...profile,
        });
        if (result.ok) setLocalProfiles(result.profiles);
      },
      deleteProfile: async (id) => {
        const result = await command<{ ok: boolean; profiles: SnifferProfile[] }>({
          t: 'sniffer.deleteProfile',
          id,
        });
        if (result.ok) setLocalProfiles(result.profiles);
      },

      hits,
      clearHits: () => setHits([]),
      tail,
      linesSeen,
      reconnecting,

      autoDownload,
      setAutoDownload,

      captureUrl,
      cancelCapture: async (id) => {
        await command({ t: 'media.cancel', id });
      },
      progress,

      history,
      refreshHistory: async () => {
        const result = await command<{ ok: boolean; captures: Capture[] }>({ t: 'media.history' });
        if (result.ok) setHistory(result.captures);
      },
      clearHistory: async () => {
        await command({ t: 'media.clearHistory' });
        setHistory([]);
      },
      reveal: async (path) => {
        await command({ t: 'media.reveal', path });
      },
      downloadDir,
      ffmpeg: tools.ffmpeg,
    }),
    [
      sessions, allProfiles, profileId, hits, tail, linesSeen, reconnecting,
      autoDownload, progress, history, downloadDir, tools.ffmpeg, command, captureUrl,
    ],
  );

  return <Context.Provider value={store}>{children}</Context.Provider>;
}
