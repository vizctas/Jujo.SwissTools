/*
 * El taller. Panel permanente a la derecha, altura completa.
 *
 * "Los controles son el producto": nada vive detrás de un menú o un acordeón.
 * Los grupos hacen la jerarquía; el scroll hace el resto.
 */

import { useRef, useState, type ReactNode } from 'react';
import { capacityFor } from '../lib/qr.ts';
import type {
  CaptionFont,
  ErrorLevel,
  EyeBallShape,
  EyeFrameShape,
  ModuleShape,
  QrDesign,
} from '../lib/types.ts';
import { useStore } from '../state/store.tsx';
import {
  Button,
  ColorField,
  Group,
  NumberSlider,
  Row,
  Segmented,
  Toggle,
  type SegmentOption,
} from './controls.tsx';
import { TrashIcon, UploadIcon } from './Icons.tsx';

/* Glifos: el control muestra la forma, no la palabra. */

function Glyph({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      {children}
    </svg>
  );
}

const MODULE_OPTIONS: ReadonlyArray<SegmentOption<ModuleShape>> = [
  {
    value: 'square',
    label: 'Cuadrado',
    glyph: (
      <Glyph>
        <rect x="3" y="3" width="6" height="6" />
        <rect x="11" y="3" width="6" height="6" />
        <rect x="3" y="11" width="6" height="6" />
      </Glyph>
    ),
  },
  {
    value: 'rounded',
    label: 'Redondeado',
    glyph: (
      <Glyph>
        <rect x="3" y="3" width="6" height="6" rx="1.8" />
        <rect x="11" y="3" width="6" height="6" rx="1.8" />
        <rect x="3" y="11" width="6" height="6" rx="1.8" />
      </Glyph>
    ),
  },
  {
    value: 'dot',
    label: 'Punto',
    glyph: (
      <Glyph>
        <circle cx="6" cy="6" r="3" />
        <circle cx="14" cy="6" r="3" />
        <circle cx="6" cy="14" r="3" />
      </Glyph>
    ),
  },
  {
    value: 'diamond',
    label: 'Rombo',
    glyph: (
      <Glyph>
        <path d="M6 3l3 3-3 3-3-3z" />
        <path d="M14 3l3 3-3 3-3-3z" />
        <path d="M6 11l3 3-3 3-3-3z" />
      </Glyph>
    ),
  },
  {
    value: 'connected',
    label: 'Continuo',
    glyph: (
      <Glyph>
        <path d="M3 4.8A1.8 1.8 0 0 1 4.8 3h10.4A1.8 1.8 0 0 1 17 4.8V7.2A1.8 1.8 0 0 1 15.2 9H9v6.2A1.8 1.8 0 0 1 7.2 17H4.8A1.8 1.8 0 0 1 3 15.2z" />
      </Glyph>
    ),
  },
];

const EYE_FRAME_OPTIONS: ReadonlyArray<SegmentOption<EyeFrameShape>> = [
  {
    value: 'square',
    label: 'Cuadrado',
    glyph: (
      <Glyph>
        <path fillRule="evenodd" d="M2 2h16v16H2zM5 5v10h10V5z" />
      </Glyph>
    ),
  },
  {
    value: 'rounded',
    label: 'Redondeado',
    glyph: (
      <Glyph>
        <path fillRule="evenodd" d="M2 6a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4zm3 .5A1.5 1.5 0 0 1 6.5 5h7A1.5 1.5 0 0 1 15 6.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 5 13.5z" />
      </Glyph>
    ),
  },
  {
    value: 'circle',
    label: 'Círculo',
    glyph: (
      <Glyph>
        <path fillRule="evenodd" d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10z" />
      </Glyph>
    ),
  },
  {
    value: 'leaf',
    label: 'Hoja',
    glyph: (
      <Glyph>
        <path fillRule="evenodd" d="M8 2h10v10a6 6 0 0 1-6 6H2V8a6 6 0 0 1 6-6zm.6 3A3.6 3.6 0 0 0 5 8.6V15h6.4a3.6 3.6 0 0 0 3.6-3.6V5z" />
      </Glyph>
    ),
  },
];

