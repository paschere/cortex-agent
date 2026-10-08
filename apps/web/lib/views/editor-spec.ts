import type {
  ComputedView,
  DuplicateRule,
  TrackerField,
  ViewAlert,
  ViewBlock,
  ViewFilter,
  ViewSpec,
} from '@cortex/agent-tools';
import type { ZodIssue } from 'zod';
import {
  BLOCK_ID_RE,
  BLOCK_LABEL,
  BUILTIN_FIELD_LABEL,
  type EditorFilterOp,
  FILTER_OP_LABEL,
  type KnownBlockType,
  MAX_VIEW_BLOCKS,
  isReadOnlySourceId,
} from './editor-shape';

/**
 * LO QUE EL LIENZO LE HACE A UN SPEC, SIN PANTALLA.
 *
 * Mover, duplicar, borrar, cambiar el ancho, cambiar la fuente de un bloque y
 * crear uno nuevo desde una plantilla son funciones puras sobre el spec: el
 * componente sólo decide CUÁNDO llamarlas. Así se prueban sin navegador
 * (`editor-spec.test.ts`) y el lienzo no inventa una segunda forma de vista: lo
 * que sale de aquí es un `ViewSpec` que pasa por el mismo `viewSpecSchema` y el
 * mismo `checkSpecAgainst` que lo que escribe Cortex.
 *
 * Todo es inmutable: el deshacer del lienzo guarda specs anteriores tal cual,
 * y un spec que alguien mutó en el sitio es un deshacer que no deshace.
 *
 * Sólo TIPOS de `@cortex/agent-tools` (ver editor-shape.ts para el porqué).
 */

// ---------------------------------------------------------------------------
// El catálogo, como lo ve el lienzo
// ---------------------------------------------------------------------------

export interface EditorSource {
  /** Slug de la tabla, `cortex.*` o un id del Feed. */
  slug: string;
  name: string;
  description: string;
  kind: 'tracker' | 'platform' | 'feed';
  sensitivity: 'shareable' | 'internal' | 'personal';
  /** Fuentes de la plataforma y del Feed: sin formularios, celdas ni botones. */
  readOnly: boolean;
  /** Una tabla del Feed que la vista ya usaba y quien edita no puede leer. */
  opaque?: boolean;
  fields: TrackerField[];
}

export interface EditorCatalog {
  sources: EditorSource[];
  /**
   * Los tipos de bloque que el contrato acepta HOY, leídos del esquema en el
   * servidor. Es lo que decide si la paleta ofrece «Plano» (`zones`): el
   * lienzo no promete un bloque que el guardado rechazaría.
   */
  blockTypes: string[];
  /**
   * La gente del espacio que puede recibir el resumen periódico (`spec.digest`).
   * Opcional: un servidor viejo no la manda y los ajustes lo dicen.
   */
  team?: Array<{ id: string; name: string }>;
}

export interface EditorProblem {
  blockId?: string;
  alertId?: string;
  message: string;
}

export type PreviewResult =
  | { ok: true; view: ComputedView | null; problems: EditorProblem[] }
  | { ok: false; error: string };

/** Una tabla que un borrador de Cortex propuso y se crea al guardar. */
export interface NewTrackerDraft {
  slug: string;
  name: string;
  description: string;
  fields: TrackerField[];
  /** Regla de duplicados de la tabla nueva (0201), si la lleva. */
  duplicates?: DuplicateRule;
}

/** Todo lo que el lienzo edita y guarda junto: nombre, descripción, spec y tablas por crear. */
export interface EditorDraft {
  name: string;
  description: string;
  spec: ViewSpec;
  newTrackers: NewTrackerDraft[];
}

/** Las tablas propuestas entran a los menús como tablas propias, aunque todavía no tengan filas. */
export function withDraftSources(
  catalog: EditorCatalog | null,
  draft: EditorDraft,
): EditorSource[] {
  const sources = catalog?.sources ?? [];
  const known = new Set(sources.map((s) => s.slug));
  return [
    ...draft.newTrackers
      .filter((t) => !known.has(t.slug))
      .map(
        (t): EditorSource => ({
          slug: t.slug,
          name: `${t.name} (nueva)`,
          description: t.description,
          kind: 'tracker',
          sensitivity: 'shareable',
          readOnly: false,
          fields: t.fields,
        }),
      ),
    ...sources,
  ];
}

