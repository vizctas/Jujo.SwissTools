/*
 * Los nueve tipos de contenido. Cada uno define sus campos, cómo se serializa a la
 * cadena que se codifica, y qué es un valor inválido.
 *
 * La serialización es la parte que la gente se salta: un SSID con punto y coma o un
 * nombre con acento rompen el QR de formas que no se ven hasta que alguien escanea.
 */

export type ContentTypeId =
  | 'url'
  | 'text'
  | 'wifi'
  | 'vcard'
  | 'email'
  | 'phone'
  | 'sms'
  | 'event'
  | 'geo';

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'password'
  | 'select'
  | 'date'
  | 'time'
  | 'checkbox';

export interface FieldDef {
  name: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** Fracción de fila que ocupa el campo en la rejilla de la barra de contenido. */
  width?: 'full' | 'half' | 'third';
  inputMode?: 'text' | 'url' | 'email' | 'tel' | 'numeric' | 'decimal';
}

export type FieldValues = Record<string, string>;

export interface ContentType {
  id: ContentTypeId;
  label: string;
  /** Una línea sobre para qué sirve; se muestra en la paleta y como pista. */
  blurb: string;
  fields: readonly FieldDef[];
  encode(values: FieldValues): string;
  validate(values: FieldValues): Record<string, string>;
  /** Resumen de una línea para cuando la barra se compacta. */
  summarize(values: FieldValues): string;
}

const get = (values: FieldValues, name: string): string => (values[name] ?? '').trim();

/** Escapa los caracteres que rompen el formato WIFI:. */
function escapeWifi(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1');
}

/** Escapa según RFC 6350 para vCard/iCalendar. */
function escapeIcal(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireFields(
  values: FieldValues,
  fields: readonly FieldDef[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.required && get(values, field.name) === '') {
      errors[field.name] = 'Obligatorio.';
    }
  }
  return errors;
}

/** `YYYY-MM-DD` + `HH:MM` → formato iCalendar en hora local flotante. */
function icalStamp(date: string, time: string): string {
  const compactDate = date.replace(/-/g, '');
  if (time === '') return compactDate;
  return `${compactDate}T${time.replace(':', '')}00`;
}

const url: ContentType = {
  id: 'url',
  label: 'Enlace',
  blurb: 'Una dirección web.',
  fields: [
    {
      name: 'url',
      label: 'Dirección',
      kind: 'text',
      placeholder: 'ejemplo.com/menu',
      required: true,
      width: 'full',
      inputMode: 'url',
      hint: 'Sin esquema se asume https://',
    },
  ],
  encode: (values) => {
    const raw = get(values, 'url');
    if (raw === '') return '';
    return /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  },
  validate: (values) => {
    const errors = requireFields(values, url.fields);
    const raw = get(values, 'url');
    if (raw !== '' && /\s/.test(raw)) {
      errors['url'] = 'Una dirección no lleva espacios.';
    }
    return errors;
  },
  summarize: (values) => get(values, 'url') || 'Sin dirección',
};

const text: ContentType = {
  id: 'text',
  label: 'Texto',
  blurb: 'Texto plano, tal cual.',
  fields: [
    {
      name: 'text',
      label: 'Texto',
      kind: 'textarea',
      placeholder: 'Lo que quieras que aparezca al escanear',
      required: true,
      width: 'full',
    },
  ],
  encode: (values) => values['text'] ?? '',
  validate: (values) => requireFields(values, text.fields),
  summarize: (values) => {
    const raw = get(values, 'text');
    if (raw === '') return 'Sin texto';
    return raw.length > 48 ? `${raw.slice(0, 48)}…` : raw;
  },
};

