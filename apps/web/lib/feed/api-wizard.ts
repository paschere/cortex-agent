/**
 * «CONECTAR UNA API», SIN REACT.
 *
 * El asistente de la pestaña API de Feed pide tres cosas —la dirección, la
 * clave y un nombre— y deduce el resto de lo que la API contesta en la prueba:
 * dónde está la lista de registros, si viene por páginas, y cómo se ve como
 * tabla. Todo eso vive aquí, puro, para poder probarlo sin navegador y para
 * que el componente cliente no importe nada de servidor.
 *
 * La detección es una SUGERENCIA: lo que se guarda pasa luego por el mismo
 * camino de siempre (`captureApiFeed`, que valida `recordsPath` y la
 * paginación con sus propios esquemas).
 */

export type ApiAuthChoice = 'none' | 'header' | 'bearer' | 'basic';

export const AUTH_CHOICES: ReadonlyArray<{
  value: ApiAuthChoice;
  label: string;
  help: string;
}> = [
  {
    value: 'none',
    label: 'No, es pública',
    help: 'Cualquiera con la dirección puede leerla. Típico de datos abiertos.',
  },
  {
    value: 'header',
    label: 'Una llave (API key)',
    help: 'Un código largo que el proveedor te dio en su panel, enviado en una cabecera como «X-API-Key».',
  },
  {
    value: 'bearer',
    label: 'Un token (Bearer)',
    help: 'La documentación dice «Authorization: Bearer …». Pega solo el token, sin la palabra Bearer.',
  },
  {
    value: 'basic',
    label: 'Usuario y contraseña',
    help: 'La API pide iniciar sesión con usuario y contraseña (autenticación básica).',
  },
];

// ---------------------------------------------------------------------------
// La dirección
// ---------------------------------------------------------------------------

/** Problema de la dirección pegada, en palabras; `null` si sirve. */
export function urlProblem(raw: string, allowHttp = false): string | null {
  const text = raw.trim();
  if (!text) return 'Pega la dirección de la API.';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'Eso no parece una dirección web. Debe empezar por https://';
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return url.protocol === 'http:'
      ? 'La dirección usa http://, sin cifrar. Usa https:// o actívalo en Opciones avanzadas.'
      : 'La dirección debe empezar por https://';
  }
  if (url.username || url.password) {
    return 'No pongas el usuario o la contraseña dentro de la dirección: usa «¿Necesita clave?».';
  }
  const secretParam = [...url.searchParams.keys()].find((k) =>
    /(^|_|-)(token|secret|password|passwd|api_?key|apikey|access_?key|auth)($|_|-)/i.test(k),
  );
  if (secretParam) {
    return `La dirección lleva «${secretParam}», que parece una clave. Quítala de la dirección y ponla en «¿Necesita clave?» para guardarla cifrada.`;
  }
  if (/\{\{.*\}\}/.test(text)) {
    return 'La dirección tiene {{campos}}. Para eso usa Opciones avanzadas → Administrar conexiones API.';
  }
  return null;
}

function foldAscii(text: string): string {
  return (
    text
      .normalize('NFD')
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: BMP-only combining range
      .replace(/[̀-ͯ]/gu, '')
  );
}

/**
 * Nombre, identificador y descripción para la herramienta que respalda la
 * conexión. `suffix` evita choques de identificador (único por empresa).
 */