export interface FieldOption {
  key: string;
  label: string;
  type: TrackerField['type'];
  options: string[];
  builtin: boolean;
}

/** Los campos de una fuente más los tres que toda fila tiene, en el orden en que se eligen. */
export function fieldOptions(source: EditorSource | undefined): FieldOption[] {
  if (!source) return [];
  return [
    {
      key: 'label',
      label: BUILTIN_FIELD_LABEL.label ?? 'Nombre',
      type: 'text',
      options: [],
      builtin: true,
    },
    ...source.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      options: f.options ?? [],
      builtin: false,
    })),
    {
      key: 'created_at',
      label: BUILTIN_FIELD_LABEL.created_at ?? 'Creada',
      type: 'date' as const,
      options: [],
      builtin: true,
    },
    {
      key: 'updated_at',
      label: BUILTIN_FIELD_LABEL.updated_at ?? 'Actualizada',
      type: 'date' as const,
      options: [],
      builtin: true,
    },
  ];
}

export function fieldLabel(source: EditorSource | undefined, key: string): string {
  return fieldOptions(source).find((f) => f.key === key)?.label ?? key;
}

export const isNumericField = (f: FieldOption) => f.type === 'number' || f.type === 'money';

// ---------------------------------------------------------------------------
// Bloques
// ---------------------------------------------------------------------------

/** Un bloque sin la parte de datos (texto, o un tipo que el lienzo no conoce). */
export function sourceOf(block: ViewBlock): string | null {
  return 'tracker' in block && typeof block.tracker === 'string' ? block.tracker : null;
}

export function titleOf(block: ViewBlock): string {
  if ('title' in block && typeof block.title === 'string' && block.title.trim()) return block.title;
  if (block.type === 'text') {
    const first = block.markdown.split('\n').find((l) => l.trim()) ?? '';
    return first.replace(/^#+\s*/, '').slice(0, 60) || 'Texto';
  }
  if (block.type === 'links') return block.links[0]?.label ?? BLOCK_LABEL.links ?? 'Botones';
  return BLOCK_LABEL[block.type] ?? 'Sin título';
}

/** Un id libre que cumple BLOCK_ID_RE: `cifra`, `cifra_2`, `cifra_3`… */
export function uniqueBlockId(spec: Pick<ViewSpec, 'blocks'>, base: string): string {
  const clean =
    base
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^[_-]+/, '')
      .slice(0, 32) || 'bloque';
  const taken = new Set(spec.blocks.map((b) => b.id));
  if (!taken.has(clean) && BLOCK_ID_RE.test(clean)) return clean;
  for (let n = 2; n < 1000; n++) {
    const id = `${clean}_${n}`;
    if (!taken.has(id)) return id;
  }
  return `b_${Date.now().toString(36)}`;
}

export function canAddBlock(spec: Pick<ViewSpec, 'blocks'>): boolean {
  return spec.blocks.length < MAX_VIEW_BLOCKS;
}

export function insertBlock(spec: ViewSpec, block: ViewBlock, afterId?: string | null): ViewSpec {
  const at = afterId ? spec.blocks.findIndex((b) => b.id === afterId) : -1;
  const blocks = [...spec.blocks];
  blocks.splice(at >= 0 ? at + 1 : blocks.length, 0, block);
  return { ...spec, blocks };
}

/** Mueve el bloque de `from` a `to` (índices). Fuera de rango, el spec no cambia. */
export function moveBlock(spec: ViewSpec, from: number, to: number): ViewSpec {
  const n = spec.blocks.length;
  if (from === to || from < 0 || from >= n || to < 0 || to >= n) return spec;
  const blocks = [...spec.blocks];
  const [moved] = blocks.splice(from, 1);
  if (!moved) return spec;
  blocks.splice(to, 0, moved);
  return { ...spec, blocks };
}

