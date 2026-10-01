import type { ViewBlock, ViewSpec } from '@cortex/agent-tools';
import type { EditorSource } from './editor-spec';

/**
 * EL ESTUDIO, SIN PANTALLA: LO QUE SE PUEDE PROBAR SIN NAVEGADOR.
 *
 * El estudio (components/views/editor/ViewEditor.tsx y components/views/studio)
 * decide cosas que no dependen de React: dónde cae una pieza que se suelta
 * sobre el lienzo, cuántas columnas ocupa un bloque en un teléfono, qué frases
 * sugerirle a la persona para la caja de Cortex y cómo decir «hace 2 h». Viven
 * aquí, puras, para que `studio.test.ts` las pruebe y los componentes sólo
 * decidan CUÁNDO llamarlas.
 *
 * Sólo TIPOS de `@cortex/agent-tools`: el barril no entra en el bundle de
 * cliente (ver editor-shape.ts).
 */

// ---------------------------------------------------------------------------
// Dispositivos
// ---------------------------------------------------------------------------

export const DEVICES = ['desktop', 'tablet', 'phone'] as const;
export type StudioDevice = (typeof DEVICES)[number];

/**
 * El ancho del marco de cada dispositivo en el lienzo. El computador es
 * fluido hasta 1280 (el lienzo casi nunca mide tanto con los dos paneles
 * abiertos, y una barra de scroll horizontal en un editor es un castigo);
 * tableta y teléfono son fijos, porque ahí lo que se quiere ver es justamente
 * cómo se acomoda en ese ancho.
 */
export const DEVICE_WIDTH: Record<StudioDevice, number> = {
  desktop: 1280,
  tablet: 768,
  phone: 390,
};

export const DEVICE_LABEL: Record<StudioDevice, string> = {
  desktop: 'Computador',
  tablet: 'Tableta',
  phone: 'Celular',
};

/**
 * Cuántas de las 6 columnas ocupa un bloque en cada dispositivo. Es la misma
 * regla que la vista guardada (`ViewCanvas`: tercio = 2 columnas desde 1280 px,
 * 3 en tableta; en el teléfono todo es ancho completo), escrita con clases sin
 * prefijo de pantalla: en el lienzo el ancho lo decide el MARCO, no la ventana.
 * Clases completas y literales para que Tailwind las encuentre.
 */
const SPANS: Record<StudioDevice, Record<string, string>> = {
  desktop: { full: 'col-span-6', half: 'col-span-3', third: 'col-span-2' },
  tablet: { full: 'col-span-6', half: 'col-span-3', third: 'col-span-3' },
  phone: { full: 'col-span-1', half: 'col-span-1', third: 'col-span-1' },
};

export function deviceSpan(width: string, device: StudioDevice): string {
  const table = SPANS[device];
  return table[width] ?? table.full ?? 'col-span-6';
}

export function deviceColumns(device: StudioDevice): string {
  return device === 'phone' ? 'grid-cols-1' : 'grid-cols-6';
}

/**
 * Del ancho arrastrado con el asa al ancho del contrato. `fraction` es cuánto
 * de la rejilla cubre el bloque desde su borde izquierdo hasta el puntero.
 * Los cortes están a medio camino entre tercio, mitad y completo.
 */
export function widthFromFraction(fraction: number): 'third' | 'half' | 'full' {
  if (fraction < 0.42) return 'third';
  if (fraction < 0.76) return 'half';
  return 'full';
}

// ---------------------------------------------------------------------------
// Soltar sobre el lienzo
// ---------------------------------------------------------------------------

export interface DropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface DropMeasure {
  id: string;
  rect: DropRect;
  /** Un bloque que ocupa casi todo el ancho: se cae antes/después por arriba y abajo. */
  wide: boolean;
}

export type DropSide = 'left' | 'right' | 'top' | 'bottom';

export interface DropSpot {
  /** Posición de inserción 0..n, o null si no cambia nada. */
  insert: number | null;
  target: { id: string; side: DropSide } | null;
}

/**
 * Dónde cae algo que se suelta en (x, y).
 *
 * El bloque bajo el puntero —o el más cercano— decide; en un bloque ancho la
 * mitad de arriba es «antes», en uno angosto la mitad izquierda. `from` es el
 * índice del bloque que se mueve (null cuando lo que se suelta es una pieza
 * nueva de la biblioteca): caer justo antes o justo después de sí mismo es no
 * moverse. Debajo del último bloque es «al final».
 */