const wifi: ContentType = {
  id: 'wifi',
  label: 'WiFi',
  blurb: 'Conecta a una red sin dictar la clave.',
  fields: [
    { name: 'ssid', label: 'Nombre de red (SSID)', kind: 'text', required: true, width: 'half' },
    {
      name: 'security',
      label: 'Cifrado',
      kind: 'select',
      width: 'third',
      options: [
        { value: 'WPA', label: 'WPA / WPA2 / WPA3' },
        { value: 'WEP', label: 'WEP' },
        { value: 'nopass', label: 'Abierta' },
      ],
    },
    { name: 'password', label: 'Clave', kind: 'password', width: 'half' },
    {
      name: 'hidden',
      label: 'Red oculta',
      kind: 'checkbox',
      width: 'third',
      hint: 'Marca solo si la red no difunde su nombre.',
    },
  ],
  encode: (values) => {
    const ssid = get(values, 'ssid');
    if (ssid === '') return '';
    const security = get(values, 'security') || 'WPA';
    const password = values['password'] ?? '';
    const hidden = get(values, 'hidden') === 'true';
    const parts = [`T:${security}`, `S:${escapeWifi(ssid)}`];
    if (security !== 'nopass' && password !== '') parts.push(`P:${escapeWifi(password)}`);
    if (hidden) parts.push('H:true');
    return `WIFI:${parts.join(';')};;`;
  },
  validate: (values) => {
    const errors = requireFields(values, wifi.fields);
    const security = get(values, 'security') || 'WPA';
    if (security !== 'nopass' && get(values, 'password') === '') {
      errors['password'] = 'Una red cifrada necesita clave.';
    }
    if (security === 'WEP' && get(values, 'password').length > 0) {
      const length = get(values, 'password').length;
      if (![5, 10, 13, 26].includes(length)) {
        errors['password'] = 'Una clave WEP tiene 5, 10, 13 o 26 caracteres.';
      }
    }
    return errors;
  },
  summarize: (values) => get(values, 'ssid') || 'Sin red',
};

const vcard: ContentType = {
  id: 'vcard',
  label: 'Contacto',
  blurb: 'Tarjeta de contacto que se guarda en la agenda.',
  fields: [
    { name: 'firstName', label: 'Nombre', kind: 'text', required: true, width: 'half' },
    { name: 'lastName', label: 'Apellidos', kind: 'text', width: 'half' },
    { name: 'org', label: 'Organización', kind: 'text', width: 'half' },
    { name: 'title', label: 'Cargo', kind: 'text', width: 'half' },
    { name: 'phone', label: 'Teléfono', kind: 'text', width: 'half', inputMode: 'tel' },
    { name: 'email', label: 'Email', kind: 'text', width: 'half', inputMode: 'email' },
    { name: 'url', label: 'Web', kind: 'text', width: 'full', inputMode: 'url' },
    { name: 'street', label: 'Calle', kind: 'text', width: 'full' },
    { name: 'city', label: 'Ciudad', kind: 'text', width: 'third' },
    { name: 'zip', label: 'Código postal', kind: 'text', width: 'third' },
    { name: 'country', label: 'País', kind: 'text', width: 'third' },
    { name: 'note', label: 'Nota', kind: 'textarea', width: 'full' },
  ],
  encode: (values) => {
    const first = get(values, 'firstName');
    const last = get(values, 'lastName');
    if (first === '' && last === '') return '';

    const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
    lines.push(`N:${escapeIcal(last)};${escapeIcal(first)};;;`);
    lines.push(`FN:${escapeIcal([first, last].filter(Boolean).join(' '))}`);

    const simple: ReadonlyArray<[string, string]> = [
      ['ORG', get(values, 'org')],
      ['TITLE', get(values, 'title')],
      ['URL', get(values, 'url')],
      ['NOTE', get(values, 'note')],
    ];
    for (const [key, value] of simple) {
      if (value !== '') lines.push(`${key}:${escapeIcal(value)}`);
    }
    if (get(values, 'phone') !== '') {
      lines.push(`TEL;TYPE=CELL:${escapeIcal(get(values, 'phone'))}`);
    }
    if (get(values, 'email') !== '') {
      lines.push(`EMAIL;TYPE=INTERNET:${escapeIcal(get(values, 'email'))}`);
    }
    const address = [
      get(values, 'street'),
      get(values, 'city'),
      get(values, 'zip'),
      get(values, 'country'),
    ];
    if (address.some((part) => part !== '')) {
      const [street, city, zip, country] = address.map(escapeIcal);
      lines.push(`ADR;TYPE=WORK:;;${street};${city};;${zip};${country}`);
    }
    lines.push('END:VCARD');
    return lines.join('\r\n');
  },
  validate: (values) => {
    const errors = requireFields(values, vcard.fields);
    const email = get(values, 'email');
    if (email !== '' && !EMAIL_RE.test(email)) {
      errors['email'] = 'No parece una dirección de correo.';
    }
    return errors;
  },
  summarize: (values) =>
    [get(values, 'firstName'), get(values, 'lastName')].filter(Boolean).join(' ') ||
    'Sin contacto',
};

