/*
 * Estado de la herramienta de APK.
 *
 * Vive aparte del estado del generador de QR a propósito: son dos herramientas que
 * no comparten nada, y un store común sería el primer paso hacia el monolito.
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
import { readApk, ApkParseError, type ApkInfo } from './apk-info.ts';
import type { BridgeConfig, BridgeStatus } from '../../bridge/client.ts';
import { useBridge } from '../../bridge/provider.tsx';
import { checkApk, checkDevice, isBlocked, type DeviceCheck } from './checks.ts';
import {
  addToLibrary,
  loadLibrary,
  markInstalled,
  readBlob,
  removeFromLibrary,
  QuotaError,
  type LibraryEntry,
} from './library.ts';
import type {
  BridgeDevice,
  BridgeEvent,
  InstallFlag,
  InstalledPackage,
  InstallPhase,
} from '../../bridge/protocol.ts';

export interface LoadedApk {
  id: string;
  file: File;
  info: ApkInfo;
}

export interface DeviceJob {
  phase: InstallPhase | 'done';
  percent: number | null;
  result: {
    ok: boolean;
    code?: string;
    message?: string;
    flag?: InstallFlag | null;
    flagLabel?: string | null;
    output?: string;
  } | null;
}

export interface InstallJob {
  id: string;
  startedAt: number;
  uploadFraction: number;
  devices: Record<string, DeviceJob>;
  finished: boolean;
  error: string | null;
}

export type FlagSet = Record<InstallFlag, boolean>;

const NO_FLAGS: FlagSet = {
  reinstall: true,
  downgrade: false,
  grantPermissions: false,
  allowTest: false,
  uninstallFirst: false,
};

interface ApkStore {
  status: BridgeStatus;
  config: BridgeConfig;
  setConfig: (config: BridgeConfig) => void;
  retry: () => void;

  devices: BridgeDevice[];
  devicesError: string | null;
  selected: Set<string>;
  toggleDevice: (serial: string) => void;
  selectAllInstallable: () => void;
  connectAddress: (address: string) => Promise<{ ok: boolean; message?: string }>;
  disconnectAddress: (address: string) => Promise<void>;
  refreshDevices: () => Promise<void>;

  apk: LoadedApk | null;
  apkError: string | null;
  loadingApk: boolean;
  openFile: (file: File) => Promise<void>;
  clearApk: () => void;

  installed: Record<string, InstalledPackage | null>;
  apkChecks: DeviceCheck[];
  checksFor: (serial: string) => DeviceCheck[];

  flags: FlagSet;
  setFlag: (flag: InstallFlag, value: boolean) => void;

  job: InstallJob | null;
  install: () => Promise<void>;
  cancel: () => Promise<void>;
  dismissJob: () => void;

  library: LibraryEntry[];
  libraryError: string | null;
  useLibraryEntry: (entry: LibraryEntry) => Promise<void>;
  dropLibraryEntry: (id: string) => Promise<void>;
}

const Context = createContext<ApkStore | null>(null);

export function useApk(): ApkStore {
  const store = useContext(Context);
  if (!store) throw new Error('useApk fuera de <ApkProvider>');
  return store;
}

/** Traduce las banderas de la interfaz a argumentos de adb. */
function flagArgs(flags: FlagSet): string[] {
  const args: string[] = [];
  if (flags.reinstall) args.push('-r');
  if (flags.downgrade) args.push('-d');
  if (flags.grantPermissions) args.push('-g');
  if (flags.allowTest) args.push('-t');
  return args;
}