export function locateDrop(
  x: number,
  y: number,
  measures: DropMeasure[],
  from: number | null,
): DropSpot {
  if (!measures.length) return { insert: 0, target: null };
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  measures.forEach(({ rect }, i) => {
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    const d = Math.hypot(dx, dy);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  const hit = measures[best];
  if (!hit || best === from) return { insert: null, target: null };
  // Por debajo de todo: al final, aunque el último bloque sea angosto.
  const lowest = Math.max(...measures.map((m) => m.rect.bottom));
  if (from === null && y > lowest) {
    const last = measures[measures.length - 1];
    return {
      insert: measures.length,
      target: last ? { id: last.id, side: last.wide ? 'bottom' : 'right' } : null,
    };
  }
  const before = hit.wide
    ? y < hit.rect.top + hit.rect.height / 2
    : x < hit.rect.left + hit.rect.width / 2;
  const insert = before ? best : best + 1;
  if (from !== null && (insert === from || insert === from + 1))
    return { insert: null, target: null };
  const side: DropSide = hit.wide ? (before ? 'top' : 'bottom') : before ? 'left' : 'right';
  return { insert, target: { id: hit.id, side } };
}

/** Inserta un bloque en una posición 0..n, sin tocar el spec original. */
export function insertBlockAt(spec: ViewSpec, block: ViewBlock, index: number): ViewSpec {
  const blocks = [...spec.blocks];
  const at = Math.max(0, Math.min(index, blocks.length));
  blocks.splice(at, 0, block);
  return { ...spec, blocks };
}

/** Le pone otro título a un bloque que tiene título; un texto no tiene. */
export function renameBlock(block: ViewBlock, title: string): ViewBlock | null {
  if (!('title' in block) || typeof block.title !== 'string') return null;
  const clean = title.replace(/\s+/g, ' ').trimStart().slice(0, 120);
  return { ...block, title: clean } as ViewBlock;
}

// ---------------------------------------------------------------------------
// Sugerencias para la caja de Cortex
// ---------------------------------------------------------------------------

function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Frases para la caja de Cortex que salen de ESTA vista: sus tablas, sus
 * campos y lo que le falta. Una sugerencia genérica («agrega un gráfico»)
 * obliga a la persona a completar la frase; una con el nombre de su tabla y
 * de su campo se puede mandar tal cual. Hasta `max`, sin repetir.
 */
export function studioSuggestions(
  spec: ViewSpec,
  sources: EditorSource[],
  selectedTitle: string | null,
  max = 5,
): string[] {
  const out: string[] = [];
  const add = (s: string | null | undefined) => {
    if (s && !out.includes(s)) out.push(s);
  };
  const used = new Set(
    spec.blocks
      .map((b) => ('tracker' in b && typeof b.tracker === 'string' ? b.tracker : null))
      .filter((t): t is string => Boolean(t)),
  );
  const readable = sources.filter((s) => !s.opaque && s.fields.length > 0);
  const inView = readable.filter((s) => used.has(s.slug));
  const pool = inView.length ? inView : readable.slice(0, 3);
  const has = (type: string) => spec.blocks.some((b) => b.type === type);

  if (selectedTitle) add(`Haz «${selectedTitle}» más ancho y ponlo de primero`);

  for (const source of pool) {
    const select = source.fields.find((f) => f.type === 'select');
    const money = source.fields.find((f) => f.type === 'money');
    const date = source.fields.find((f) => f.type === 'date');
    if (select && !has('chart'))
      add(`Agrega un gráfico de ${lower(source.name)} por ${lower(select.label)}`);
    if (money) add(`Agrega una cifra con el total de ${lower(money.label)} en ${source.name}`);
    if (!source.readOnly) add(`Haz que suene cuando entre una fila nueva en ${source.name}`);
    if (date && has('table'))
      add(`Muestra sólo lo de los últimos 30 días según ${lower(date.label)}`);
    if (select && has('board') && !source.readOnly)
      add(`Que se pueda cambiar ${lower(select.label)} arrastrando las tarjetas`);
    if (!source.readOnly && !has('form'))
      add(`Agrega un formulario para registrar en ${source.name}`);
  }
  if (!pool.length) {
    add('Arma un tablero con las cifras clave, un gráfico y la lista completa');
    add('Crea una tabla de solicitudes con un formulario para recibirlas');
  }
  add('Pon un título arriba que explique para qué sirve esta vista');
  return out.slice(0, max);
}

// ---------------------------------------------------------------------------
// Tiempo relativo para la lista
// ---------------------------------------------------------------------------

const SHORT_DATE = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  timeZone: 'America/Bogota',
});