export function suggestIdentity(
  rawUrl: string,
  suffix: string,
): { name: string; slug: string; description: string } {
  let host = 'api';
  let path = '';
  try {
    const url = new URL(rawUrl.trim());
    host = url.hostname.replace(/^www\./, '').replace(/^api\./, '');
    path = url.pathname.replace(/\/+$/, '');
  } catch {
    // Se valida aparte; aquí basta con un nombre razonable.
  }
  const last = path.split('/').filter(Boolean).pop() ?? '';
  const name = (last ? `${host} · ${last}` : host).slice(0, 80);
  const base = foldAscii(`feed_${host}_${last}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const tail = foldAscii(suffix)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 6);
  const slug = `${base}_${tail || 'x'}`.replace(/^[^a-z]+/, 'f');
  return {
    name,
    slug,
    description: `Lee los datos de ${host}${path || '/'} para la bandeja de Feed (solo lectura, GET).`,
  };
}

/** La dirección con `param={{param}}` al final, para la paginación por cursor. */
export function withCursorParam(rawUrl: string, param: string): string {
  const url = rawUrl.trim();
  if (new RegExp(`[?&]${param}=`).test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${param}={{${param}}}`;
}

// ---------------------------------------------------------------------------
// Lo que contestó
// ---------------------------------------------------------------------------

/** El cuerpo de la prueba, ya interpretado. `undefined` si no hay nada que leer. */
export function parseTestBody(test: {
  response?: { body: string } | null;
  modelResult?: { data?: unknown };
}): unknown {
  const body = test.response?.body;
  if (typeof body === 'string' && body.trim()) {
    try {
      return JSON.parse(body);
    } catch {
      // No es JSON entero (o vino recortado): lo que el modelo recibió sí es.
    }
  }
  const data = test.modelResult?.data;
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data ?? (typeof body === 'string' && body.trim() ? body : undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isRecordList(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.length > 0 && value.every(isRecord);
}

const SAFE_KEY = /^[a-zA-Z0-9_-]+$/;

export interface DetectedRecords {
  /** Ruta con puntos («data.items»); vacía cuando la lista es la raíz. */
  path: string;
  records: Array<Record<string, unknown>>;
}

/**
 * La lista de registros de la respuesta: la raíz si ya es una lista de
 * objetos; si no, la lista de objetos MÁS LARGA que haya hasta tres niveles
 * adentro (en empate gana la menos profunda, y entre iguales la primera).
 * Sólo considera rutas que `captureApiFeed` acepta (letras, números, _ y -).
 */
export function detectRecords(data: unknown): DetectedRecords | null {
  if (isRecordList(data)) return { path: '', records: data };
  let best: (DetectedRecords & { depth: number }) | null = null;
  const visit = (value: unknown, path: string[], depth: number) => {
    if (depth > 3 || !isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (!SAFE_KEY.test(key)) continue;
      const here = [...path, key];
      if (isRecordList(child)) {
        if (
          !best ||
          child.length > best.records.length ||
          (child.length === best.records.length && depth < best.depth)
        )
          best = { path: here.join('.'), records: child, depth };
      } else if (isRecord(child)) {
        visit(child, here, depth + 1);
      }
    }
  };
  visit(data, [], 1);
  if (!best) return null;
  const { path, records } = best;
  return { path, records };
}

/** Las listas candidatas, para que la persona elija otra si la detectada no es. */
export function listCandidates(data: unknown): Array<{ path: string; count: number }> {
  const out: Array<{ path: string; count: number }> = [];
  if (isRecordList(data)) out.push({ path: '', count: data.length });
  const visit = (value: unknown, path: string[], depth: number) => {
    if (depth > 3 || !isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (!SAFE_KEY.test(key)) continue;
      const here = [...path, key];
      if (isRecordList(child)) out.push({ path: here.join('.'), count: child.length });
      else if (isRecord(child)) visit(child, here, depth + 1);
    }
  };
  visit(data, [], 1);
  return out.sort((a, b) => b.count - a.count);
}

export function valueAt(data: unknown, path: string): unknown {
  let current = data;
  for (const part of path ? path.split('.') : []) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * La vista previa como tabla: encabezados en orden de aparición, objetos
 * anidados aplanados un nivel con punto («cliente.nombre») como lo hace Feed
 * al guardar, y celdas recortadas para que quepan en pantalla.
 */
export function previewTable(
  records: Array<Record<string, unknown>>,
  { maxRows = 6, maxColumns = 8, maxCell = 60 } = {},
): { headers: string[]; rows: string[][]; totalColumns: number; totalRows: number } {
  const flat = records.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (isRecord(value)) {
        for (const [inner, v] of Object.entries(value)) out[`${key}.${inner}`] = v;
      } else out[key] = value;
    }
    return out;
  });
  const headers: string[] = [];
  for (const row of flat)
    for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key);
  const shown = headers.slice(0, maxColumns);
  const clip = (s: string) => (s.length > maxCell ? `${s.slice(0, maxCell - 1)}…` : s);
  return {
    headers: shown,
    rows: flat.slice(0, maxRows).map((row) => shown.map((h) => clip(cellText(row[h])))),
    totalColumns: headers.length,
    totalRows: records.length,
  };
}

// ---------------------------------------------------------------------------
// Páginas
// ---------------------------------------------------------------------------

/** Nombres de cursor que usan las APIs comunes, y el parámetro que lo recibe. */
const CURSOR_KEYS: ReadonlyArray<{ key: string; param: string }> = [
  { key: 'next_cursor', param: 'cursor' },
  { key: 'nextCursor', param: 'cursor' },
  { key: 'next_page_token', param: 'page_token' },
  { key: 'nextPageToken', param: 'pageToken' },
  { key: 'next_token', param: 'next_token' },
  { key: 'nextToken', param: 'nextToken' },
];