export function ApkProvider({ children }: { children: ReactNode }): ReactNode {
  const bridge = useBridge();
  const { status, config, devices, devicesError, command, subscribe } = bridge;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [apk, setApk] = useState<LoadedApk | null>(null);
  const [apkError, setApkError] = useState<string | null>(null);
  const [loadingApk, setLoadingApk] = useState(false);
  const [installed, setInstalled] = useState<Record<string, InstalledPackage | null>>({});
  const [flags, setFlags] = useState<FlagSet>(NO_FLAGS);
  const [job, setJob] = useState<InstallJob | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const jobRef = useRef<string | null>(null);

  /* ------------------------------------- Eventos de instalación del puente */

  useEffect(
    () =>
      subscribe((event: BridgeEvent) => {
        switch (event.t) {
          case 'install.phase':
            setJob((current) =>
              current && current.id === event.jobId
                ? {
                    ...current,
                    devices: {
                      ...current.devices,
                      [event.serial]: {
                        ...(current.devices[event.serial] ?? { percent: null, result: null }),
                        phase: event.phase,
                      },
                    },
                  }
                : current,
            );
            break;
          case 'install.progress':
            setJob((current) =>
              current && current.id === event.jobId
                ? {
                    ...current,
                    devices: {
                      ...current.devices,
                      [event.serial]: {
                        ...(current.devices[event.serial] ?? { phase: 'transferring', result: null }),
                        percent: event.percent,
                      },
                    },
                  }
                : current,
            );
            break;
          case 'install.result':
            setJob((current) =>
              current && current.id === event.jobId
                ? {
                    ...current,
                    devices: {
                      ...current.devices,
                      [event.serial]: {
                        phase: 'done',
                        percent: event.ok ? 100 : null,
                        result: {
                          ok: event.ok,
                          code: event.code,
                          message: event.message,
                          flag: event.flag ?? null,
                          flagLabel: event.flagLabel ?? null,
                          output: event.output,
                        },
                      },
                    },
                  }
                : current,
            );
            break;
          case 'install.done':
            setJob((current) =>
              current && current.id === event.jobId ? { ...current, finished: true } : current,
            );
            jobRef.current = null;
            break;
          case 'install.rejected':
            setJob((current) =>
              current && current.id === event.jobId
                ? { ...current, finished: true, error: event.message }
                : current,
            );
            jobRef.current = null;
            break;
          default:
            break;
        }
      }),
    [subscribe],
  );

  useEffect(() => {
    void loadLibrary().then(setLibrary);
  }, []);

  // Un dispositivo que desaparece no puede seguir seleccionado.
  useEffect(() => {
    setSelected((current) => {
      const alive = new Set(devices.map((device) => device.serial));
      const next = new Set([...current].filter((serial) => alive.has(serial)));
      return next.size === current.size ? current : next;
    });
  }, [devices]);

  /* --------------------------------------------------- Versión instalada */

  const packageName = apk?.info.packageName ?? null;
  const serialsKey = devices
    .filter((device) => device.state === 'device')
    .map((device) => device.serial)
    .join(',');

  useEffect(() => {
    if (!packageName || serialsKey === '' || status.kind !== 'connected') {
      setInstalled({});
      return;
    }
    let cancelled = false;
    void command<{ ok: boolean; installed?: Record<string, InstalledPackage | null> }>({
      t: 'packages.status',
      packageName,
      serials: serialsKey.split(','),
    })
      .then((result) => {
        if (!cancelled && result.ok && result.installed) setInstalled(result.installed);
      })
      .catch(() => {
        // Que no se pueda leer la versión instalada no impide instalar; el guardián
        // simplemente tendrá un dato menos y lo dice en su propio aviso.
      });
    return () => {
      cancelled = true;
    };
  }, [packageName, serialsKey, status.kind]);

  /* ------------------------------------------------------------- Acciones */

  const openFile = useCallback(async (file: File) => {
    setLoadingApk(true);
    setApkError(null);
    try {
      const info = await readApk(file);
      const id = crypto.randomUUID();
      setApk({ id, file, info });
      setFlags({ ...NO_FLAGS });
      try {
        setLibrary(await addToLibrary(id, file, info));
        setLibraryError(null);
      } catch (error) {
        // No poder archivarlo no impide instalarlo: se avisa y se sigue.
        setLibraryError(error instanceof QuotaError ? error.message : String(error));
      }
    } catch (error) {
      setApk(null);
      setApkError(
        error instanceof ApkParseError
          ? error.message
          : `No se pudo leer el archivo: ${String(error)}`,
      );
    } finally {
      setLoadingApk(false);
    }
  }, []);

  const apkChecks = useMemo(() => (apk ? checkApk(apk.info) : []), [apk]);

  const checksFor = useCallback(
    (serial: string): DeviceCheck[] => {
      const device = devices.find((candidate) => candidate.serial === serial);
      if (!device || !apk) return [];
      return checkDevice(apk.info, device, installed[serial] ?? null);
    },
    [devices, apk, installed],
  );

  const install = useCallback(async () => {
    if (!apk || selected.size === 0) return;

    const serials = [...selected].filter((serial) => !isBlocked(checksFor(serial)));
    if (serials.length === 0) return;

    const jobId = crypto.randomUUID();
    jobRef.current = jobId;
    const abort = new AbortController();
    abortRef.current = abort;

    setJob({
      id: jobId,
      startedAt: Date.now(),
      uploadFraction: 0,
      devices: Object.fromEntries(
        serials.map((serial) => [serial, { phase: 'preparing', percent: null, result: null }]),
      ),
      finished: false,
      error: null,
    });

    try {
      const upload = await bridge.upload(apk.file, {
        signal: abort.signal,
        onProgress: (fraction) =>
          setJob((current) =>
            current && current.id === jobId ? { ...current, uploadFraction: fraction } : current,
          ),
      });

      await command({
        t: 'install.start',
        jobId,
        uploadId: upload.uploadId,
        serials,
        flags: flagArgs(flags),
        uninstallPackage: flags.uninstallFirst ? apk.info.packageName : null,
      });

      void markInstalled(apk.id, serials).then(setLibrary).catch(() => {});
    } catch (error) {
      jobRef.current = null;
      setJob((current) =>
        current && current.id === jobId
          ? {
              ...current,
              finished: true,
              error:
                error instanceof DOMException && error.name === 'AbortError'
                  ? 'Subida cancelada.'
                  : String(error instanceof Error ? error.message : error),
            }
          : current,
      );
    }
  }, [apk, selected, flags, checksFor, bridge, command]);

  const cancel = useCallback(async () => {
    abortRef.current?.abort();
    const id = jobRef.current;
    if (id) await command({ t: 'install.cancel', jobId: id }).catch(() => {});
  }, [command]);

  const store: ApkStore = {
    status,
    config,
    setConfig: bridge.setConfig,
    retry: bridge.retry,

    devices,
    devicesError,
    selected,
    toggleDevice: (serial) =>
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(serial)) next.delete(serial);
        else next.add(serial);
        return next;
      }),
    selectAllInstallable: () =>
      setSelected(
        new Set(
          devices
            .filter((device) => device.state === 'device' && !isBlocked(checksFor(device.serial)))
            .map((device) => device.serial),
        ),
      ),
    connectAddress: (address) =>
      command<{ ok: boolean; message?: string }>({ t: 'devices.connect', address }),
    disconnectAddress: async (address) => {
      await command({ t: 'devices.disconnect', address });
    },
    refreshDevices: async () => {
      await command({ t: 'devices.refresh' });
    },

    apk,
    apkError,
    loadingApk,
    openFile,
    clearApk: () => {
      setApk(null);
      setApkError(null);
      setInstalled({});
    },

    installed,
    apkChecks,
    checksFor,

    flags,
    setFlag: (flag, value) => setFlags((current) => ({ ...current, [flag]: value })),

    job,
    install,
    cancel,
    dismissJob: () => setJob(null),

    library,
    libraryError,
    useLibraryEntry: async (entry) => {
      const blob = await readBlob(entry.id);
      if (!blob) {
        setLibraryError('El archivo ya no está guardado. Vuelve a cargarlo desde el disco.');
        return;
      }
      setApk({
        id: entry.id,
        file: new File([blob], entry.info.filename, { type: 'application/vnd.android.package-archive' }),
        info: entry.info,
      });
      setApkError(null);
      setLibraryError(null);
    },
    dropLibraryEntry: async (id) => {
      setLibrary(await removeFromLibrary(id));
      if (apk?.id === id) setApk(null);
    },
  };

  return <Context.Provider value={store}>{children}</Context.Provider>;
}
