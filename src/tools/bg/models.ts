/**
 * Los modelos que ofrece la herramienta.
 *
 * La licencia va en la ficha, no escondida: este repositorio es MIT y hay modelos
 * excelentes que **no** se pueden usar comercialmente. Que el usuario lo sepa antes
 * de recortar el catálogo de un cliente es parte del trabajo, no letra pequeña.
 *
 * Los tamaños son del peso que se descarga la primera vez. Después queda en la
 * caché del navegador y no se vuelve a pedir.
 */

export type ModelLicense = 'permisiva' | 'no-comercial';

export interface BgModel {
  id: string;
  name: string;
  /** Para qué es bueno, en una línea. */
  blurb: string;
  /** MB aproximados de la descarga inicial. */
  size: number;
  license: ModelLicense;
  licenseName: string;
  /** Precisión con la que se carga; fp16 va en WebGPU, q8 en CPU. */
  dtype: 'fp32' | 'fp16' | 'q8';
}

export const MODELS: readonly BgModel[] = [
  {
    id: 'onnx-community/mediapipe_selfie_segmentation',
    name: 'Selfie rápido',
    blurb: 'Diminuto e instantáneo. Personas de medio cuerpo, fondos simples.',
    size: 1,
    license: 'permisiva',
    licenseName: 'Apache-2.0',
    dtype: 'fp32',
  },
  {
    id: 'Xenova/modnet',
    name: 'MODNet retrato',
    blurb: 'Matting de retrato: respeta el pelo mucho mejor que un recorte duro.',
    size: 25,
    license: 'permisiva',
    licenseName: 'Apache-2.0',
    dtype: 'fp32',
  },
  {
    id: 'onnx-community/BiRefNet_lite',
    name: 'BiRefNet lite',
    blurb: 'Objetos cualesquiera, no solo personas. El mejor borde de la lista.',
    size: 220,
    license: 'permisiva',
    licenseName: 'MIT',
    dtype: 'fp16',
  },
  {
    id: 'briaai/RMBG-1.4',
    name: 'RMBG 1.4',
    blurb: 'Muy bueno en producto y objetos sueltos. Uso no comercial.',
    size: 176,
    license: 'no-comercial',
    licenseName: 'CC BY-NC 4.0',
    dtype: 'fp32',
  },
];

export const DEFAULT_MODEL = MODELS[1]!.id;

export function findModel(id: string): BgModel {
  return MODELS.find((model) => model.id === id) ?? MODELS[1]!;
}
