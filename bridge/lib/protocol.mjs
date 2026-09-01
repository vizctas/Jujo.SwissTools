/**
 * Contrato entre el puente y la app.
 *
 * Vive aquí y se copia a la app en `src/tools/apk/protocol.ts`. Son dos programas
 * distintos que se despliegan por separado: compartir el archivo obligaría a que
 * la web dependiera del paquete del puente, y entonces actualizar uno rompería el
 * otro sin avisar. La versión del protocolo es lo que los mantiene honestos.
 */

/** Se sube cuando cambia la forma de los mensajes. La app compara y avisa. */
export const PROTOCOL_VERSION = 1;

export const CANCELLED = 'CANCELLED';

/**
 * Fallos de instalación traducidos.
 *
 * Cada uno dice qué pasó, por qué, y qué hacer. `flag` es la bandera de adb que lo
 * arregla, si la hay: es lo que permite ofrecer un reintento de un clic en lugar de
 * pegarle al usuario la salida cruda de adb.
 */
export const INSTALL_FAILURES = [
  {
    match: /INSTALL_FAILED_ALREADY_EXISTS/,
    code: 'ALREADY_EXISTS',
    message: 'La app ya está instalada. Reinstalar encima conserva los datos.',
    flag: 'reinstall',
    flagLabel: 'Reinstalar encima',
  },
  {
    match: /INSTALL_FAILED_VERSION_DOWNGRADE|INSTALL_FAILED_VERSION_DOWNGRADE/,
    code: 'DOWNGRADE',
    message:
      'El dispositivo tiene una versión más nueva. Bajar de versión borra los datos de la app.',
    flag: 'downgrade',
    flagLabel: 'Permitir bajar de versión',
  },
  {
    match: /INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match|INCONSISTENT_CERTIFICATES/,
    code: 'SIGNATURE',
    message:
      'La firma no coincide con la de la app instalada. Hay que desinstalar la existente primero, y eso borra sus datos.',
    flag: 'uninstallFirst',
    flagLabel: 'Desinstalar y volver a instalar',
  },
  {
    match: /INSTALL_FAILED_INSUFFICIENT_STORAGE/,
    code: 'STORAGE',
    message: 'No hay espacio suficiente en el dispositivo. Libera espacio y reintenta.',
  },
  {
    match: /INSTALL_FAILED_NO_MATCHING_ABIS/,
    code: 'ABI',
    message:
      'El APK no trae librerías nativas para la arquitectura de este dispositivo. Necesitas otro build.',
  },
  {
    match: /INSTALL_FAILED_OLDER_SDK/,
    code: 'MIN_SDK',
    message: 'El APK pide una versión de Android más nueva que la del dispositivo.',
  },
  {
    match: /INSTALL_FAILED_TEST_ONLY/,
    code: 'TEST_ONLY',
    message:
      'El APK está marcado como testOnly, que es lo normal en un build de depuración desde el IDE.',
    flag: 'allowTest',
    flagLabel: 'Permitir APK de prueba',
  },
  {
    // Android da este mismo código para un APK sin firmar y para uno cuya firma no
    // cuadra porque el archivo llegó dañado. Afirmar solo lo primero manda al
    // usuario a firmar algo que ya estaba firmado.
    match: /INSTALL_PARSE_FAILED_NO_CERTIFICATES/,
    code: 'UNSIGNED',
    message:
      'Android no pudo verificar la firma. O el APK no está firmado, o el archivo llegó dañado: prueba a volver a generarlo o a cargarlo de nuevo.',
  },
  {
    match: /INSTALL_PARSE_FAILED/,
    code: 'PARSE',
    message: 'Android no pudo leer el APK. Suele ser un archivo truncado o corrupto.',
  },
  {
    match: /INSTALL_FAILED_USER_RESTRICTED/,
    code: 'USER_RESTRICTED',
    message:
      'El dispositivo bloqueó la instalación. En muchos móviles hay que activar «Instalar vía USB» en las opciones de desarrollador.',
  },
  {
    match: /device unauthorized|device still authorizing/,
    code: 'UNAUTHORIZED',
    message:
      'El dispositivo no ha autorizado a este ordenador. Desbloquéalo y acepta el aviso de depuración USB.',
  },
  {
    match: /device offline/,
    code: 'OFFLINE',
    message: 'El dispositivo respondió como desconectado. Reconecta el cable o vuelve a emparejar.',
  },
  {
    match: /no devices\/emulators found|device '.*' not found/,
    code: 'GONE',
    message: 'El dispositivo desapareció durante la instalación.',
  },
  {
    match: /Broken pipe|closed/,
    code: 'BROKEN',
    message: 'Se cortó la conexión con el dispositivo a mitad de la transferencia.',
  },
];

/** Traduce la salida cruda de adb al primer fallo conocido que encaje. */
export function classifyFailure(output) {
  const text = String(output ?? '');
  for (const failure of INSTALL_FAILURES) {
    if (failure.match.test(text)) {
      const { match, ...rest } = failure;
      void match;
      return rest;
    }
  }
  return null;
}
