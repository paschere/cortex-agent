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
 *     descarta lo que no sirve; `checkLines`: topes y cantidades.
 */

export const LINES_KEY = '__lines';

/** Tope de líneas por envío, sea cual sea la configuración del formulario. */
export const MAX_LINES = 50;
/** Cantidad máxima por línea (evita un dedo largo sobre el teclado). */
export const MAX_LINE_QTY = 1_000_000;

export interface FormLine {
  /** La fila elegida de la tabla de ítems. */
  item: { id: string; label: string };
  qty: number;
}

export interface FormLinesConfig {
  min?: number;
  max?: number;
  /** Cantidades con decimales (kilos, metros). Por omisión, enteras. */
  decimals?: boolean;
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
    out.push({
      item: { id, label: typeof e.item?.label === 'string' ? e.item.label.slice(0, 200) : '' },
      qty,
    });
  }
  return out;
}

export function serializeLines(lines: FormLine[]): string {
  return JSON.stringify(lines.map((l) => ({ item: l.item, qty: l.qty })));
}

/** Suma el mismo ítem repetido, deja el orden de la primera aparición y quita las cantidades en cero. */
export function normalizeLines(lines: FormLine[]): FormLine[] {
  const byId = new Map<string, FormLine>();
  for (const l of lines) {
    const hit = byId.get(l.item.id);
    if (hit) hit.qty = Math.round((hit.qty + l.qty) * 1e6) / 1e6;
    else byId.set(l.item.id, { item: { ...l.item }, qty: l.qty });
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
  }
  return null;
}
