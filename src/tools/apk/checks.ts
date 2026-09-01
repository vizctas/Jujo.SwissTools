/*
 * El guardián de instalación.
 *
 * Mismo principio que el del QR: conocer las reglas y avisar antes de que el usuario
 * se equivoque. Aquí gastar dos minutos subiendo 200 MB para que adb conteste
 * INSTALL_FAILED_NO_MATCHING_ABIS es exactamente el error que hay que evitar.
 *
 * Cada hallazgo dice problema, consecuencia y acción, y trae la bandera de adb que
 * lo arregla cuando existe.
 */

import type { ApkInfo } from './apk-info.ts';
import type { BridgeDevice, InstallFlag, InstalledPackage } from '../../bridge/protocol.ts';

export type CheckSeverity = 'blocked' | 'warning' | 'note';

export interface DeviceCheck {
  id: string;
  severity: CheckSeverity;
  message: string;
  /** Bandera que resuelve el hallazgo, para ofrecer la corrección de un clic. */
  flag?: InstallFlag;
  flagLabel?: string;
}

/** Versión de Android por nivel de API, para hablar en el idioma del usuario. */
const ANDROID_RELEASE: Record<number, string> = {
  21: '5.0',
  22: '5.1',
  23: '6.0',
  24: '7.0',
  25: '7.1',
  26: '8.0',
  27: '8.1',
  28: '9',
  29: '10',
  30: '11',
  31: '12',
  32: '12L',
  33: '13',
  34: '14',
  35: '15',
  36: '16',
};

function releaseFor(sdk: number): string {
  return ANDROID_RELEASE[sdk] ? `Android ${ANDROID_RELEASE[sdk]}` : `API ${sdk}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const STATE_PROBLEM: Record<string, string> = {
  unauthorized:
    'El dispositivo no ha autorizado a este ordenador. Desbloquéalo y acepta el aviso de depuración USB; marca «Permitir siempre» si no quieres repetirlo.',
  offline:
    'adb ve el dispositivo pero no responde. Suele arreglarse desconectando y volviendo a conectar, o con «adb kill-server».',
  recovery: 'El dispositivo está en modo recovery y no puede instalar aplicaciones.',
  bootloader: 'El dispositivo está en el bootloader. Arráncalo en el sistema para poder instalar.',
  sideload: 'El dispositivo está en modo sideload, que solo acepta paquetes de actualización.',
};

export function checkDevice(
  apk: ApkInfo,
  device: BridgeDevice,
  installed: InstalledPackage | null,
): DeviceCheck[] {
  const checks: DeviceCheck[] = [];

  if (device.state !== 'device') {
    checks.push({
      id: 'state',
      severity: 'blocked',
      message: STATE_PROBLEM[device.state] ?? `El dispositivo está en estado «${device.state}».`,
    });
    // Sin sesión con el aparato no se puede afirmar nada más sobre él.
    return checks;
  }

  if (apk.isSplit) {
    checks.push({
      id: 'split',
      severity: 'blocked',
      message:
        'Este APK es una parte de un bundle partido. Un split suelto no se instala con adb install; genera un APK universal.',
    });
  }

  const sdk = device.details?.sdk ?? null;
  if (apk.minSdk !== null && sdk !== null && apk.minSdk > sdk) {
    checks.push({
      id: 'min-sdk',
      severity: 'blocked',
      message: `El APK pide ${releaseFor(apk.minSdk)} como mínimo y este dispositivo tiene ${releaseFor(sdk)}. No hay bandera que lo salve.`,
    });
  }

  const deviceAbis = device.details?.abis ?? [];
  if (apk.abis.length > 0 && deviceAbis.length > 0) {
    const shared = apk.abis.filter((abi) => deviceAbis.includes(abi));
    if (shared.length === 0) {
      checks.push({
        id: 'abi',
        severity: 'blocked',
        message: `El APK trae código nativo para ${apk.abis.join(', ')} y el dispositivo es ${deviceAbis.join(', ')}. Necesitas otro build.`,
      });
    }
  }

  if (device.freeSpace !== null) {
    // La instalación necesita sitio para el APK y para lo que Android extrae de él.
    const needed = apk.size * 1.5;
    if (needed > device.freeSpace) {
      checks.push({
        id: 'space',
        severity: 'blocked',
        message: `Quedan ${formatBytes(device.freeSpace)} libres y la instalación necesita alrededor de ${formatBytes(needed)}.`,
      });
    } else if (apk.size * 3 > device.freeSpace) {
      checks.push({
        id: 'space-tight',
        severity: 'warning',
        message: `Solo quedan ${formatBytes(device.freeSpace)} libres. Entra, pero con poco margen.`,
      });
    }
  }

  if (installed) {
    if (
      installed.versionCode !== null &&
      apk.versionCode !== null &&
      installed.versionCode > apk.versionCode
    ) {
      checks.push({
        id: 'downgrade',
        severity: 'warning',
        message: `El dispositivo tiene la versión ${installed.versionName ?? installed.versionCode} y vas a poner la ${apk.versionName ?? apk.versionCode}. Bajar de versión borra los datos de la app.`,
        flag: 'downgrade',
        flagLabel: 'Permitir bajar de versión',
      });
    } else {
      checks.push({
        id: 'installed',
        severity: 'note',
        message: `Ya está instalada la versión ${installed.versionName ?? installed.versionCode ?? 'desconocida'}. Se reinstalará encima conservando los datos.`,
      });
    }
  }

  if (device.transport === 'tcp') {
    checks.push({
      id: 'wireless',
      severity: 'note',
      message: 'Va por red: la transferencia es más lenta y sensible a cortes de wifi.',
    });
  }

  return checks;
}

export function worstSeverity(checks: DeviceCheck[]): CheckSeverity | null {
  if (checks.some((check) => check.severity === 'blocked')) return 'blocked';
  if (checks.some((check) => check.severity === 'warning')) return 'warning';
  if (checks.length > 0) return 'note';
  return null;
}

export function isBlocked(checks: DeviceCheck[]): boolean {
  return checks.some((check) => check.severity === 'blocked');
}

/** Avisos sobre el APK en sí, independientes del dispositivo. */
export function checkApk(apk: ApkInfo): DeviceCheck[] {
  const checks: DeviceCheck[] = [];
  if (apk.debuggable) {
    checks.push({
      id: 'debuggable',
      severity: 'note',
      message: 'Es un build de depuración. Correcto para probar, no para publicar.',
    });
  }
  if (apk.packageName === null) {
    checks.push({
      id: 'no-package',
      severity: 'warning',
      message:
        'No se pudo leer el nombre del paquete del manifiesto. La instalación puede funcionar igual, pero no puedo comprobar qué versión hay en el dispositivo.',
    });
  }
  return checks;
}
