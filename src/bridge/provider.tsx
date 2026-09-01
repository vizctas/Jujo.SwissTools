/*
 * El puente, compartido.
 *
 * Dos herramientas hablan con el mismo proceso local. Si cada una abriera su propio
 * EventSource habría dos flujos, dos sondeos de dispositivos y dos listas que se
 * contradicen a los dos segundos. Aquí hay una conexión y un censo de dispositivos;
 * cada herramienta se suscribe a los eventos que le importan.
 *
 * Es infraestructura, no estado compartido de negocio: el proveedor no sabe qué es
 * un APK ni qué es una captura.
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
  BridgeClient,
  discoverConfig,
  loadConfig,
  saveConfig,
  type BridgeConfig,
  type BridgeStatus,
  type UploadResult,
} from './client.ts';
import type { BridgeDevice, BridgeEvent, SnifferProfile } from './protocol.ts';

export interface BridgeContextValue {
  status: BridgeStatus;
  config: BridgeConfig;
  setConfig: (config: BridgeConfig) => void;
  retry: () => void;

  devices: BridgeDevice[];
  devicesError: string | null;
  /** Carpeta donde el puente guarda las capturas. */
  downloadDir: string | null;
  /** Qué binarios de media encontró el puente. */
  tools: { ffmpeg: boolean; ffprobe: boolean };
  profiles: SnifferProfile[];

  command: <T = { ok: boolean; message?: string }>(body: unknown) => Promise<T>;
  upload: (
    file: File,
    options?: { onProgress?: (fraction: number) => void; signal?: AbortSignal },
  ) => Promise<UploadResult>;
  /** Suscribe a los eventos del puente. Devuelve la baja. */
  subscribe: (handler: (event: BridgeEvent) => void) => () => void;
}

const Context = createContext<BridgeContextValue | null>(null);

export function useBridge(): BridgeContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('useBridge fuera de <BridgeProvider>');
  return value;
}

export function BridgeProvider({ children }: { children: ReactNode }): ReactNode {
  const [config, setConfigState] = useState<BridgeConfig>(() => loadConfig());
  const [status, setStatus] = useState<BridgeStatus>({ kind: 'idle' });
  const [devices, setDevices] = useState<BridgeDevice[]>([]);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [downloadDir, setDownloadDir] = useState<string | null>(null);
  const [tools, setTools] = useState({ ffmpeg: false, ffprobe: false });
  const [profiles, setProfiles] = useState<SnifferProfile[]>([]);

  const clientRef = useRef<BridgeClient | null>(null);
  const listeners = useRef(new Set<(event: BridgeEvent) => void>());

  // Emparejamiento automático: quien sirve esta página sabe dónde está el puente y
  // cuál es su token. Preguntarle evita el formulario por completo.
  useEffect(() => {
    let cancelled = false;
    void discoverConfig().then((discovered) => {
      if (cancelled || !discovered) return;
      setConfigState((current) =>
        current.token === discovered.token && current.port === discovered.port
          ? current
          : (saveConfig(discovered), discovered),
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const client = new BridgeClient(config);
    clientRef.current = client;
    client.onStatus = setStatus;
    client.onEvent = (event) => {
      switch (event.t) {
        case 'hello':
          setDownloadDir(event.downloadDir ?? null);
          if (event.tools) setTools(event.tools);
          if (event.profiles) setProfiles(event.profiles);
          break;
        case 'devices':
          setDevices(event.devices);
          setDevicesError(null);
          break;
        case 'devices.error':
          setDevicesError(event.message);
          break;
        default:
          break;
      }
      for (const listener of listeners.current) listener(event);
    };
    void client.start();
    return () => {
      client.stop();
      clientRef.current = null;
    };
  }, [config]);

  const subscribe = useCallback((handler: (event: BridgeEvent) => void) => {
    listeners.current.add(handler);
    return () => {
      listeners.current.delete(handler);
    };
  }, []);

  const command = useCallback(<T,>(body: unknown): Promise<T> => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('El puente no está conectado.'));
    return client.command<T>(body);
  }, []);

  const value = useMemo<BridgeContextValue>(
    () => ({
      status,
      config,
      setConfig: (next) => {
        saveConfig(next);
        setConfigState(next);
      },
      retry: () => void clientRef.current?.start(),
      devices,
      devicesError,
      downloadDir,
      tools,
      profiles,
      command,
      upload: (file, options) => {
        const client = clientRef.current;
        if (!client) return Promise.reject(new Error('El puente no está conectado.'));
        return client.upload(file, options);
      },
      subscribe,
    }),
    [status, config, devices, devicesError, downloadDir, tools, profiles, command, subscribe],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}
