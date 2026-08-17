export type ErrorLevel = 'L' | 'M' | 'Q' | 'H';

export type ModuleShape = 'square' | 'rounded' | 'dot' | 'diamond' | 'connected';
export type EyeFrameShape = 'square' | 'rounded' | 'circle' | 'leaf';
export type EyeBallShape = 'square' | 'rounded' | 'circle' | 'diamond';
export type CaptionFont = 'ui' | 'serif' | 'value';

export interface LogoAsset {
  /** data: URI. Se guarda embebido para que la pieza sea autocontenida. */
  dataUri: string;
  name: string;
}

export interface QrDesign {
  moduleShape: ModuleShape;
  /** 0.55–1: tamaño del módulo dentro de su celda. No aplica a `connected`. */
  moduleScale: number;
  moduleColor: string;
  eyeFrame: EyeFrameShape;
  eyeBall: EyeBallShape;
  /** Cuando es false, los ojos heredan el color de los módulos. */
  eyeCustomColor: boolean;
  eyeFrameColor: string;
  eyeBallColor: string;
  bgColor: string;
  bgTransparent: boolean;
  /** En módulos. La norma pide 4; menos es un aviso. */
  quietZone: number;
  errorLevel: ErrorLevel;
  logo: LogoAsset | null;
  /** Ancho del logo como fracción del ancho del QR. */
  logoScale: number;
  /** Margen alrededor del logo, en módulos. */
  logoPadding: number;
  /** Borra los módulos bajo el centro en vez de taparlos. */
  logoPunchout: boolean;
  /** Radio de esquina de la placa central, en % de su lado corto. */
  logoRadius: number;
  /**
   * Texto en el centro del código. Es la alternativa al logo: solo se dibuja
   * cuando no hay logo, porque los dos ocupan la misma ranura.
   */
  centerText: string;
  centerTextFont: CaptionFont;
  /** Altura tipográfica del texto central, en módulos. */
  centerTextSize: number;
  centerTextColor: string;
  caption: string;
  subcaption: string;
  captionFont: CaptionFont;
  /** Altura tipográfica del texto principal, en módulos. */
  captionSize: number;
  captionColor: string;
  /** Separación entre la zona de silencio y el texto, en módulos. */
  captionGap: number;
}

export const DEFAULT_DESIGN: QrDesign = {
  moduleShape: 'connected',
  moduleScale: 0.92,
  moduleColor: '#141a24',
  eyeFrame: 'rounded',
  eyeBall: 'rounded',
  eyeCustomColor: false,
  eyeFrameColor: '#141a24',
  eyeBallColor: '#141a24',
  bgColor: '#ffffff',
  bgTransparent: false,
  quietZone: 4,
  errorLevel: 'Q',
  logo: null,
  logoScale: 0.2,
  logoPadding: 1,
  logoPunchout: true,
  logoRadius: 20,
  centerText: '',
  centerTextFont: 'ui',
  centerTextSize: 4,
  centerTextColor: '#141a24',
  caption: '',
  subcaption: '',
  captionFont: 'ui',
  captionSize: 3,
  captionColor: '#141a24',
  captionGap: 1.5,
};

/** Matriz de módulos ya codificada. `get` devuelve true si el módulo es oscuro. */
export interface Matrix {
  size: number;
  get(row: number, col: number): boolean;
}