export function duplicateBlock(spec: ViewSpec, id: string): { spec: ViewSpec; id: string | null } {
  const original = spec.blocks.find((b) => b.id === id);
  if (!original || !canAddBlock(spec)) return { spec, id: null };
  const copyId = uniqueBlockId(spec, original.id.replace(/_\d+$/, ''));
  const copy = structuredClone(original) as ViewBlock;
  copy.id = copyId;
  if ('title' in copy && typeof copy.title === 'string')
    (copy as { title: string }).title = `${copy.title} (copia)`.slice(0, 120);
  // Los botones también llevan id, y deben seguir siendo únicos por bloque — lo son.
  return { spec: insertBlock(spec, copy, id), id: copyId };
}

export function removeBlock(
  spec: ViewSpec,
  id: string,
): { spec: ViewSpec; removed: ViewBlock | null; index: number } {
  const index = spec.blocks.findIndex((b) => b.id === id);
  // Una vista necesita al menos un bloque: el último no se borra.
  if (index < 0 || spec.blocks.length <= 1) return { spec, removed: null, index: -1 };
  const blocks = spec.blocks.filter((b) => b.id !== id);
  return { spec: { ...spec, blocks }, removed: spec.blocks[index] ?? null, index };
}

export function updateBlock(spec: ViewSpec, id: string, next: ViewBlock): ViewSpec {
  return { ...spec, blocks: spec.blocks.map((b) => (b.id === id ? next : b)) };
}

/**
 * Cambiar la fuente de un bloque deja sin sentido todo lo que nombraba campos
 * de la anterior. En vez de dejar filtros y columnas que la comprobación va a
 * rechazar, se limpian y se eligen valores que sí existen en la nueva.
 */
export function withSource(block: ViewBlock, source: EditorSource): ViewBlock {
  const fields = fieldOptions(source);
  const select = fields.find((f) => f.type === 'select');
  const date = fields.find((f) => f.type === 'date' && !f.builtin);
  switch (block.type) {
    case 'metric':
      return { ...block, tracker: source.slug, filters: [], aggregate: 'count', field: undefined };
    case 'table':
      return {
        ...block,
        tracker: source.slug,
        filters: [],
        columns: [],
        sort: undefined,
        editable: [],
        actions: [],
      };
    case 'chart':
      return {
        ...block,
        tracker: source.slug,
        filters: [],
        aggregate: 'count',
        field: undefined,
        groupBy: (select ?? date)?.key ?? 'created_at',
      };
    case 'board':
      return {
        ...block,
        tracker: source.slug,
        filters: [],
        groupBy: select?.key ?? block.groupBy,
        cardFields: [],
        draggable: source.readOnly ? false : block.draggable,
        actions: [],
      };
    case 'form':
      return { ...block, tracker: source.slug, fields: [] };
    case 'gallery':
      return {
        ...block,
        tracker: source.slug,
        filters: [],
        titleField: 'label',
        subtitleField: undefined,
        metaFields: [],
        badgeField: select?.key,
        imageField: undefined,
        sort: undefined,
        actions: [],
        detailFields: undefined,
        recordEditable: undefined,
      };
    case 'cards':
      return {
        ...block,
        tracker: source.slug,
        filters: [],
        titleField: 'label',
        subtitleField: undefined,
        imageField: undefined,
        statusField: select?.key,
        dataFields: [],
        dateField: date?.key,
        groupBy: undefined,
        sort: undefined,
        sortOptions: [],
        actions: [],
        detailFields: undefined,
        recordEditable: undefined,
      };
    case 'detail':
      return {
        ...block,
        tracker: source.slug,
        filters: [],
        titleField: 'label',
        subtitleField: undefined,
        statusField: select?.key,
        sections: [],
        gallery: [],
        related: [],
        actions: [],
        recordEditable: undefined,
      };
    case 'calendar':
      return {
        ...block,
        tracker: source.slug,
        filters: [],
        timeField: undefined,
        modes: undefined,
        dateField: date?.key ?? 'created_at',
        labelField: 'label',
        colorField: select?.key,
        actions: [],
        detailFields: undefined,
        recordEditable: undefined,
      };
    case 'progress':
      return {
        ...block,
        tracker: source.slug,
        filters: [],
        groupBy: select?.key,
        aggregate: 'count',
        field: undefined,
        target: select ? block.target : (block.target ?? 10),
        targets: [],
      };
    default:
      // El plano (`zones`) es un tablero con forma de lugar: lo mismo que el
      // tablero, y además su dibujo, que nombraba opciones de la fuente vieja.
      if ((block as { type: string }).type === 'zones')
        return {
          ...block,
          tracker: source.slug,
          filters: [],
          groupBy: select?.key ?? (block as { groupBy?: string }).groupBy,
          cardFields: [],
          draggable: source.readOnly ? false : (block as { draggable?: boolean }).draggable,
          actions: [],
          layout: [],
        } as ViewBlock;
      return block;
  }
}

