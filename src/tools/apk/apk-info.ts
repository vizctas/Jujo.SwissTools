/*
 * Lee un APK sin salir del navegador.
 *
 * Un APK es un ZIP y su AndroidManifest.xml está en XML binario de Android. Se
 * parsea aquí, en local, por la misma razón que el QR se genera en local: para
 * poder decirte que ese build no va a entrar en ese dispositivo antes de gastar
 * dos minutos subiéndolo.
 *
 * Se leen solo los trozos que hacen falta —directorio central y un único archivo—
 * con File.slice, así que un APK de 300 MB no acaba entero en memoria.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

/** Identificadores de atributo del framework, por si el nombre viene vacío. */
const ATTR = {
  label: 0x01010001,
  debuggable: 0x0101000f,
  minSdkVersion: 0x0101020c,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  targetSdkVersion: 0x01010270,
  compileSdkVersion: 0x01010572,
} as const;

export interface ApkInfo {
  packageName: string | null;
  versionName: string | null;
  versionCode: number | null;
  minSdk: number | null;
  targetSdk: number | null;
  /** Arquitecturas con librerías nativas dentro. Vacío significa que vale para todas. */
  abis: string[];
  label: string | null;
  debuggable: boolean;
  /** Un APK partido por `bundletool` no se instala solo con `adb install`. */
  isSplit: boolean;
  size: number;
  filename: string;
}

export class ApkParseError extends Error {
  readonly kind: 'not-zip' | 'no-manifest' | 'bad-manifest' | 'unsupported';
  constructor(kind: ApkParseError['kind'], message: string) {
    super(message);
    this.name = 'ApkParseError';
    this.kind = kind;
  }
}