/** «hace un momento», «hace 5 min», «hace 3 h», «ayer», «hace 4 días» o «12 sept». */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((now.getTime() - then) / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} días`;
  return SHORT_DATE.format(new Date(then)).replace('.', '');
}

// ---------------------------------------------------------------------------
// Borrador guardado en el navegador
// ---------------------------------------------------------------------------

export interface StoredDraft<T> {
  draft: T;
  /** Cuándo se escribió, ISO. */
  at: string;
  /** La versión guardada sobre la que se estaba trabajando (null en una vista nueva). */
  version: number | null;
}

export function draftKey(viewId: string | undefined): string {
  return `cortex.views.borrador.${viewId ?? 'nueva'}`;
}

/** Lee un borrador guardado, o null si no hay, no se puede leer o no tiene la forma. */
export function parseStoredDraft<T>(raw: string | null): StoredDraft<T> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredDraft<T>>;
    if (!value || typeof value !== 'object' || !value.draft || typeof value.at !== 'string')
      return null;
    return {
      draft: value.draft,
      at: value.at,
      version: typeof value.version === 'number' ? value.version : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Páginas
// ---------------------------------------------------------------------------

/**
 * Las páginas de una vista (`spec.pages`, del motor): pestañas sobre la MISMA
 * lista de bloques. Cada página nombra sus bloques; los que no están en
 * ninguna salen en la primera. El estudio no define páginas propias: sólo lee
 * y ajusta esa lista para que lo que hace a mano (agregar, borrar, duplicar un
 * bloque en una página) no deje una página nombrando un bloque que ya no está,
 * que es justo lo que el contrato rechaza.
 */
export interface StudioPage {
  id: string;
  title: string;
  blockIds: string[];
}

export function pagesOf(spec: ViewSpec): StudioPage[] {
  const pages = (spec as { pages?: unknown }).pages;
  return Array.isArray(pages) ? (pages as StudioPage[]) : [];
}

function withPages(spec: ViewSpec, pages: StudioPage[]): ViewSpec {
  return { ...spec, pages } as ViewSpec;
}

/** Los bloques que se ven en una página (todos, si la vista no tiene páginas). */
export function blocksOfPage(spec: ViewSpec, pageId: string | null): ViewBlock[] {
  const pages = pagesOf(spec);
  if (!pages.length || !pageId) return spec.blocks;
  const page = pages.find((p) => p.id === pageId) ?? pages[0];
  if (!page) return spec.blocks;
  const first = pages[0]?.id === page.id;
  const assigned = new Set(pages.flatMap((p) => p.blockIds));
  return spec.blocks.filter((b) => page.blockIds.includes(b.id) || (first && !assigned.has(b.id)));
}

/** Quita de las páginas los bloques que ya no existen. Sin páginas, no toca nada. */
export function prunePages(spec: ViewSpec): ViewSpec {
  const pages = pagesOf(spec);
  if (!pages.length) return spec;
  const ids = new Set(spec.blocks.map((b) => b.id));
  if (pages.every((p) => p.blockIds.every((id) => ids.has(id)))) return spec;
  return withPages(
    spec,
    pages.map((p) => ({ ...p, blockIds: p.blockIds.filter((id) => ids.has(id)) })),
  );
}

/**
 * Pone o quita un bloque de una página. Un bloque puede estar en varias (una
 * fila de cifras arriba de cada pestaña): es la regla del motor
 * (`computePages`), así que aquí no se lo saca de las demás.
 */
export function togglePage(spec: ViewSpec, blockId: string, pageId: string, on: boolean): ViewSpec {
  const pages = pagesOf(spec);
  if (!pages.length) return spec;
  return withPages(
    spec,
    pages.map((p) => {
      if (p.id !== pageId) return p;
      const rest = p.blockIds.filter((id) => id !== blockId);
      return { ...p, blockIds: on ? [...rest, blockId] : rest };
    }),
  );
}

/** Una copia sale en las mismas páginas que su original. */
export function copyPages(spec: ViewSpec, fromId: string, toId: string): ViewSpec {
  const pages = pagesOf(spec);
  if (!pages.some((p) => p.blockIds.includes(fromId))) return spec;
  return withPages(
    spec,
    pages.map((p) => (p.blockIds.includes(fromId) ? { ...p, blockIds: [...p.blockIds, toId] } : p)),
  );
}

/** Las páginas donde se ve un bloque (la primera, si no está nombrado en ninguna). */
export function pagesOfBlock(spec: ViewSpec, blockId: string): string[] {
  const pages = pagesOf(spec);
  if (!pages.length) return [];
  const named = pages.filter((p) => p.blockIds.includes(blockId)).map((p) => p.id);
  return named.length ? named : pages[0] ? [pages[0].id] : [];
}
