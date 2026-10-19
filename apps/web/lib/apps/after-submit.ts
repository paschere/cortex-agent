/**
 * ENCADENAR PANTALLAS: «al terminar, abre esta otra con estos valores ya puestos».
 *
 * Lo puro del lado del navegador (sin React, sin red): armar los valores
 * prellenados desde lo que se acaba de enviar, llevarlos en la dirección
 * (`?pre=`) y leerlos en la pantalla destino. Los valores sólo SUGIEREN: el
 * formulario destino los pone como valor inicial de los campos que tenga, la
 * persona los puede cambiar y todo se valida igual al enviar.
 */

export interface ThenNav {
  screen: string;
  prefill?: Record<string, string | number>;
}

export interface PrefillSource {
  /** Lo que se envió, por campo (formulario). Vacío en un botón de fila. */
  values?: Record<string, string>;
  /** La fila recién creada (o la de la fila del botón). */
  row?: { id: string; label: string } | null;
}

const VAR = /\{\{\s*([^{}]{1,48}?)\s*\}\}/g;
const WHOLE = /^\s*\{\{\s*([^{}]{1,48}?)\s*\}\}\s*$/;

function relationJson(row: { id: string; label: string }): string {
  return JSON.stringify({ id: row.id, label: row.label });
}

function read(name: string, src: PrefillSource, asRelation: boolean): string {
  const n = name.trim();
  const lower = n.toLowerCase();
  if (lower === 'fila') {
    if (!src.row) return '';
    return asRelation ? relationJson(src.row) : src.row.label;
  }
  if (lower === 'nombre') return src.row?.label ?? '';
  if (lower === 'id') return src.row?.id ?? '';
  const v = src.values?.[n];
  if (v !== undefined) return v;
  // También por nombre sin importar mayúsculas.
  const key = Object.keys(src.values ?? {}).find((k) => k.toLowerCase() === lower);
  return key ? (src.values?.[key] ?? '') : '';
}

/** Los valores a prellenar: fijos, o con `{{campo}}` / `{{fila}}` / `{{nombre}}`. Lo vacío no se manda. */
export function buildPrefill(then: ThenNav, src: PrefillSource): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(then.prefill ?? {})) {
    let value: string;
    if (typeof raw === 'number') value = String(raw);
    else {
      const whole = WHOLE.exec(raw);
      // Una sola variable conserva el valor tal cual (la fila, como relación).
      value = whole
        ? read(whole[1] ?? '', src, true)
        : raw.replace(VAR, (_m, name: string) => read(name, src, false));
    }
    if (value !== '') out[key] = value;
  }
  return out;
}

export const PREFILL_PARAM = 'pre';
const MAX_PREFILL_CHARS = 1500;

function toB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(text: string): string {
  const pad = '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Lo prellenado, listo para la dirección; '' si no hay nada (o es demasiado). */
export function encodePrefill(values: Record<string, string>): string {
  if (!Object.keys(values).length) return '';
  const encoded = toB64(JSON.stringify(values));
  return encoded.length > MAX_PREFILL_CHARS ? '' : encoded;
}

/** Lo que trae la dirección; ignora cualquier cosa que no sea un objeto de textos. */
export function decodePrefill(param: string | null | undefined): Record<string, string> {
  if (!param || param.length > MAX_PREFILL_CHARS) return {};
  try {
    const data = JSON.parse(fromB64(param)) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>))
      if (/^[a-z][a-z0-9_]{0,31}$/.test(k) && typeof v === 'string') out[k] = v.slice(0, 1000);
    return out;
  } catch {
    return {};
  }
}

/** La dirección de la pantalla destino, con lo prellenado. `base` es la de la app (sin barra final). */
export function thenHref(base: string, then: ThenNav, src: PrefillSource, suffix = ''): string {
  const pre = encodePrefill(buildPrefill(then, src));
  const query = pre ? `${PREFILL_PARAM}=${pre}` : '';
  const path = `${base}/${then.screen}`;
  // `suffix` es el «?como=…» de «Ver como…», si lo hay.
  if (suffix && query) return `${path}${suffix}&${query}`;
  if (suffix) return `${path}${suffix}`;
  return query ? `${path}?${query}` : path;
}

/**
 * Los valores iniciales de un formulario con lo prellenado encima: sólo los de
 * campos que este formulario tiene. Un campo calculado o desconocido se ignora.
 */
export function applyPrefill(
  fields: ReadonlyArray<{ key: string; formula?: boolean }>,
  current: Record<string, string>,
  pre: Record<string, string>,
): Record<string, string> {
  const out = { ...current };
  for (const f of fields) {
    const v = pre[f.key];
    if (v === undefined || f.formula) continue;
    out[f.key] = v;
  }
  return out;
}