export interface DetectedPagination {
  /** Ruta del siguiente cursor en la respuesta («meta.next_cursor»). */
  nextCursorPath: string;
  /** Parámetro sugerido para mandarlo en la siguiente consulta. */
  cursorInput: string;
  /** Ruta de la lista, tal como la pide `collectFeedPages`. */
  recordsPath: string;
}

/**
 * ¿La respuesta trae un cursor para la siguiente página? Busca en la raíz y en
 * los contenedores habituales (meta, pagination, paging, links…). Un cursor
 * que es una dirección completa NO cuenta: Feed nunca sigue URLs del proveedor.
 */
export function detectPagination(data: unknown, recordsPath: string): DetectedPagination | null {
  if (!isRecord(data)) return null;
  const containers: string[] = [''];
  for (const [key, value] of Object.entries(data)) {
    if (isRecord(value) && SAFE_KEY.test(key) && key !== recordsPath) containers.push(key);
  }
  for (const { key, param } of CURSOR_KEYS) {
    for (const container of containers) {
      const path = container ? `${container}.${key}` : key;
      if (path === recordsPath) continue;
      const value = valueAt(data, path);
      const usable =
        (typeof value === 'string' &&
          value.length > 0 &&
          value.length <= 4000 &&
          !/^https?:\/\//i.test(value)) ||
        (typeof value === 'number' && Number.isFinite(value));
      if (usable) return { nextCursorPath: path, cursorInput: param, recordsPath };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Errores de la prueba, en palabras
// ---------------------------------------------------------------------------

export function friendlyTestError(test: {
  ok: boolean;
  error?: string;
  problems?: string[];
  response?: { status: number } | null;
  modelResult?: { ok: boolean; status: number | null; message?: string };
}): string | null {
  if (test.ok && test.modelResult?.ok !== false) return null;
  if (test.error) return [test.error, ...(test.problems ?? [])].join(' ');
  const status = test.response?.status ?? test.modelResult?.status ?? null;
  if (status === 401 || status === 403)
    return 'La API rechazó la clave. Revisa que esté completa y que el tipo de clave sea el correcto.';
  if (status === 404)
    return 'En esa dirección no hay nada (error 404). Revisa que esté bien copiada.';
  if (status === 429)
    return 'La API pidió esperar (demasiadas consultas). Prueba de nuevo en un minuto.';
  if (status !== null && status >= 500)
    return `La API falló de su lado (error ${status}). No es tu configuración; prueba más tarde.`;
  if (status !== null && status >= 400)
    return `La API respondió con error ${status}. Revisa la dirección y la clave.`;
  const message = test.modelResult?.message ?? '';
  if (/not allowed|blocked|internal network/i.test(message))
    return 'Por seguridad, Cortex solo se conecta a direcciones públicas de internet.';
  if (/did not answer|timeout/i.test(message))
    return 'La API tardó demasiado en responder. Prueba de nuevo o sube el tiempo de espera en Opciones avanzadas.';
  if (/redirect/i.test(message))
    return 'La API respondió con una redirección. Usa la dirección final, o permite redirecciones en Opciones avanzadas.';
  return 'No se pudo leer la API. Revisa la dirección y la clave.';
}

// ---------------------------------------------------------------------------
// Frecuencia y chat
// ---------------------------------------------------------------------------

/** Cada cuánto debe estar al día una fuente (minutos, como `freshness_minutes`). */
export const FRESHNESS_CHOICES: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 60, label: 'Cada hora' },
  { minutes: 360, label: 'Cada 6 horas' },
  { minutes: 1440, label: 'Una vez al día' },
  { minutes: 10080, label: 'Una vez a la semana' },
];

/** El enlace «Hazlo con Cortex»: el chat con la petición ya escrita. */
export function chatHref(url: string): string {
  // Sólo origen y ruta: lo que vaya en la consulta (?…) puede ser una clave, y
  // esto termina en la barra de direcciones.
  let where = '';
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      where = ` La dirección es ${parsed.origin}${parsed.pathname}.`;
  } catch {
    // Sin dirección válida, el chat la pregunta.
  }
  const prompt = `Quiero conectar una API a la bandeja de Feed para leer sus datos.${where} Pregúntame qué datos necesito, cómo se autentica y cada cuánto actualizarla, y ayúdame a dejarla lista.`;
  return `/chat?prompt=${encodeURIComponent(prompt)}`;
}