/** Qué tipo de bloque admite cada fuente. Null = la admite; si no, por qué no. */
export function sourceRefusal(type: string, source: EditorSource): string | null {
  if (source.opaque) return 'No puedes ver esta tabla del Feed.';
  if (type === 'form' && source.readOnly)
    return 'Un formulario sólo agrega filas a una tabla de tu empresa.';
  if (
    (type === 'board' || type === 'zones') &&
    !fieldOptions(source).some((f) => f.type === 'select')
  )
    return type === 'zones'
      ? 'Un plano necesita un campo de opciones para sus zonas.'
      : 'Un tablero necesita un campo de opciones para sus columnas.';
  // `created_at` siempre existe, pero un calendario de «cuándo se creó cada
  // fila» casi nunca es lo que alguien quiere: pide una fecha de verdad.
  if (type === 'detail' && source.opaque) return 'No puedes ver esta tabla del Feed.';
  if (type === 'calendar' && !source.fields.some((f) => f.type === 'date'))
    return 'Un calendario necesita un campo de fecha (una cita, una entrega, un vencimiento).';
  return null;
}

function preferredSources(sources: EditorSource[]): EditorSource[] {
  const rank = { tracker: 0, platform: 1, feed: 2 } as const;
  return [...sources]
    .filter((s) => !s.opaque)
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.fields.length - a.fields.length);
}

/** Lo que la paleta puede crear: los tipos conocidos y el plano, si el contrato lo acepta. */
export type PaletteType = KnownBlockType | 'zones';

/** Los tipos que no leen ninguna fuente: nacen sin tabla. */
export const SOURCELESS_TYPES: ReadonlySet<string> = new Set(['text', 'media', 'links', 'voice']);

