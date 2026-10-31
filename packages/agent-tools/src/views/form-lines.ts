/**
 * LÍNEAS DE UN FORMULARIO: «elegir varios equipos, cada uno con su cantidad».
 *
 * Un formulario con `lines` pide, además de sus campos, una lista de ítems con
 * cantidad (los equipos de un préstamo, los productos de un pedido). Cada línea
 * se guarda como UNA FILA de una tabla hija, relacionada con la fila que el
 * formulario crea. Es el motor general: sirve para cualquier par de tablas
 * padre/hija; no hay nada a la medida de un negocio.
 *
 * Esta pieza es pura (la corren el navegador, el servidor y las pruebas):
 *   - el viaje: el navegador manda las líneas dentro de `values` bajo la llave
 *     reservada `__lines` como JSON; ningún campo de tabla puede llamarse así.
 *   - `normalizeLines`: ordena la entrada, suma el mismo ítem repetido y
 *     descarta lo que no sirve; `checkLines`: topes, cantidades y fotos.
 *
 * FOTO POR LÍNEA (opcional, puede ser obligatoria): cada línea lleva en `photo` el
 * valor de un campo `file` de la tabla hija (el JSON {url,name,mime,size} que ya
 * produce la subida de archivos de los formularios). Al repetirse un ítem, las
 * fotos de las dos líneas se juntan en el mismo campo (los campos `file` aceptan
 * varios archivos), así que ninguna foto se pierde.
 */

export const LINES_KEY = '__lines';

/**
 * Un formulario puede llevar varias secciones de líneas (equipos usados Y
 * materiales gastados): la primera viaja en `__lines`, las siguientes en
 * `__lines2`, `__lines3`. Cada una es su propia tabla hija.
 */
export const MAX_LINE_SECTIONS = 3;
export const linesKeyAt = (index: number): string => (index === 0 ? LINES_KEY : `${LINES_KEY}${index + 1}`);
export const isLinesKey = (key: string): boolean => /^__lines[23]?$/.test(key);
export const linesIndexOf = (key: string): number =>
  key === LINES_KEY ? 0 : isLinesKey(key) ? Number(key.slice(LINES_KEY.length)) - 1 : -1;

/** Las secciones de líneas de un formulario, en orden, con la llave en que viajan. */
export function formLineSections<T>(block: {
  lines?: T | null;
  moreLines?: T[] | null;
}): Array<{ key: string; cfg: T }> {
  const all = [...(block.lines ? [block.lines] : []), ...(block.moreLines ?? [])].slice(
    0,
    MAX_LINE_SECTIONS,
  );
  return all.map((cfg, i) => ({ key: linesKeyAt(i), cfg }));
}

/** Tope de líneas por envío, sea cual sea la configuración del formulario. */
export const MAX_LINES = 50;
/** Cantidad máxima por línea (evita un dedo largo sobre el teclado). */
export const MAX_LINE_QTY = 1_000_000;

export interface FormLine {
  /** La fila elegida de la tabla de ítems. */
  item: { id: string; label: string };
  qty: number;
  /**
   * La foto de la línea: el valor del campo `file` de la tabla hija (JSON de un archivo o
   * de varios). Vacío/ausente = sin foto.
   */
  photo?: string;
  /**
   * Lo que la tabla hija trae de esa fila (la tarifa del equipo): sólo para mostrar el
   * monto al instante en el navegador. El servidor lo ignora y lo recalcula de la base.
   */
  pick?: Record<string, string | number>;
}

export interface FormLinesConfig {
  min?: number;
  max?: number;
  /** Cantidades con decimales (kilos, metros). Por omisión, enteras. */
  decimals?: boolean;
  /** Cada línea debe traer su foto (sólo tiene sentido si la sección pide foto). */
  photoRequired?: boolean;
}

/** Tope de fotos por línea al juntar las de un ítem repetido (el mismo de un campo `file` múltiple). */
export const MAX_LINE_PHOTOS = 5;
const MAX_PHOTO_CHARS = 20_000;

/** Los archivos que un valor de foto menciona (objetos con `url`), tolerando un objeto suelto o un arreglo. */
function photoFiles(raw: string | undefined): Array<Record<string, unknown>> {
  const s = (raw ?? '').trim();
  if (!s) return [];
  try {
    const data: unknown = JSON.parse(s);
    return (Array.isArray(data) ? data : [data]).filter(
      (f): f is Record<string, unknown> =>
        Boolean(f) && typeof f === 'object' && typeof (f as { url?: unknown }).url === 'string' && Boolean((f as { url: string }).url),
    );
  } catch {
    return [];
  }
}