const email: ContentType = {
  id: 'email',
  label: 'Email',
  blurb: 'Abre un correo con el destinatario ya puesto.',
  fields: [
    {
      name: 'to',
      label: 'Destinatario',
      kind: 'text',
      required: true,
      width: 'half',
      inputMode: 'email',
    },
    { name: 'subject', label: 'Asunto', kind: 'text', width: 'half' },
    { name: 'body', label: 'Mensaje', kind: 'textarea', width: 'full' },
  ],
  encode: (values) => {
    const to = get(values, 'to');
    if (to === '') return '';
    const params = new URLSearchParams();
    if (get(values, 'subject') !== '') params.set('subject', get(values, 'subject'));
    if (get(values, 'body') !== '') params.set('body', values['body'] ?? '');
    const query = params.toString();
    return `mailto:${to}${query ? `?${query}` : ''}`;
  },
  validate: (values) => {
    const errors = requireFields(values, email.fields);
    const to = get(values, 'to');
    if (to !== '' && !EMAIL_RE.test(to)) {
      errors['to'] = 'No parece una dirección de correo.';
    }
    return errors;
  },
  summarize: (values) => get(values, 'to') || 'Sin destinatario',
};

const phone: ContentType = {
  id: 'phone',
  label: 'Teléfono',
  blurb: 'Marca un número al escanear.',
  fields: [
    {
      name: 'number',
      label: 'Número',
      kind: 'text',
      required: true,
      width: 'half',
      inputMode: 'tel',
      hint: 'Con prefijo internacional viaja mejor: +34…',
    },
  ],
  encode: (values) => {
    const number = get(values, 'number').replace(/[\s()-]/g, '');
    return number === '' ? '' : `tel:${number}`;
  },
  validate: (values) => {
    const errors = requireFields(values, phone.fields);
    const number = get(values, 'number');
    if (number !== '' && !/^\+?[\d\s()-]{4,}$/.test(number)) {
      errors['number'] = 'Solo dígitos, espacios, guiones y un + inicial.';
    }
    return errors;
  },
  summarize: (values) => get(values, 'number') || 'Sin número',
};

const sms: ContentType = {
  id: 'sms',
  label: 'SMS',
  blurb: 'Abre un mensaje con número y texto puestos.',
  fields: [
    {
      name: 'number',
      label: 'Número',
      kind: 'text',
      required: true,
      width: 'half',
      inputMode: 'tel',
    },
    { name: 'message', label: 'Mensaje', kind: 'textarea', width: 'full' },
  ],
  encode: (values) => {
    const number = get(values, 'number').replace(/[\s()-]/g, '');
    if (number === '') return '';
    // SMSTO: lo entienden Android e iOS; `sms:` con body es menos consistente.
    return `SMSTO:${number}:${values['message'] ?? ''}`;
  },
  validate: (values) => requireFields(values, sms.fields),
  summarize: (values) => get(values, 'number') || 'Sin número',
};