async function slice(file: Blob, start: number, end: number): Promise<DataView> {
  const buffer = await file.slice(start, end).arrayBuffer();
  return new DataView(buffer);
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** Directorio central del ZIP. Es donde están los nombres y las posiciones reales. */
async function readCentralDirectory(file: Blob): Promise<ZipEntry[]> {
  const tailSize = Math.min(file.size, 66_000);
  const tail = await slice(file, file.size - tailSize, file.size);

  let eocd = -1;
  for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
    if (tail.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) {
    throw new ApkParseError('not-zip', 'El archivo no es un ZIP válido, así que no es un APK.');
  }

  let count = tail.getUint16(eocd + 10, true);
  let directorySize = tail.getUint32(eocd + 12, true);
  let directoryOffset = tail.getUint32(eocd + 16, true);

  // ZIP64: los APK grandes con muchas entradas lo usan y los campos de 32 bits
  // vienen saturados. Sin esto, un APK de más de 4 GB o 65535 archivos se leería mal.
  if (directoryOffset === 0xffffffff || count === 0xffff) {
    let locator = -1;
    for (let offset = eocd - 20; offset >= 0; offset -= 1) {
      if (tail.getUint32(offset, true) === ZIP64_LOCATOR_SIGNATURE) {
        locator = offset;
        break;
      }
    }
    if (locator === -1) {
      throw new ApkParseError('unsupported', 'El ZIP dice ser ZIP64 pero le falta el localizador.');
    }
    const zip64Start = Number(tail.getBigUint64(locator + 8, true));
    const record = await slice(file, zip64Start, zip64Start + 56);
    count = Number(record.getBigUint64(32, true));
    directorySize = Number(record.getBigUint64(40, true));
    directoryOffset = Number(record.getBigUint64(48, true));
  }

  const directory = await slice(file, directoryOffset, directoryOffset + directorySize);
  const entries: ZipEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < count && cursor + 46 <= directory.byteLength; index += 1) {
    if (directory.getUint32(cursor, true) !== CENTRAL_SIGNATURE) break;
    const nameLength = directory.getUint16(cursor + 28, true);
    const extraLength = directory.getUint16(cursor + 30, true);
    const commentLength = directory.getUint16(cursor + 32, true);
    const name = new TextDecoder().decode(
      new Uint8Array(directory.buffer, directory.byteOffset + cursor + 46, nameLength),
    );
    entries.push({
      name,
      method: directory.getUint16(cursor + 10, true),
      compressedSize: directory.getUint32(cursor + 20, true),
      uncompressedSize: directory.getUint32(cursor + 24, true),
      localOffset: directory.getUint32(cursor + 42, true),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readEntry(file: Blob, entry: ZipEntry): Promise<Uint8Array> {
  const header = await slice(file, entry.localOffset, entry.localOffset + 30);
  if (header.getUint32(0, true) !== LOCAL_SIGNATURE) {
    throw new ApkParseError('bad-manifest', 'La cabecera local del manifiesto no cuadra.');
  }
  const dataStart =
    entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const raw = file.slice(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return new Uint8Array(await raw.arrayBuffer());
  if (entry.method !== 8) {
    throw new ApkParseError('unsupported', `Compresión ZIP no soportada (método ${entry.method}).`);
  }
  // `deflate-raw` es nativo del navegador: nada de librerías de descompresión.
  const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------------------------------- XML binario Android */

interface StringPool {
  get(index: number): string | null;
}

function readStringPool(view: DataView, start: number): StringPool {
  const stringCount = view.getUint32(start + 8, true);
  const flags = view.getUint32(start + 16, true);
  const stringsStart = view.getUint32(start + 20, true);
  const isUtf8 = (flags & (1 << 8)) !== 0;
  const offsets: number[] = [];
  for (let index = 0; index < stringCount; index += 1) {
    offsets.push(view.getUint32(start + 28 + index * 4, true));
  }
  const base = start + stringsStart;
  const cache = new Map<number, string | null>();

  return {
    get(index) {
      if (index < 0 || index >= stringCount) return null;
      if (cache.has(index)) return cache.get(index) ?? null;
      let position = base + offsets[index]!;
      let value: string | null = null;
      try {
        if (isUtf8) {
          // Dos longitudes seguidas: la de UTF-16 y la de bytes. Cada una ocupa uno
          // o dos bytes según el bit alto.
          const skip = (at: number): number =>
            (view.getUint8(at) & 0x80) !== 0 ? at + 2 : at + 1;
          position = skip(position);
          const lengthAt = position;
          const byteLength =
            (view.getUint8(lengthAt) & 0x80) !== 0
              ? ((view.getUint8(lengthAt) & 0x7f) << 8) | view.getUint8(lengthAt + 1)
              : view.getUint8(lengthAt);
          position = skip(lengthAt);
          value = new TextDecoder('utf-8').decode(
            new Uint8Array(view.buffer, view.byteOffset + position, byteLength),
          );
        } else {
          let charLength = view.getUint16(position, true);
          position += 2;
          if ((charLength & 0x8000) !== 0) {
            charLength = ((charLength & 0x7fff) << 16) | view.getUint16(position, true);
            position += 2;
          }
          value = new TextDecoder('utf-16le').decode(
            new Uint8Array(view.buffer, view.byteOffset + position, charLength * 2),
          );
        }
      } catch {
        value = null;
      }
      cache.set(index, value);
      return value;
    },
  };
}

interface ParsedAttribute {
  name: string | null;
  id: number | null;
  value: string | number | boolean | null;
}

/**
 * Recorre el XML binario y devuelve los atributos de los elementos que interesan.
 * No es un parser completo de AXML: no hace falta, y uno completo es una superficie
 * de fallos mucho mayor para leer seis valores.
 */
function parseBinaryXml(bytes: Uint8Array): Map<string, ParsedAttribute[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0x0003) {
    throw new ApkParseError('bad-manifest', 'AndroidManifest.xml no está en XML binario.');
  }

  let cursor = view.getUint32(4, true) > 8 ? view.getUint16(2, true) : 8;
  let pool: StringPool | null = null;
  let resourceMap: number[] = [];
  const elements = new Map<string, ParsedAttribute[]>();

  while (cursor + 8 <= view.byteLength) {
    const type = view.getUint16(cursor, true);
    const size = view.getUint32(cursor + 4, true);
    if (size <= 0 || cursor + size > view.byteLength) break;

    if (type === 0x0001) {
      pool = readStringPool(view, cursor);
    } else if (type === 0x0180) {
      const count = (size - 8) / 4;
      resourceMap = Array.from({ length: count }, (_, index) =>
        view.getUint32(cursor + 8 + index * 4, true),
      );
    } else if (type === 0x0102 && pool) {
      const nameIndex = view.getUint32(cursor + 20, true);
      const name = pool.get(nameIndex) ?? '';
      const attributeStart = view.getUint16(cursor + 24, true);
      const attributeSize = view.getUint16(cursor + 26, true);
      const attributeCount = view.getUint16(cursor + 28, true);

      const attributes: ParsedAttribute[] = [];
      // `attributeStart` cuenta desde el inicio de ResXMLTree_attrExt, que empieza
      // 16 bytes después de la cabecera del chunk. Tomarlo desde el chunk lee 16
      // bytes antes y devuelve atributos vacíos sin dar ningún error.
      const attrExt = cursor + 16;
      for (let index = 0; index < attributeCount; index += 1) {
        const at = attrExt + attributeStart + index * attributeSize;
        if (at + 20 > view.byteLength) break;
        const attrNameIndex = view.getUint32(at + 4, true);
        const rawValueIndex = view.getUint32(at + 8, true);
        const dataType = view.getUint8(at + 15);
        const data = view.getUint32(at + 16, true);

        let value: ParsedAttribute['value'] = null;
        if (dataType === 0x03) value = pool.get(data);
        else if (dataType === 0x12) value = data !== 0;
        else if (dataType === 0x10 || dataType === 0x11) value = data;
        else if (rawValueIndex !== 0xffffffff) value = pool.get(rawValueIndex);

        attributes.push({
          name: pool.get(attrNameIndex) || null,
          // AAPT2 suele dejar el nombre vacío y solo el id; el mapa de recursos
          // es lo que permite reconocerlo igualmente.
          id: resourceMap[attrNameIndex] ?? null,
          value,
        });
      }
      if (!elements.has(name)) elements.set(name, attributes);
    }
    cursor += size;
  }

  if (!elements.has('manifest')) {
    throw new ApkParseError('bad-manifest', 'El manifiesto no tiene elemento <manifest>.');
  }
  return elements;
}

function pick(
  attributes: ParsedAttribute[] | undefined,
  name: string,
  id: number,
): ParsedAttribute['value'] {
  if (!attributes) return null;
  const found =
    attributes.find((attribute) => attribute.name === name) ??
    attributes.find((attribute) => attribute.id === id);
  return found?.value ?? null;
}

export async function readApk(file: File): Promise<ApkInfo> {
  const entries = await readCentralDirectory(file);
  const manifest = entries.find((entry) => entry.name === 'AndroidManifest.xml');
  if (!manifest) {
    throw new ApkParseError(
      'no-manifest',
      'El ZIP no lleva AndroidManifest.xml. Si es un .aab o un .apks, adb no puede instalarlo directamente.',
    );
  }

  const elements = parseBinaryXml(await readEntry(file, manifest));
  const root = elements.get('manifest');
  const usesSdk = elements.get('uses-sdk');
  const application = elements.get('application');

  const abis = [
    ...new Set(
      entries
        .map((entry) => /^lib\/([^/]+)\//.exec(entry.name)?.[1])
        .filter((abi): abi is string => Boolean(abi)),
    ),
  ];

  const packageName = pick(root, 'package', 0);
  const versionCode = pick(root, 'versionCode', ATTR.versionCode);
  const versionName = pick(root, 'versionName', ATTR.versionName);
  const minSdk = pick(usesSdk, 'minSdkVersion', ATTR.minSdkVersion);
  const targetSdk = pick(usesSdk, 'targetSdkVersion', ATTR.targetSdkVersion);
  const label = pick(application, 'label', ATTR.label);
  const debuggable = pick(application, 'debuggable', ATTR.debuggable);

  return {
    packageName: typeof packageName === 'string' ? packageName : null,
    versionName: typeof versionName === 'string' ? versionName : null,
    versionCode: typeof versionCode === 'number' ? versionCode : null,
    minSdk: typeof minSdk === 'number' ? minSdk : null,
    targetSdk: typeof targetSdk === 'number' ? targetSdk : null,
    abis,
    // Una etiqueta que es referencia a recurso llega como número: sin resources.arsc
    // no se puede resolver, y mostrar «2131886081» sería peor que no mostrar nada.
    label: typeof label === 'string' ? label : null,
    debuggable: debuggable === true,
    isSplit: root?.some((attribute) => attribute.name === 'split') ?? false,
    size: file.size,
    filename: file.name,
  };
}