/** ¿La línea trae al menos una foto? (una foto pendiente de subir también cuenta). */
export function hasLinePhoto(l: Pick<FormLine, 'photo'>): boolean {
  return photoFiles(l.photo).length > 0;
}

/** Junta dos valores de foto sin repetir archivos (por URL), hasta `MAX_LINE_PHOTOS`. */
export function mergePhotos(a: string | undefined, b: string | undefined): string | undefined {
  const all = [...photoFiles(a), ...photoFiles(b)];
  const seen = new Set<string>();
  const uniq = all.filter((f) => !seen.has(String(f.url)) && seen.add(String(f.url))).slice(0, MAX_LINE_PHOTOS);
  if (!uniq.length) return undefined;
  return JSON.stringify(uniq.length === 1 ? uniq[0] : uniq);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** El JSON de las líneas, tal como viaja en `values.__lines`; null si no es una lista válida. */
export function parseLinesValue(raw: unknown): FormLine[] | null {
  if (raw === undefined || raw === null || raw === '') return [];
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(data)) return null;
  const out: FormLine[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as { item?: { id?: unknown; label?: unknown }; qty?: unknown };
    const id = typeof e.item?.id === 'string' ? e.item.id : '';
    if (!UUID_RE.test(id)) return null;
    const qty = typeof e.qty === 'number' ? e.qty : Number(e.qty);
    if (!Number.isFinite(qty)) return null;
    const pick = cleanPick((entry as { pick?: unknown }).pick);
    const rawPhoto = (entry as { photo?: unknown }).photo;
    const photo =
      typeof rawPhoto === 'string' && rawPhoto.length <= MAX_PHOTO_CHARS
        ? mergePhotos(rawPhoto, undefined)
        : undefined;
    out.push({
      item: { id, label: typeof e.item?.label === 'string' ? e.item.label.slice(0, 200) : '' },
      qty,
      ...(photo ? { photo } : {}),
      ...(pick ? { pick } : {}),
    });
  }
  return out;
}

function cleanPick(raw: unknown): Record<string, string | number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 8))
    if (/^[a-z][a-z0-9_]{0,31}$/.test(k) && (typeof v === 'number' || typeof v === 'string'))
      out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  return Object.keys(out).length ? out : undefined;
}

export function serializeLines(lines: FormLine[]): string {
  return JSON.stringify(
    lines.map((l) => ({
      item: l.item,
      qty: l.qty,
      ...(l.photo ? { photo: l.photo } : {}),
      ...(l.pick ? { pick: l.pick } : {}),
    })),
  );
}

/**
 * Suma el mismo ítem repetido (juntando también sus fotos), deja el orden de la primera
 * aparición y quita las cantidades en cero.
 */
export function normalizeLines(lines: FormLine[]): FormLine[] {
  const byId = new Map<string, FormLine>();
  for (const l of lines) {
    const hit = byId.get(l.item.id);
    if (hit) {
      hit.qty = Math.round((hit.qty + l.qty) * 1e6) / 1e6;
      const photo = mergePhotos(hit.photo, l.photo);
      if (photo) hit.photo = photo;
    } else {
      const photo = mergePhotos(l.photo, undefined);
      byId.set(l.item.id, {
        item: { ...l.item },
        qty: l.qty,
        ...(photo ? { photo } : {}),
        ...(l.pick ? { pick: l.pick } : {}),
      });
    }
  }
  return [...byId.values()].filter((l) => l.qty !== 0);
}

/** Lo que está mal en las líneas, en español; null si todo cuadra. */
export function checkLines(
  lines: FormLine[],
  cfg: FormLinesConfig & { title?: string } = {},
): string | null {
  const name = cfg.title ? `«${cfg.title}»` : 'La lista';
  const max = Math.min(cfg.max ?? MAX_LINES, MAX_LINES);
  const min = cfg.min ?? 0;
  if (lines.length < min)
    return min === 1
      ? `${name}: agrega al menos un ítem.`
      : `${name}: agrega al menos ${min} ítems.`;
  if (lines.length > max) return `${name}: máximo ${max} ítems por envío.`;
  for (const l of lines) {
    const who = l.item.label ? `«${l.item.label}»` : 'un ítem';
    if (!(l.qty > 0)) return `${name}: la cantidad de ${who} tiene que ser mayor que cero.`;
    if (l.qty > MAX_LINE_QTY) return `${name}: la cantidad de ${who} es demasiado grande.`;
    if (!cfg.decimals && !Number.isInteger(l.qty))
      return `${name}: la cantidad de ${who} tiene que ser un número entero.`;
    if (cfg.photoRequired && !hasLinePhoto(l))
      return `${name}: falta la foto de ${who}.`;
  }
  return null;
}