const event: ContentType = {
  id: 'event',
  label: 'Evento',
  blurb: 'Añade una cita al calendario.',
  fields: [
    { name: 'summary', label: 'Título', kind: 'text', required: true, width: 'full' },
    { name: 'startDate', label: 'Fecha de inicio', kind: 'date', required: true, width: 'half' },
    { name: 'startTime', label: 'Hora de inicio', kind: 'time', width: 'half' },
    { name: 'endDate', label: 'Fecha de fin', kind: 'date', width: 'half' },
    { name: 'endTime', label: 'Hora de fin', kind: 'time', width: 'half' },
    { name: 'location', label: 'Lugar', kind: 'text', width: 'full' },
    { name: 'description', label: 'Descripción', kind: 'textarea', width: 'full' },
  ],
  encode: (values) => {
    const summary = get(values, 'summary');
    const startDate = get(values, 'startDate');
    if (summary === '' || startDate === '') return '';

    const startTime = get(values, 'startTime');
    const endDate = get(values, 'endDate') || startDate;
    const endTime = get(values, 'endTime');
    const allDay = startTime === '' && endTime === '';

    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT'];
    lines.push(`SUMMARY:${escapeIcal(summary)}`);
    if (allDay) {
      lines.push(`DTSTART;VALUE=DATE:${icalStamp(startDate, '')}`);
      lines.push(`DTEND;VALUE=DATE:${icalStamp(endDate, '')}`);
    } else {
      // Hora local flotante a propósito: sin zona horaria el evento cae a la hora
      // del reloj de quien escanea, que es lo que se espera de un cartel.
      lines.push(`DTSTART:${icalStamp(startDate, startTime || '00:00')}`);
      lines.push(`DTEND:${icalStamp(endDate, endTime || startTime || '00:00')}`);
    }
    if (get(values, 'location') !== '') {
      lines.push(`LOCATION:${escapeIcal(get(values, 'location'))}`);
    }
    if (get(values, 'description') !== '') {
      lines.push(`DESCRIPTION:${escapeIcal(get(values, 'description'))}`);
    }
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.join('\r\n');
  },
  validate: (values) => {
    const errors = requireFields(values, event.fields);
    const startDate = get(values, 'startDate');
    const endDate = get(values, 'endDate');
    if (startDate !== '' && endDate !== '' && endDate < startDate) {
      errors['endDate'] = 'El fin no puede ser anterior al inicio.';
    }
    return errors;
  },
  summarize: (values) => get(values, 'summary') || 'Sin evento',
};

const geo: ContentType = {
  id: 'geo',
  label: 'Ubicación',
  blurb: 'Abre unas coordenadas en el mapa.',
  fields: [
    {
      name: 'lat',
      label: 'Latitud',
      kind: 'text',
      required: true,
      width: 'half',
      inputMode: 'decimal',
      hint: 'En cualquier mapa: clic derecho sobre el punto copia las dos.',
    },
    {
      name: 'lon',
      label: 'Longitud',
      kind: 'text',
      required: true,
      width: 'half',
      inputMode: 'decimal',
    },
  ],
  encode: (values) => {
    const lat = get(values, 'lat');
    const lon = get(values, 'lon');
    return lat === '' || lon === '' ? '' : `geo:${lat},${lon}`;
  },
  validate: (values) => {
    const errors = requireFields(values, geo.fields);
    const lat = Number(get(values, 'lat'));
    const lon = Number(get(values, 'lon'));
    if (get(values, 'lat') !== '' && (Number.isNaN(lat) || lat < -90 || lat > 90)) {
      errors['lat'] = 'La latitud va de -90 a 90.';
    }
    if (get(values, 'lon') !== '' && (Number.isNaN(lon) || lon < -180 || lon > 180)) {
      errors['lon'] = 'La longitud va de -180 a 180.';
    }
    return errors;
  },
  summarize: (values) =>
    get(values, 'lat') && get(values, 'lon')
      ? `${get(values, 'lat')}, ${get(values, 'lon')}`
      : 'Sin coordenadas',
};

export const CONTENT_TYPES: readonly ContentType[] = [
  url,
  text,
  wifi,
  vcard,
  email,
  phone,
  sms,
  event,
  geo,
];

export function contentType(id: ContentTypeId): ContentType {
  return CONTENT_TYPES.find((type) => type.id === id) ?? url;
}

/** Valores iniciales de un tipo: todo vacío salvo los select, que toman su primera opción. */
export function initialValues(id: ContentTypeId): FieldValues {
  const values: FieldValues = {};
  for (const field of contentType(id).fields) {
    values[field.name] =
      field.kind === 'select' ? (field.options?.[0]?.value ?? '') : field.kind === 'checkbox' ? 'false' : '';
  }
  return values;
}