const EYE_BALL_OPTIONS: ReadonlyArray<SegmentOption<EyeBallShape>> = [
  {
    value: 'square',
    label: 'Cuadrado',
    glyph: (
      <Glyph>
        <rect x="4" y="4" width="12" height="12" />
      </Glyph>
    ),
  },
  {
    value: 'rounded',
    label: 'Redondeado',
    glyph: (
      <Glyph>
        <rect x="4" y="4" width="12" height="12" rx="3.6" />
      </Glyph>
    ),
  },
  {
    value: 'circle',
    label: 'Círculo',
    glyph: (
      <Glyph>
        <circle cx="10" cy="10" r="6" />
      </Glyph>
    ),
  },
  {
    value: 'diamond',
    label: 'Rombo',
    glyph: (
      <Glyph>
        <path d="M10 3l7 7-7 7-7-7z" />
      </Glyph>
    ),
  },
];

const CAPTION_FONT_OPTIONS: ReadonlyArray<SegmentOption<CaptionFont>> = [
  { value: 'ui', label: 'Sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'value', label: 'Mono' },
];

const LEVEL_OPTIONS: ReadonlyArray<SegmentOption<ErrorLevel>> = [
  { value: 'L', label: 'L' },
  { value: 'M', label: 'M' },
  { value: 'Q', label: 'Q' },
  { value: 'H', label: 'H' },
];

const LEVEL_BLURB: Record<ErrorLevel, string> = {
  L: 'Recupera hasta el 7% del código dañado. El más denso, el menos tolerante.',
  M: 'Recupera hasta el 15%. Buen término medio para pantalla.',
  Q: 'Recupera hasta el 25%. El mínimo razonable si hay logo o va impreso.',
  H: 'Recupera hasta el 30%. Obligado con logos grandes; agranda el código.',
};

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export function PropertiesPanel(): ReactNode {
  const { state, dispatch, derived } = useStore();
  const design = state.design;
  const patch = (value: Partial<QrDesign>): void =>
    dispatch({ type: 'patch-design', patch: value });

  const fileInput = useRef<HTMLInputElement>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  const readLogo = (file: File): void => {
    setLogoError(null);
    if (!/^image\/(png|jpeg|svg\+xml|webp)$/.test(file.type)) {
      setLogoError('Formatos admitidos: SVG, PNG, JPG y WebP.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError(`El archivo pesa ${Math.round(file.size / 1024)} KB y el tope son 2 MB.`);
      return;
    }
    setLogoBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      setLogoBusy(false);
      dispatch({
        type: 'set-logo',
        logo: { dataUri: String(reader.result), name: file.name },
      });
    };
    reader.onerror = () => {
      setLogoBusy(false);
      setLogoError('No se pudo leer el archivo. Prueba con otro.');
    };
    reader.readAsDataURL(file);
  };

  // El centro es una sola ranura: o logo o texto. El logo manda si están los dos.
  const hasCenterText = !design.logo && design.centerText.trim() !== '';
  const centerOccupied = design.logo !== null || hasCenterText;

  const version = derived.result?.version ?? null;
  const capacity = version ? capacityFor(design.errorLevel, version) : 0;
  const used = derived.encoded.length;

  return (
    <div className="panel-scroll">
      <Group title="Módulos">
        <Row label="Forma" wide>
          <Segmented
            label="Forma de los módulos"
            value={design.moduleShape}
            options={MODULE_OPTIONS}
            columns={5}
            onChange={(moduleShape) => patch({ moduleShape })}
          />
        </Row>
        <NumberSlider
          label="Tamaño"
          value={Math.round(design.moduleScale * 100)}
          min={55}
          max={100}
          step={1}
          unit="%"
          disabled={design.moduleShape === 'connected'}
          disabledReason="La forma continua ocupa la celda entera para poder unirse."
          onChange={(percent) => patch({ moduleScale: percent / 100 })}
        />
        <Row label="Color">
          <ColorField
            label="Color de los módulos"
            value={design.moduleColor}
            onChange={(moduleColor) => patch({ moduleColor })}
          />
        </Row>
      </Group>

      <Group title="Ojos">
        <Row label="Marco" wide>
          <Segmented
            label="Forma del marco del ojo"
            value={design.eyeFrame}
            options={EYE_FRAME_OPTIONS}
            columns={4}
            onChange={(eyeFrame) => patch({ eyeFrame })}
          />
        </Row>
        <Row label="Centro" wide>
          <Segmented
            label="Forma del centro del ojo"
            value={design.eyeBall}
            options={EYE_BALL_OPTIONS}
            columns={4}
            onChange={(eyeBall) => patch({ eyeBall })}
          />
        </Row>
        <Toggle
          label="Color propio"
          checked={design.eyeCustomColor}
          hint="Sin esto, los ojos siguen el color de los módulos."
          onChange={(eyeCustomColor) => patch({ eyeCustomColor })}
        />
        {design.eyeCustomColor ? (
          <>
            <Row label="Marco">
              <ColorField
                label="Color del marco"
                value={design.eyeFrameColor}
                onChange={(eyeFrameColor) => patch({ eyeFrameColor })}
              />
            </Row>
            <Row label="Centro">
              <ColorField
                label="Color del centro"
                value={design.eyeBallColor}
                onChange={(eyeBallColor) => patch({ eyeBallColor })}
              />
            </Row>
          </>
        ) : null}
      </Group>

      <Group title="Fondo">
        <Toggle
          label="Transparente"
          checked={design.bgTransparent}
          hint="El PNG sale con canal alfa y el SVG sin rectángulo de fondo."
          onChange={(bgTransparent) => patch({ bgTransparent })}
        />
        <Row label="Color">
          <ColorField
            label="Color de fondo"
            value={design.bgColor}
            disabled={design.bgTransparent}
            onChange={(bgColor) => patch({ bgColor })}
          />
        </Row>
        <NumberSlider
          label="Zona de silencio"
          value={design.quietZone}
          min={0}
          max={10}
          step={1}
          unit="mód."
          onChange={(quietZone) => patch({ quietZone })}
        />
      </Group>

      <Group title="Centro">
        <input
          ref={fileInput}
          type="file"
          accept="image/svg+xml,image/png,image/jpeg,image/webp"
          className="visually-hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) readLogo(file);
            event.target.value = '';
          }}
        />
        {logoBusy ? (
          <div className="logo-slot">
            <span className="skeleton skeleton-logo" />
            <span className="row-hint">Leyendo el archivo…</span>
          </div>
        ) : design.logo ? (
          <div className="logo-slot">
            <img className="logo-thumb" src={design.logo.dataUri} alt="" />
            <span className="logo-name" title={design.logo.name}>
              {design.logo.name}
            </span>
            <Button
              variant="ghost"
              aria-label="Quitar logo"
              title="Quitar logo"
              onClick={() => dispatch({ type: 'set-logo', logo: null })}
            >
              <TrashIcon />
            </Button>
          </div>
        ) : (
          <>
            <Button variant="default" onClick={() => fileInput.current?.click()}>
              <UploadIcon />
              Subir logo
            </Button>
            <Row label="O texto" htmlFor="center-text" wide>
              <input
                id="center-text"
                className="text-input"
                value={design.centerText}
                maxLength={16}
                placeholder="MENÚ"
                autoComplete="off"
                onChange={(event) => patch({ centerText: event.target.value })}
              />
            </Row>
            <p className="row-hint">
              Va en el hueco del logo, así que cuenta igual contra la corrección de
              errores. Dos o tres letras aguantan mejor que una palabra larga.
            </p>
          </>
        )}
        {logoError ? (
          <p className="row-error" role="alert">
            {logoError}
          </p>
        ) : null}

        {design.logo ? (
          <>
            <NumberSlider
              label="Tamaño"
              value={Math.round(design.logoScale * 100)}
              min={8}
              max={45}
              step={1}
              unit="%"
              onChange={(percent) => patch({ logoScale: percent / 100 })}
            />
            {design.centerText.trim() !== '' ? (
              <p className="row-hint">
                El logo ocupa el centro. Tu texto «{design.centerText.trim()}» sigue
                guardado y vuelve en cuanto lo quites.
              </p>
            ) : null}
          </>
        ) : null}

        {hasCenterText ? (
          <>
            <Row label="Tipografía" wide>
              <Segmented
                label="Tipografía del texto central"
                value={design.centerTextFont}
                options={CAPTION_FONT_OPTIONS}
                columns={3}
                onChange={(centerTextFont) => patch({ centerTextFont })}
              />
            </Row>
            <NumberSlider
              label="Tamaño"
              value={design.centerTextSize}
              min={1.5}
              max={10}
              step={0.25}
              decimals={2}
              unit="mód."
              onChange={(centerTextSize) => patch({ centerTextSize })}
            />
            <Row label="Color">
              <ColorField
                label="Color del texto central"
                value={design.centerTextColor}
                onChange={(centerTextColor) => patch({ centerTextColor })}
              />
            </Row>
          </>
        ) : null}

        {centerOccupied ? (
          <>
            <NumberSlider
              label="Margen"
              value={design.logoPadding}
              min={0}
              max={4}
              step={0.5}
              decimals={1}
              unit="mód."
              onChange={(logoPadding) => patch({ logoPadding })}
            />
            <NumberSlider
              label="Redondeo"
              value={design.logoRadius}
              min={0}
              max={50}
              step={1}
              unit="%"
              onChange={(logoRadius) => patch({ logoRadius })}
            />
            <Toggle
              label="Recortar módulos"
              checked={design.logoPunchout}
              hint="Borra los módulos del centro en vez de taparlos. Casi siempre lo correcto."
              onChange={(logoPunchout) => patch({ logoPunchout })}
            />
          </>
        ) : null}
      </Group>

      <Group title="Texto">
        <Row label="Título" htmlFor="caption" wide>
          <input
            id="caption"
            className="text-input"
            value={design.caption}
            maxLength={80}
            placeholder="Escanéame"
            onChange={(event) => patch({ caption: event.target.value })}
          />
        </Row>
        <Row label="Subtítulo" htmlFor="subcaption" wide>
          <input
            id="subcaption"
            className="text-input"
            value={design.subcaption}
            maxLength={120}
            placeholder="Carta del día"
            onChange={(event) => patch({ subcaption: event.target.value })}
          />
        </Row>
        {design.caption || design.subcaption ? (
          <>
            <Row label="Tipografía" wide>
              <Segmented
                label="Tipografía del texto"
                value={design.captionFont}
                options={CAPTION_FONT_OPTIONS}
                columns={3}
                onChange={(captionFont) => patch({ captionFont })}
              />
            </Row>
            <NumberSlider
              label="Tamaño"
              value={design.captionSize}
              min={1.5}
              max={8}
              step={0.25}
              decimals={2}
              unit="mód."
              onChange={(captionSize) => patch({ captionSize })}
            />
            <NumberSlider
              label="Separación"
              value={design.captionGap}
              min={0}
              max={6}
              step={0.25}
              decimals={2}
              unit="mód."
              onChange={(captionGap) => patch({ captionGap })}
            />
            <Row label="Color">
              <ColorField
                label="Color del texto"
                value={design.captionColor}
                onChange={(captionColor) => patch({ captionColor })}
              />
            </Row>
          </>
        ) : null}
      </Group>

      <Group title="Corrección de errores">
        <Row label="Nivel" wide>
          <Segmented
            label="Nivel de corrección de errores"
            value={design.errorLevel}
            options={LEVEL_OPTIONS}
            columns={4}
            onChange={(errorLevel) => patch({ errorLevel })}
          />
        </Row>
        <p className="row-hint">{LEVEL_BLURB[design.errorLevel]}</p>
        {version ? (
          <dl className="readout">
            <div>
              <dt>Versión</dt>
              <dd className="value">{version}</dd>
            </div>
            <div>
              <dt>Módulos</dt>
              <dd className="value">
                {derived.result?.matrix.size}×{derived.result?.matrix.size}
              </dd>
            </div>
            <div>
              <dt>Capacidad</dt>
              <dd className="value">
                {used}/{capacity}
              </dd>
            </div>
          </dl>
        ) : null}
      </Group>
    </div>
  );
}