export function defaultSourceFor(
  type: PaletteType,
  sources: EditorSource[],
  prefer?: string | null,
): EditorSource | null {
  const ordered = preferredSources(sources);
  const preferred = prefer ? ordered.find((s) => s.slug === prefer) : undefined;
  if (preferred && !sourceRefusal(type, preferred)) return preferred;
  return ordered.find((s) => !sourceRefusal(type, s)) ?? null;
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Un bloque nuevo desde la paleta, ya válido: con fuente, título y los campos
 * más probables elegidos. `prefer` es la fuente del bloque seleccionado — quien
 * agrega un gráfico al lado de su tabla de remates lo quiere sobre remates.
 */
export function newBlock(
  type: PaletteType,
  spec: ViewSpec,
  sources: EditorSource[],
  prefer?: string | null,
): ViewBlock | null {
  const BASE: Record<PaletteType, string> = {
    zones: 'plano',
    metric: 'cifra',
    table: 'tabla',
    chart: 'grafico',
    board: 'tablero',
    form: 'formulario',
    text: 'texto',
    gallery: 'galeria',
    calendar: 'calendario',
    cards: 'tarjetas',
    detail: 'detalle',
    progress: 'avance',
    media: 'imagen',
    links: 'botones',
    voice: 'voz',
  };
  const id = uniqueBlockId(spec, BASE[type]);
  if (type === 'text')
    return {
      id,
      type: 'text',
      width: 'full',
      markdown: '## Un título\n\nUna línea que explique qué muestra esta parte de la vista.',
    };
  // Sin dirección todavía: el bloque nace vacío, con la invitación a pegarla.
  if (type === 'media') return { id, type: 'media', width: 'half', kind: 'image', aspect: '16:9' };
  if (type === 'links')
    return {
      id,
      type: 'links',
      width: 'full',
      style: 'buttons',
      links: [{ label: 'Todas las vistas', href: '/views', tone: 'primary' }],
    };
  // El asistente de voz maneja un formulario de la misma vista: sin uno, no hay bloque.
  if (type === 'voice') {
    const form = spec.blocks.find((b) => b.type === 'form');
    return form ? { id, type: 'voice', width: 'full', form: form.id } : null;
  }
  const source = defaultSourceFor(type, sources, prefer);
  if (!source) return null;
  const fields = fieldOptions(source);
  const money = fields.find((f) => f.type === 'money');
  const select = fields.find((f) => f.type === 'select');
  const date = fields.find((f) => f.type === 'date' && !f.builtin);
  const name = source.name;
  switch (type) {
    case 'metric':
      return money
        ? {
            id,
            type: 'metric',
            width: 'third',
            tracker: source.slug,
            filters: [],
            title: clip(`Total ${money.label.replace(/\s*\(COP\)/, '')}`),
            aggregate: 'sum',
            field: money.key,
            format: 'money',
            tone: 'primary',
          }
        : {
            id,
            type: 'metric',
            width: 'third',
            tracker: source.slug,
            filters: [],
            title: clip(`Cuántas hay en ${name}`),
            aggregate: 'count',
            format: 'number',
            tone: 'primary',
          };
    case 'table':
      return {
        id,
        type: 'table',
        width: 'full',
        tracker: source.slug,
        filters: [],
        title: clip(name),
        columns: [],
        limit: 50,
        searchable: true,
        editable: [],
        actions: [],
      };
    case 'chart': {
      const by = select ?? date ?? fields.find((f) => f.key === 'created_at');
      return {
        id,
        type: 'chart',
        width: 'half',
        tracker: source.slug,
        filters: [],
        title: clip(`${name} por ${(by?.label ?? 'fecha').toLowerCase()}`),
        chart: select ? 'bar' : 'line',
        groupBy: by?.key ?? 'created_at',
        bucket: 'month',
        aggregate: 'count',
        format: 'number',
        limit: 12,
        tone: 'primary',
      };
    }
    case 'board':
      return {
        id,
        type: 'board',
        width: 'full',
        tracker: source.slug,
        filters: [],
        title: clip(`${name} por ${(select?.label ?? 'estado').toLowerCase()}`),
        groupBy: select?.key ?? 'estado',
        cardFields: fields
          .filter((f) => !f.builtin && f.key !== select?.key)
          .slice(0, 2)
          .map((f) => f.key),
        limit: 30,
        draggable: false,
        actions: [],
      };
    case 'zones':
      // Sin `layout`: las zonas se acomodan solas en filas de tres. Dibujarlas
      // como la bodega de verdad se le pide a Cortex.
      return {
        id,
        type: 'zones',
        width: 'full',
        tracker: source.slug,
        filters: [],
        title: clip(`Plano de ${name.toLowerCase()}`),
        groupBy: select?.key ?? 'estado',
        cardFields: fields
          .filter((f) => !f.builtin && f.key !== select?.key)
          .slice(0, 1)
          .map((f) => f.key),
        limit: 20,
        draggable: false,
        actions: [],
        layout: [],
      } as unknown as ViewBlock;
    case 'form':
      return {
        id,
        type: 'form',
        width: 'half',
        tracker: source.slug,
        title: clip(`Registrar en ${name}`),
        fields: [],
        submitLabel: 'Enviar',
        successMessage: 'Recibido. Gracias.',
      };
    case 'gallery': {
      const text = fields.filter((f) => !f.builtin && f.type === 'text');
      return {
        id,
        type: 'gallery',
        width: 'full',
        tracker: source.slug,
        filters: [],
        title: clip(name),
        titleField: 'label',
        subtitleField: text[0]?.key,
        metaFields: fields
          .filter((f) => !f.builtin && f.key !== select?.key && f.key !== text[0]?.key)
          .slice(0, 2)
          .map((f) => f.key),
        badgeField: select?.key,
        columns: 3,
        limit: 12,
        actions: [],
      };
    }
    case 'cards': {
      const text = fields.filter((f) => !f.builtin && f.type === 'text');
      return {
        id,
        type: 'cards',
        width: 'full',
        tracker: source.slug,
        filters: [],
        title: clip(name),
        titleField: 'label',
        subtitleField: text[0]?.key,
        statusField: select?.key,
        dateField: date?.key,
        dataFields: fields
          .filter((f) => !f.builtin && f.key !== select?.key && f.key !== text[0]?.key)
          .slice(0, 3)
          .map((f) => f.key),
        chips: [...(select ? ['status' as const] : []), ...(date ? ['today' as const] : [])],
        searchable: true,
        sortOptions: [],
        pageSize: 12,
        paging: 'more',
        limit: 100,
        actions: [],
      };
    }
    case 'detail': {
      const own = fields.filter((f) => !f.builtin && f.type !== 'file' && f.key !== select?.key);
      return {
        id,
        type: 'detail',
        width: 'full',
        tracker: source.slug,
        filters: [],
        titleField: 'label',
        statusField: select?.key,
        sections: own.length ? [{ title: 'Datos', fields: own.slice(0, 8).map((f) => f.key) }] : [],
        gallery: fields
          .filter((f) => f.type === 'file')
          .slice(0, 2)
          .map((f) => f.key),
        related: [],
        actions: [],
      };
    }
    case 'calendar':
      return {
        id,
        type: 'calendar',
        width: 'full',
        tracker: source.slug,
        filters: [],
        title: clip(`${name} por ${(date?.label ?? 'fecha').toLowerCase()}`),
        dateField: date?.key ?? 'created_at',
        labelField: 'label',
        colorField: select?.key,
        mode: 'month',
        days: 14,
        actions: [],
      };
    case 'progress':
      return select
        ? {
            id,
            type: 'progress',
            width: 'half',
            tracker: source.slug,
            filters: [],
            title: clip(`${name} por ${select.label.toLowerCase()}`),
            groupBy: select.key,
            aggregate: money ? 'sum' : 'count',
            field: money?.key,
            targets: [],
            format: money ? 'money' : 'number',
            limit: 8,
            tone: 'primary',
          }
        : {
            id,
            type: 'progress',
            width: 'half',
            tracker: source.slug,
            filters: [],
            title: clip(`Meta de ${name.toLowerCase()}`),
            aggregate: 'count',
            target: 100,
            targets: [],
            format: 'number',
            limit: 8,
            tone: 'primary',
          };
  }
}

export function emptyFilter(source: EditorSource | undefined): ViewFilter {
  const first = fieldOptions(source).find((f) => !f.builtin) ?? fieldOptions(source)[0];
  return { field: first?.key ?? 'label', op: 'eq', value: first?.options[0] ?? '' };
}

export function newAlert(spec: ViewSpec, sources: EditorSource[]): ViewAlert | null {
  const source = preferredSources(sources)[0];
  if (!source) return null;
  const taken = new Set(spec.alerts.map((a) => a.id));
  let n = spec.alerts.length + 1;
  while (taken.has(`aviso_${n}`)) n++;
  return {
    id: `aviso_${n}`,
    source: (spec.blocks.map(sourceOf).find(Boolean) as string | undefined) ?? source.slug,
    filters: [],
    on: 'new',
    sound: true,
    desktop: false,
    bell: false,
  };
}

/** Id del aviso sencillo de «Avisos en vivo»: uno solo, sobre la tabla principal. */
export const LIVE_ALERT_ID = 'aviso_vivo';

/**
 * La tabla principal de la vista, para el aviso sencillo: la que alimenta un
 * formulario; si no hay, la de la primera tabla; si no, la del primer bloque
 * con fuente. Nunca una fuente de sólo lectura sin filas que mirar.
 */
export function mainAlertSource(spec: ViewSpec): string | null {
  const form = spec.blocks.find((b) => b.type === 'form') as { tracker?: string } | undefined;
  if (form?.tracker) return form.tracker;
  const table = spec.blocks.find((b) => b.type === 'table');
  const src = table ? sourceOf(table) : undefined;
  if (src) return src;
  return (spec.blocks.map(sourceOf).find(Boolean) as string | undefined) ?? null;
}

/** El aviso sencillo ya creado, si hay. */
export function liveAlertOf(spec: ViewSpec): ViewAlert | undefined {
  return spec.alerts.find((a) => a.id === LIVE_ALERT_ID);
}

/** Enciende el aviso sencillo: pita con lo nuevo y la vista se refresca cada 10 s. */
export function withLiveAlert(spec: ViewSpec): Partial<ViewSpec> | null {
  const source = mainAlertSource(spec);
  if (!source || spec.alerts.length >= 5 || liveAlertOf(spec)) return null;
  return {
    alerts: [
      ...spec.alerts,
      {
        id: LIVE_ALERT_ID,
        source,
        filters: [],
        on: 'new',
        sound: true,
        desktop: false,
        bell: false,
      },
    ],
    ...(spec.refreshSeconds === 0 || spec.refreshSeconds > 30 ? { refreshSeconds: 10 } : {}),
  };
}

/**
 * Si el spec pide escribir (celdas, campos de la ficha, arrastrar, botones):
 * entonces `editing` no puede ser `off`. La misma regla que `specWrites` del
 * contrato, repetida por la razón de editor-shape.ts.
 */
export function specWrites(spec: Pick<ViewSpec, 'blocks'>): boolean {
  return spec.blocks.some((b) => {
    const loose = b as {
      type: string;
      draggable?: boolean;
      actions?: unknown[];
      editable?: unknown[];
      recordEditable?: unknown[];
    };
    if ((loose.recordEditable?.length ?? 0) > 0 || (loose.actions?.length ?? 0) > 0) return true;
    if (loose.type === 'table') return (loose.editable?.length ?? 0) > 0;
    return (loose.type === 'board' || loose.type === 'zones') && Boolean(loose.draggable);
  });
}

export function blockCanWrite(block: ViewBlock): boolean {
  const src = sourceOf(block);
  return Boolean(src) && !isReadOnlySourceId(src as string);
}

// ---------------------------------------------------------------------------
// Problemas, pegados al bloque que los tiene
// ---------------------------------------------------------------------------

const PROP_NAME: Record<string, string> = {
  title: 'Título',
  markdown: 'Texto',
  tracker: 'Fuente',
  source: 'Fuente',
  groupBy: 'Agrupar por',
  field: 'Campo',
  value: 'Valor',
  label: 'Nombre del botón',
  limit: 'Máximo de filas',
  columns: 'Columnas',
  editable: 'Columnas editables',
  actions: 'Botones',
  filters: 'Filtros',
  cardFields: 'Datos de la tarjeta',
  fields: 'Campos',
  submitLabel: 'Texto del botón',
  successMessage: 'Mensaje al enviar',
  intro: 'Introducción',
  caption: 'Nota',
  titleField: 'Título de la tarjeta',
  subtitleField: 'Subtítulo',
  metaFields: 'Datos de la tarjeta',
  badgeField: 'Etiqueta',
  imageField: 'Imagen',
  dateField: 'Campo de fecha',
  labelField: 'Nombre del evento',
  colorField: 'Color por',
  days: 'Días',
  target: 'Meta',
  targets: 'Metas por grupo',
  group: 'Grupo',
  url: 'Dirección',
  href: 'Destino',
  links: 'Botones',
  autoStart: 'Arrancar al abrir',
  alt: 'Texto alternativo',
  detailFields: 'Campos de la ficha',
  recordEditable: 'Campos editables en la ficha',
  filtersBar: 'Barra de filtros',
  pages: 'Páginas',
  blockIds: 'Bloques de la página',
  theme: 'Aspecto',
  cover: 'Portada',
  goal: 'Meta',
  message: 'Mensaje',
  subtitle: 'Subtítulo',
  blocks: 'Bloques',
  alerts: 'Avisos',
  id: 'Identificador',
};

const OP_IN_QUOTES = /«([a-z_]+)»/g;

/** Los códigos de operador que el contrato escribe en sus mensajes, en palabras. */
export function humanizeOps(message: string): string {
  return message.replace(OP_IN_QUOTES, (whole, op: string) =>
    op in FILTER_OP_LABEL ? `«${FILTER_OP_LABEL[op as EditorFilterOp]}»` : whole,
  );
}

function zodMessage(issue: ZodIssue): string {
  if (issue.code === 'custom') return humanizeOps(issue.message);
  const key = [...issue.path].reverse().find((p) => typeof p === 'string') as string | undefined;
  const name = PROP_NAME[key ?? ''] ?? key ?? 'Un valor';
  if (issue.code === 'too_small')
    return issue.type === 'string'
      ? `«${name}» no puede quedar vacío.`
      : issue.type === 'array'
        ? `«${name}» necesita al menos ${issue.minimum}.`
        : `«${name}» debe ser al menos ${issue.minimum}.`;
  if (issue.code === 'too_big')
    return issue.type === 'string'
      ? `«${name}» es demasiado largo (máximo ${issue.maximum} caracteres).`
      : issue.type === 'array'
        ? `«${name}» admite máximo ${issue.maximum}.`
        : `«${name}» debe ser como mucho ${issue.maximum}.`;
  if (issue.code === 'invalid_type' && issue.received === 'undefined') return `Falta «${name}».`;
  return `«${name}» no es válido.`;
}

/** Los problemas de forma (zod), atados al bloque o al aviso por su posición en el spec. */
export function problemsFromZod(issues: ZodIssue[], raw: unknown): EditorProblem[] {
  const spec = (raw ?? {}) as {
    blocks?: Array<{ id?: unknown }>;
    alerts?: Array<{ id?: unknown }>;
  };
  return issues.slice(0, 20).map((issue) => {
    const [head, index] = issue.path;
    const message = zodMessage(issue);
    if (head === 'blocks' && typeof index === 'number') {
      const id = spec.blocks?.[index]?.id;
      return typeof id === 'string' ? { blockId: id, message } : { message };
    }
    if (head === 'alerts' && typeof index === 'number') {
      const id = spec.alerts?.[index]?.id;
      return typeof id === 'string' ? { alertId: id, message } : { message };
    }
    return { message };
  });
}

const BLOCK_PREFIX = /^Bloque «([^»]+)»:\s*/;
const ALERT_PREFIX = /^Alerta «([^»]+)»:\s*/;

/** Los problemas del catálogo (`checkSpecAgainst`), que ya nombran su bloque o alerta. */
export function problemsFromCheck(messages: string[]): EditorProblem[] {
  return messages.map((raw) => {
    const block = raw.match(BLOCK_PREFIX);
    if (block?.[1])
      return { blockId: block[1], message: humanizeOps(raw.replace(BLOCK_PREFIX, '')) };
    const alert = raw.match(ALERT_PREFIX);
    if (alert?.[1])
      return { alertId: alert[1], message: humanizeOps(raw.replace(ALERT_PREFIX, '')) };
    // El de `editing` habla del contrato; aquí se dice con lo que la persona controla.
    if (raw.includes('`editing`'))
      return {
        message:
          'Hay columnas editables, tableros que se arrastran o botones, pero nadie tiene permiso para usarlos. En «Ajustes de la vista», elige quién puede editar.',
      };
    return { message: humanizeOps(raw) };
  });
}

export function problemsByBlock(problems: EditorProblem[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const p of problems) {
    if (!p.blockId) continue;
    map.set(p.blockId, [...(map.get(p.blockId) ?? []), p.message]);
  }
  return map;
}
