import { type TrackerField, displayTrackerValue } from '../trackers/schema';
import { computeCards } from './cards';
import { type EmbedProvider, embedSrc, httpsUrl, safeHref } from './embeds';
import { buildDetail, findDetailTarget } from './record';
import type { RecordHistoryRaw } from './record';
import {
  APPROVE_ACTION_ID,
  type Aggregate,
  BLOCK_LABEL,
  type CatalogTracker,
  type ChartKind,
  type FormApproval,
  type FormVoiceMode,
  type Period,
  REJECT_ACTION_ID,
  type RowAction,
  type Tone,
  type ViewBlock,
  type ViewFilter,
  type ViewSpec,
  editWindowOf,
  fieldType,
  formVoiceOf,
  isReadOnlySource,
} from './spec';
import type { FilterBarValue, ViewFilterState } from './view-filters';

/**
 * DE SPEC A PANTALLA, SIN RED Y SIN REACT.
 *
 * `computeView` recibe el spec, las tablas y sus filas ya leídas, y devuelve
 * cada bloque con sus números resueltos y sus textos ya formateados. Es una
 * función pura a propósito:
 *
 *   - la misma salida sirve a la vista dentro de la app, al enlace público y a
 *     la vista previa del editor, que pinta un spec que todavía no se guardó;
 *   - el componente que pinta es tonto y puede vivir en el cliente sin
 *     importar el barril de `@cortex/agent-tools` (que arrastra `node:dns`);
 *   - se prueba con filas de mentira, sin base.
 *
 * Lo que sale de aquí es JSON plano. Ningún bloque devuelve filas que su spec
 * no pidió: una tabla con tres columnas entrega tres columnas, no la fila
 * entera, porque este objeto viaja hasta el navegador de alguien sin cuenta.
 *
 * LA FICHA DE UNA FILA (`record`), Y POR QUÉ VIAJA AQUÍ Y NO POR UNA RUTA
 * APARTE. Al tocar una fila de una tabla, tablero, plano, galería o
 * calendario se abre su ficha con más campos que los que el bloque pinta. Se
 * pensaron dos caminos:
 *
 *   1. Una ruta nueva «dame la fila X del bloque Y de la vista Z», que
 *      tendría que repetir TODAS las puertas de la página —sesión o token,
 *      cookie de la contraseña, fuentes internas y personales, el Feed sólo
 *      para su dueño— y volver a leer hasta 2.000 filas por fuente en cada
 *      clic para encontrar una.
 *   2. Mandar la ficha junto con el cálculo, sólo para las filas que el
 *      bloque ya muestra (una tabla ≤ 200, una galería ≤ 48…), con sólo los
 *      campos declarados (`detailFields`, tope 16) y cada valor recortado.
 *
 * Se eligió la 2: no abre ninguna puerta nueva (los datos salen de las mismas
 * fuentes que `loadViewSources` ya filtró por audiencia y por dueño), no
 * cuesta una consulta por clic, y la ficha se abre al instante. Lo que cuesta
 * es peso en cada refresco, y por eso está acotado por bloque.
 *
 * Y una regla para afuera: si el spec no dice `detailFields`, la ficha de una
 * vista abierta por enlace (`audience: 'public'`) muestra SÓLO los campos que
 * el bloque ya pinta. Dentro del equipo, una tabla propia muestra todos sus
 * campos. Así, una vista que ya estaba compartida con tres columnas no empieza
 * a mostrar afuera el teléfono o las notas de cada fila porque apareció la
 * ficha: abrir más campos al enlace es una decisión escrita en el spec.
 */

export const VIEW_TIMEZONE = 'America/Bogota';

export interface ViewRow {
  id: string;
  label: string;
  values: Record<string, string | number>;
  created_at: string;
  updated_at: string;
  /**
   * Quién creó la fila (sólo en tablas propias). Lo lee el scope «own» de
   * las aplicaciones (apps/permissions.ts); no viaja a ningún bloque.
   */
  created_by?: string | null;
  /** El usuario externo de una app que creó la fila (0209). */
  created_by_app_user?: string | null;
}

export interface ViewSource {
  tracker: CatalogTracker;
  rows: ViewRow[];
  /** True cuando la lectura se cortó en el tope y hay más filas. */
  truncated: boolean;
  /**
   * Por qué esta fuente NO se leyó, cuando no se leyó a propósito: una fuente
   * interna pedida desde el enlace público, o una fuente de la plataforma que
   * no contestó. Cada bloque que la usa se pinta como aviso con esta frase, y
   * `rows` llega vacío — no filtrado, vacío: lo que no se leyó no puede viajar.
   */
  blocked?: string;
}

export type ValueFormat = 'number' | 'money' | 'percent';

interface BlockBase {
  id: string;
  width: 'full' | 'half' | 'third';
}

/** Lo que comparten el tablero y el plano. */
export interface BoardBody {
  title: string;
  /** El campo que se cambia al arrastrar, si se puede arrastrar. */
  dragField: string | null;
  actions: ComputedAction[];
  record: ComputedRecords | null;
  columns: Array<{
    key: string;
    label: string;
    count: number;
    cards: Array<{
      id: string;
      label: string;
      details: ComputedDetail[];
      alert?: boolean;
    }>;
  }>;
  source: string;
}

export type ComputedBlock =
  | (BlockBase & { type: 'text'; markdown: string })
  | (BlockBase & {
      type: 'metric';
      title: string;
      value: number | null;
      display: string;
      rows: number;
      goal: {
        value: number;
        display: string;
        ratio: number;
        /** Hacia dónde es bueno ir: piso (`up`) o techo (`down`). */
        direction?: 'up' | 'down';
        /** Semáforo: verde, ámbar, rojo. Null si la cifra no tiene valor. */
        status?: GoalStatus | null;
      } | null;
      tone: Tone;
      caption: string | null;
      source: string;
      /** Contra el período anterior, si el spec lo pide (`compare`). */
      compare: ComputedCompare | null;
    })
  | (BlockBase & {
      type: 'table';
      title: string;
      columns: Array<{
        key: string;
        label: string;
        kind: 'text' | 'number' | 'date';
        /** `file` o `location`: la pantalla pinta miniatura o enlace al mapa con el valor crudo (`sort`). */
        rich?: RichKind;
        /** Presente sólo si la columna se edita Y quien mira puede escribir. */
        edit?: ComputedEditMeta;
      }>;
      rows: Array<{
        id: string;
        cells: string[];
        sort: Array<string | number | null>;
        /** La fila lleva la marca de duplicado de la tabla: se resalta. */
        alert?: boolean;
      }>;
      total: number;
      searchable: boolean;
      source: string;
      actions: ComputedAction[];
      record: ComputedRecords | null;
    })
  | (BlockBase & {
      type: 'chart';
      title: string;
      chart: ChartKind;
      points: Array<{ label: string; value: number; display: string }>;
      /** Sólo en `heatmap`: filas lunes…domingo, columnas 0–23 h. */
      heat?: ComputedHeat;
      total: string;
      tone: Tone;
      source: string;
    })
  | (BlockBase & BoardBody & { type: 'board' })
  | (BlockBase &
      BoardBody & {
        type: 'zones';
        /** Dónde va cada zona en la rejilla de 12×12. */
        layout: Array<{ zone: string; x: number; y: number; w: number; h: number }>;
      })
  | (BlockBase & {
      type: 'form';
      title: string;
      intro: string | null;
      tracker: string;
      submitLabel: string;
      successMessage: string;
      /** Minutos para «Corregir» lo enviado; 0 = no se corrige. */
      editWindowMinutes?: number;
      /** Pasos con los campos que pide cada uno; null/ausente = una sola pantalla. */
      steps?: Array<{ title: string; fields: string[] }> | null;
      /** Cómo se llena hablando: `off` | `dictate` (por defecto) | `conversation`. */
      voice?: FormVoiceMode;
      fields: ComputedFormField[];
    })
  | (BlockBase & {
      type: 'gallery';
      title: string;
      columns: 2 | 3 | 4;
      cards: Array<{
        id: string;
        title: string;
        subtitle: string | null;
        meta: ComputedDetail[];
        badge: { label: string; tone: Tone } | null;
        alert?: boolean;
        /** Sólo una dirección `https:` pública; cualquier otra cosa llega null. */
        image: string | null;
      }>;
      total: number;
      source: string;
      actions: ComputedAction[];
      record: ComputedRecords | null;
    })
  | (BlockBase & {
      type: 'calendar';
      title: string;
      mode: 'month' | 'agenda' | 'week' | 'day';
      /** Los modos entre los que la persona elige (día / semana / mes); vacío = fijo. */
      modes?: Array<'day' | 'week' | 'month'>;
      /** Hoy en Bogotá, AAAA-MM-DD. */
      today: string;
      /** Lo que el cálculo cubre: el navegador no navega fuera de aquí. */
      range: { from: string; to: string };
      /** Meses navegables (AAAA-MM), del más viejo al más nuevo. */
      months: string[];
      events: Array<{
        id: string;
        day: string;
        label: string;
        /** HH:MM si el spec nombra un campo de hora y la fila lo trae. */
        time?: string | null;
        tag: string | null;
        tone: Tone | null;
      }>;
      legend: Array<{ label: string; tone: Tone }>;
      /** Eventos en el rango que no cupieron en el tope. */
      hidden: number;
      source: string;
      actions: ComputedAction[];
      record: ComputedRecords | null;
    })
  | (BlockBase & ComputedCards)
  | (BlockBase & ComputedRecordDetail)
  | (BlockBase & {
      type: 'progress';
      title: string;
      tone: Tone;
      /** Sin meta: cada barra se mide contra la más grande. */
      relative: boolean;
      items: Array<{
        label: string;
        value: number;
        display: string;
        target: number | null;
        targetDisplay: string | null;
        /** 0–n (puede pasar de 1: la meta se superó). */
        ratio: number;
      }>;
      source: string;
    })
  | (BlockBase & {
      type: 'media';
      title: string | null;
      kind: 'image' | 'embed';
      /** Ya validada y, en las inserciones, traducida a la del servicio. Null = sin dirección. */
      src: string | null;
      provider: EmbedProvider | null;
      alt: string | null;
      caption: string | null;
      aspect: '16:9' | '4:3' | '1:1' | '3:4';
    })
  | (BlockBase & {
      type: 'links';
      title: string | null;
      style: 'buttons' | 'cards';
      links: Array<{
        label: string;
        href: string;
        external: boolean;
        description: string | null;
        tone: Tone;
      }>;
    })
  | (BlockBase & {
      type: 'voice';
      title: string | null;
      /** El id del bloque `form` de esta vista que el asistente maneja. */
      form: string;
      autoStart: boolean;
    })
  | (BlockBase & { type: 'problem'; title: string; message: string });

/** La lista de tarjetas con filtros rápidos (ver `cardsBlockSchema`). */
export interface ComputedCards {
  type: 'cards';
  title: string;
  source: string;
  /** Hoy y la semana (lunes a domingo) en Bogotá: contra ellos corren «hoy» y «semana». */
  today: string;
  week: { from: string; to: string };
  total: number;
  cards: Array<{
    id: string;
    title: string;
    subtitle: string | null;
    /** `url`: una dirección https; `file`: el valor crudo de un campo de archivos. */
    image: { kind: 'url'; url: string } | { kind: 'file'; raw: string } | null;
    status: { label: string; tone: Tone } | null;
    data: ComputedDetail[];
    day: string | null;
    mine: boolean;
    group: string | null;
    sort: Array<string | number | null>;
    alert?: boolean;
  }>;
  /** Los chips que se pintan (los que el spec pidió y se pueden resolver). */
  chips: Array<'status' | 'today' | 'week' | 'mine'>;
  statusOptions: Array<{ label: string; tone: Tone }>;
  searchable: boolean;
  groupLabel: string | null;
  sortOptions: Array<{ label: string; dir: 'asc' | 'desc' }>;
  defaultSort: { index: number; dir: 'asc' | 'desc' } | null;
  pageSize: number;
  paging: 'more' | 'infinite';
  actions: ComputedAction[];
  record: ComputedRecords | null;
}

/** Un renglón de la línea de tiempo de un registro. */
export interface ComputedTimelineEntry {
  id: string;
  at: string;
  kind: 'created' | 'changed' | 'approval' | 'action' | 'automation' | 'file';
  /** Quién (nombre, «Tú», «El equipo»); null si no se sabe. */
  actor: string | null;
  title: string;
  changes?: Array<{ label: string; from: string; to: string }>;
  files?: Array<{ label: string; names: string[] }>;
  ok?: boolean;
}

export interface ComputedDetailItem extends ComputedDetail {
  key: string;
  /** Presente sólo si el campo se edita desde el detalle Y quien mira puede escribir. */
  edit?: ComputedEditMeta;
  editRaw?: string | number | null;
}

/** El detalle de un registro (ver `detailBlockSchema`). */
export interface ComputedRecordDetail {
  type: 'detail';
  title: string;
  source: string;
  /** `idle`: no hay fila elegida; `missing`: la fila no existe o no se ve; `ready`. */
  state: 'idle' | 'missing' | 'ready';
  rowId: string | null;
  header: {
    title: string;
    subtitle: string | null;
    status: { label: string; tone: Tone } | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  sections: Array<{ title: string; items: ComputedDetailItem[] }>;
  gallery: Array<{ key: string; label: string; raw: string }>;
  related: Array<{
    /** `<detalle>:<lista>`: el id con el que se escribe sobre sus filas. */
    blockKey: string;
    title: string;
    source: string;
    columns: Array<{ key: string; label: string }>;
    rows: Array<{ id: string; cells: string[]; alert?: boolean }>;
    total: number;
    actions: ComputedAction[];
    /** El bloque detalle al que abre una fila de esta lista, si hay uno para su tabla. */
    opens: string | null;
    problem: string | null;
  }>;
  actions: ComputedAction[];
  timeline: ComputedTimelineEntry[] | null;
}

export type GoalStatus = 'good' | 'warn' | 'bad';

export interface ComputedHeat {
  rows: string[];
  max: number;
  cells: Array<Array<{ value: number; display: string }>>;
}

/**
 * El semáforo de una meta. Con la meta como piso (`up`): verde al llegar,
 * ámbar desde el 70 %, rojo debajo. Como techo (`down`): verde mientras no la
 * pase, ámbar hasta un 20 % por encima, rojo más allá.
 */
export function goalStatus(
  value: number | null,
  goal: number,
  direction: 'up' | 'down',
): GoalStatus | null {
  if (value === null || !Number.isFinite(value) || goal === 0) return null;
  if (direction === 'up') {
    const ratio = value / goal;
    return ratio >= 1 ? 'good' : ratio >= 0.7 ? 'warn' : 'bad';
  }
  return value <= goal ? 'good' : value <= goal * 1.2 ? 'warn' : 'bad';
}

/** Lunes = 0 … domingo = 6, y la hora, en Bogotá. Null si no se puede leer. */
export function weekdayHour(
  value: string,
  hourFrom?: string,
): { weekday: number; hour: number } | null {
  let weekday: number;
  let hour = 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    weekday = (new Date(`${value}T12:00:00Z`).getUTCDay() + 6) % 7;
  } else {
    const t = Date.parse(value);
    if (Number.isNaN(t)) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: VIEW_TIMEZONE,
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(t));
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
    weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd);
    if (weekday < 0) return null;
    hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  }
  if (hourFrom !== undefined) {
    const m = /^(\d{1,2}):\d{2}/.exec(hourFrom);
    if (!m) return null;
    hour = Number(m[1]);
  }
  return { weekday, hour };
}

export const WEEKDAY_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'] as const;

/** El KPI contra el período anterior. */
export interface ComputedCompare {
  period: Period;
  /** «Este mes», «Esta semana», «Hoy». */
  currentLabel: string;
  /** «vs. mes anterior». */
  previousLabel: string;
  previous: number | null;
  previousDisplay: string;
  /** Cambio relativo (0.12 = +12 %). Null si el anterior es 0 o no hay dato. */
  delta: number | null;
  direction: 'up' | 'down' | 'flat';
  /** Si el cambio es bueno según `goodWhen`. Null si no cambió o no se sabe. */
  good: boolean | null;
  /** Los últimos períodos, del más viejo al actual. */
  series: Array<{ label: string; value: number }>;
}

/**
 * La ficha de las filas que un bloque muestra (ver el comentario de arriba).
 * `fields` una vez por bloque; por fila, los valores en ese mismo orden.
 */
export interface ComputedRecords {
  /**
   * El bloque `detail` que abre estas filas (su tabla tiene uno en la vista):
   * tocar una fila va a `?fila=<id>` en vez de abrir la ficha lateral.
   */
  detail?: string;
  fields: Array<{
    key: string;
    label: string;
    kind: 'text' | 'number' | 'date';
    /** Presente sólo si el campo se edita desde la ficha Y quien mira puede escribir. */
    edit?: ComputedEditMeta;
  }>;
  rows: Record<
    string,
    {
      label: string;
      values: string[];
      raw: Array<string | number | null>;
      createdAt: string;
      updatedAt: string;
    }
  >;
}

export interface ComputedFilterBarItem {
  id: string;
  label: string;
  kind: 'select' | 'date_range' | 'search';
  /** El nombre de la fuente, para decir a qué bloques afecta. */
  source: string;
  /** Las opciones del menú (`select`). */
  options: string[];
  value: FilterBarValue | null;
}

export interface ComputedTheme {
  accent: Tone;
  density: 'comfortable' | 'compact';
  header: 'plain' | 'hero';
  layout: 'dashboard' | 'operator' | 'tv';
  style: 'clean' | 'bold' | 'dark-panel';
  cover: string | null;
  /** Presente con `layout: 'tv'`: la rotación y el reloj. */
  tv?: { rotateSeconds: number; clock: boolean };
}

/** Valores que la pantalla pinta distinto a un texto: fotos/archivos y ubicaciones. */
export type RichKind = 'file' | 'location';

/** Un renglón de tarjeta; `kind` + `raw` sólo en archivos y ubicaciones. */
export interface ComputedDetail {
  label: string;
  value: string;
  kind?: RichKind;
  raw?: string;
}

/** Un botón por fila, sin el valor que escribe: ése lo decide el servidor. */
export interface ComputedAction {
  id: string;
  label: string;
  kind: 'set_field' | 'notify';
  confirm: boolean;
  tone: Tone;
  /** Si viene, el botón sólo aparece en estas filas (Aprobar / Rechazar: las pendientes). */
  rowIds?: string[];
  /** Pide un motivo (opcional) antes de ejecutar. */
  askReason?: boolean;
}

/**
 * Lo necesario para darse cuenta de que entró algo: por alerta, las filas más
 * recientes que cumplen sus filtros (id, nombre, cuándo). El navegador compara
 * con el refresco anterior; el servidor no lleva la cuenta de quién vio qué.
 */
export interface ComputedAlertFeed {
  id: string;
  source: string;
  message: string | null;
  sound: boolean;
  desktop: boolean;
  on: 'new' | 'change' | 'both';
  /** `rev` es la huella de la fila (su última actualización): si cambia, la fila cambió. */
  rows: Array<{ id: string; label: string; createdAt: string; rev: string }>;
}

/** Lo que el navegador necesita para validar una celda que se edita en el sitio. */
export type ComputedEditMeta = Pick<
  TrackerField,
  'type' | 'min' | 'max' | 'minLength' | 'maxLength' | 'format' | 'pattern' | 'message'
> & { options: string[]; required: boolean };

/**
 * Un campo del formulario con todo lo que el navegador necesita para validar,
 * mostrar u ocultar y pre-llenar. `unique` no viaja: sólo el servidor puede
 * saber si el valor ya existe.
 */
export type ComputedFormField = Pick<
  TrackerField,
  | 'key'
  | 'label'
  | 'type'
  | 'min'
  | 'max'
  | 'minLength'
  | 'maxLength'
  | 'format'
  | 'pattern'
  | 'message'
  | 'default'
  | 'help'
  | 'placeholder'
  | 'example'
  | 'showIf'
  | 'accept'
  | 'multiple'
  | 'tracker'
  | 'scan'
> & { required: boolean; options: string[] };

export interface ComputedView {
  blocks: ComputedBlock[];
  computedAt: string;
  /** Tablas cuya lectura se cortó en el tope: las cifras son parciales. */
  partial: string[];
  refreshSeconds: number;
  /** Si quien mira puede editar y usar botones en esta vista. */
  writable: boolean;
  alerts: ComputedAlertFeed[];
  /** La barra de filtros con lo elegido. Vacía si el spec no tiene barra. */
  filtersBar?: ComputedFilterBarItem[];
  /** Pestañas; cada bloque está en exactamente una. Vacío = una sola página. */
  pages?: Array<{ id: string; title: string; blockIds: string[] }>;
  theme?: ComputedTheme;
  /** El registro abierto (`?fila=`): qué detalle y qué fila. Ausente = ninguno. */
  record?: { blockId: string; rowId: string; found: boolean } | null;
}

// ---------------------------------------------------------------------------
// Fechas en Bogotá
// ---------------------------------------------------------------------------

export function todayIn(now: Date, tz = VIEW_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayOf(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : todayIn(new Date(t));
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function viewShortDate(isoDay: string): string {
  const [y, m, d] = isoDay.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

const NUMBER = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
const MONEY = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export function formatValue(value: number | null, format: ValueFormat): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (format === 'money') return MONEY.format(value);
  if (format === 'percent') return `${NUMBER.format(value)} %`;
  return NUMBER.format(value);
}

function rawValue(row: ViewRow, key: string): string | number | undefined {
  if (key === 'label') return row.label;
  if (key === 'created_at') return dayOf(row.created_at) ?? undefined;
  if (key === 'updated_at') return dayOf(row.updated_at) ?? undefined;
  const v = row.values[key];
  return v === '' ? undefined : v;
}

function displayValue(tracker: CatalogTracker, row: ViewRow, key: string): string {
  const v = rawValue(row, key);
  if (v === undefined) return '—';
  const type = fieldType(tracker, key);
  if (type === 'checkbox') return Number(v) === 1 ? 'Sí' : 'No';
  if (type === 'file' || type === 'relation') return displayTrackerValue({ type }, v) || '—';
  if (type === 'money') return formatValue(Number(v), 'money');
  if (type === 'number') return formatValue(Number(v), 'number');
  if (
    (type === 'date' || type === 'builtin_date') &&
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v)
  )
    return viewShortDate(v);
  return String(v);
}

/** ¿Esta fila lleva la marca de la regla de duplicados de su tabla? */
function isAlertRow(tracker: CatalogTracker, row: ViewRow): boolean {
  const flag = tracker.alertFlag;
  return Boolean(flag && String(row.values[flag.field] ?? '') === flag.value);
}

function fieldLabel(tracker: CatalogTracker, key: string): string {
  if (key === 'label') return 'Nombre';
  if (key === 'created_at') return 'Creado';
  if (key === 'updated_at') return 'Actualizado';
  return tracker.fields.find((f) => f.key === key)?.label ?? key;
}

// ---------------------------------------------------------------------------
// Filtros y agregados
// ---------------------------------------------------------------------------

export function matches(
  tracker: CatalogTracker,
  row: ViewRow,
  filter: ViewFilter,
  today: string,
): boolean {
  const v = rawValue(row, filter.field);
  const type = fieldType(tracker, filter.field);
  const isNumeric = type === 'number' || type === 'money';
  const isDate = type === 'date' || type === 'builtin_date';

  switch (filter.op) {
    case 'empty':
      return v === undefined;
    case 'not_empty':
      return v !== undefined;
    case 'eq':
    case 'neq': {
      const equal =
        v !== undefined &&
        (isNumeric
          ? Number(v) === Number(filter.value)
          : String(v).trim().toLowerCase() === String(filter.value).trim().toLowerCase());
      return filter.op === 'eq' ? equal : !equal;
    }
    case 'contains':
      return (
        v !== undefined &&
        String(v).toLowerCase().includes(String(filter.value).trim().toLowerCase())
      );
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (v === undefined) return false;
      const cmp = isNumeric
        ? Number(v) - Number(filter.value)
        : String(v).localeCompare(String(filter.value));
      if (Number.isNaN(cmp)) return false;
      if (filter.op === 'gt') return cmp > 0;
      if (filter.op === 'gte') return cmp >= 0;
      if (filter.op === 'lt') return cmp < 0;
      return cmp <= 0;
    }
    case 'before_today':
    case 'after_today':
    case 'next_days':
    case 'last_days': {
      if (!isDate || typeof v !== 'string') return false;
      const day = dayOf(v);
      if (!day) return false;
      if (filter.op === 'before_today') return day < today;
      if (filter.op === 'after_today') return day > today;
      const n = Math.max(0, Math.floor(Number(filter.value)));
      if (filter.op === 'next_days') return day >= today && day <= addDays(today, n);
      return day <= today && day >= addDays(today, -n);
    }
  }
}

export function aggregate(rows: ViewRow[], agg: Aggregate, field?: string): number | null {
  if (agg === 'count') return rows.length;
  if (!field) return null;
  const nums = rows
    .map((r) => r.values[field])
    .filter((v) => v !== undefined && v !== '')
    .map(Number)
    .filter(Number.isFinite);
  if (nums.length === 0) return agg === 'sum' ? 0 : null;
  if (agg === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (agg === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (agg === 'min') return Math.min(...nums);
  return Math.max(...nums);
}

function formatOf(tracker: CatalogTracker, field: string | undefined, fallback: ValueFormat) {
  if (fallback !== 'number' || !field) return fallback;
  return fieldType(tracker, field) === 'money' ? 'money' : 'number';
}

function bucketOf(day: string, bucket: 'day' | 'week' | 'month'): string {
  if (bucket === 'day') return day;
  if (bucket === 'month') return day.slice(0, 7);
  const d = new Date(`${day}T12:00:00Z`);
  const weekday = (d.getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
}

function bucketLabel(key: string, bucket: 'day' | 'week' | 'month'): string {
  if (bucket === 'month') {
    const [y, m] = key.split('-');
    return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
  }
  return bucket === 'week' ? `sem. ${viewShortDate(key)}` : viewShortDate(key);
}

// ---------------------------------------------------------------------------
// Períodos: el KPI contra el anterior y el calendario
// ---------------------------------------------------------------------------

function addMonths(isoMonth: string, n: number): string {
  const [y = 1970, m = 1] = isoMonth.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1, 12)).toISOString().slice(0, 7);
}

function lastDayOfMonth(isoMonth: string): string {
  return addDays(`${addMonths(isoMonth, 1)}-01`, -1);
}

function shiftBucket(key: string, period: Period, n: number): string {
  if (period === 'month') return addMonths(key, n);
  return addDays(key, period === 'week' ? 7 * n : n);
}

const PERIOD_NOW: Record<Period, string> = { day: 'Hoy', week: 'Esta semana', month: 'Este mes' };
const PERIOD_PREV: Record<Period, string> = {
  day: 'vs. ayer',
  week: 'vs. semana anterior',
  month: 'vs. mes anterior',
};
/** Cuántos períodos dibuja la línea del KPI. */
const SERIES_LENGTH: Record<Period, number> = { day: 12, week: 10, month: 12 };

/**
 * El tono de la opción `i` de un campo de opciones: siempre el mismo para la
 * misma posición. En un orden propio y no el de `TONES`: en el tema claro el
 * índigo de la marca y el verde quedan cerca, y dos categorías seguidas no
 * pueden parecer la misma.
 */
const CATEGORY_TONES: readonly Tone[] = ['sky', 'amber', 'emerald', 'rose', 'primary'];
function toneAt(i: number): Tone {
  return CATEGORY_TONES[i % CATEGORY_TONES.length] as Tone;
}

// ---------------------------------------------------------------------------
// Bloques
// ---------------------------------------------------------------------------

function problem(block: ViewBlock, message: string): ComputedBlock {
  return {
    type: 'problem',
    id: block.id,
    width: block.width,
    title: ('title' in block && block.title) || BLOCK_LABEL[block.type] || 'Bloque',
    message,
  };
}

/**
 * Dónde va cada zona. Las que el spec ubicó, donde dijo; las demás (y «Sin
 * estado») se acomodan solas debajo, de a tres por fila, sin pisar nada.
 */
export function zoneLayout(
  placed: Array<{ zone: string; x: number; y: number; w: number; h: number }>,
  zones: string[],
): Array<{ zone: string; x: number; y: number; w: number; h: number }> {
  const out = placed.filter((p) => zones.includes(p.zone));
  let nextY = out.reduce((max, p) => Math.max(max, p.y + p.h), 0);
  const missing = zones.filter((z) => !out.some((p) => p.zone === z));
  missing.forEach((zone, i) => {
    out.push({ zone, x: (i % 3) * 4, y: nextY, w: 4, h: 2 });
    if (i % 3 === 2) nextY += 2;
  });
  return out;
}

function toAction(a: RowAction): ComputedAction {
  return { id: a.id, label: a.label, kind: a.kind, confirm: a.confirm, tone: a.tone };
}

/**
 * Los botones de un bloque: los del spec y, si un formulario con aprobación
 * alimenta la MISMA tabla, Aprobar / Rechazar — sólo en las filas que siguen
 * en el estado pendiente (`rowIds`). Sólo con quien puede escribir.
 */
function actionsFor(
  opts: ComputeOptions,
  actions: RowAction[],
  tracker: CatalogTracker,
  shown: ViewRow[],
): ComputedAction[] {
  if (!opts.writable) return [];
  const out = actions.map(toAction);
  const approval = opts.approval?.get(tracker.slug);
  if (approval) {
    const rowIds = shown
      .filter((r) => String(r.values[approval.field] ?? '') === approval.pending)
      .map((r) => r.id);
    out.push(
      {
        id: APPROVE_ACTION_ID,
        label: 'Aprobar',
        kind: 'set_field',
        confirm: false,
        tone: 'emerald',
        rowIds,
      },
      {
        id: REJECT_ACTION_ID,
        label: 'Rechazar',
        kind: 'set_field',
        confirm: false,
        tone: 'rose',
        rowIds,
        askReason: Boolean(approval.notesField),
      },
    );
  }
  return out;
}

export interface ComputeOptions {
  /** Aprobación por tabla (slug → formulario con `approval`); la arma `computeView`. */
  approval?: Map<string, FormApproval>;
  /** Quien mira puede editar y usar botones (lo decide el servidor, no el spec). */
  writable: boolean;
  /**
   * `public` para el enlace (/v/<token>): sin `detailFields` en el spec, la
   * ficha muestra sólo lo que el bloque ya pinta (ver el comentario de arriba).
   */
  audience: 'team' | 'public';
  /** Lo elegido en la barra de filtros, ya validado (`parseViewFilterParam`). */
  filters: ViewFilterState;
  /**
   * Quién mira, para «mis tarjetas»: el id de un miembro o de un usuario
   * externo de la app. Sin él (enlace público), el chip «mío» no se ofrece.
   */
  viewer?: { id: string; kind: 'member' | 'app_user' } | null;
  /**
   * El registro abierto (`?fila=`): lo resuelve `loadRecordContext` (con su
   * línea de tiempo leída de la base). Sin esto, los detalles quedan en reposo.
   */
  record?: { rowId: string; blockId?: string | null; history?: RecordHistoryRaw | null } | null;
  /** tabla → bloque `detail` que abre sus filas; lo arma `computeView`. */
  details?: Map<string, string>;
  /** id de botón → su rótulo, para nombrar «usó el botón X» en la línea de tiempo. */
  actionLabels?: Map<string, string>;
}

/** Si el campo se pinta con algo más que texto (foto, mapa). */
function richKind(tracker: CatalogTracker, key: string): RichKind | null {
  const t = fieldType(tracker, key);
  return t === 'file' || t === 'location' ? t : null;
}

/** Renglón de tarjeta: el texto y, si es archivo o ubicación, el valor crudo. */
function detailOf(tracker: CatalogTracker, row: ViewRow, key: string): ComputedDetail {
  const kind = richKind(tracker, key);
  const raw = kind ? rawValue(row, key) : undefined;
  return {
    label: fieldLabel(tracker, key),
    value: displayValue(tracker, row, key),
    ...(kind && raw !== undefined ? { kind, raw: String(raw) } : {}),
  };
}

function columnKind(tracker: CatalogTracker, key: string): 'text' | 'number' | 'date' {
  const t = fieldType(tracker, key);
  return t === 'number' || t === 'money'
    ? 'number'
    : t === 'date' || t === 'builtin_date'
      ? 'date'
      : 'text';
}

function editMeta(tracker: CatalogTracker, key: string) {
  const field = tracker.fields.find((f) => f.key === key);
  if (!field) return undefined;
  const meta: ComputedEditMeta = {
    type: field.type,
    options: field.options ?? [],
    required: field.required,
  };
  for (const k of ['min', 'max', 'minLength', 'maxLength', 'format', 'pattern', 'message'] as const)
    if (field[k] !== undefined) (meta as Record<string, unknown>)[k] = field[k];
  return meta;
}

function sortRows(
  tracker: CatalogTracker,
  rows: ViewRow[],
  sort: { field: string; dir: 'asc' | 'desc' } | undefined,
): ViewRow[] {
  const sortKey = sort?.field ?? 'updated_at';
  const dir = sort?.dir === 'asc' ? 1 : -1;
  const sortType = fieldType(tracker, sortKey);
  const numericSort = sortType === 'number' || sortType === 'money';
  return [...rows].sort((a, b) => {
    const va = rawValue(a, sortKey);
    const vb = rawValue(b, sortKey);
    if (va === undefined && vb === undefined) return 0;
    if (va === undefined) return 1;
    if (vb === undefined) return -1;
    const cmp = numericSort ? Number(va) - Number(vb) : String(va).localeCompare(String(vb), 'es');
    return cmp * dir;
  });
}

/** Tope de campos de una ficha y de largo de cada valor. */
const RECORD_MAX_FIELDS = 16;
const RECORD_VALUE_MAX = 500;
/** En una fuente de la plataforma o del Feed sin `detailFields`, la ficha trae estos. */
const READONLY_DEFAULT_FIELDS = 8;

type RecordBlock = Extract<
  ViewBlock,
  { type: 'table' | 'board' | 'zones' | 'gallery' | 'calendar' | 'cards' }
>;

/**
 * La ficha de las filas que el bloque muestra. `shown` son los campos que el
 * bloque ya pinta (lo único que sale afuera si el spec no dice más); `writes`,
 * los que el servidor deja escribir en este bloque (`editViewRow`).
 */
function buildRecords(
  block: RecordBlock,
  tracker: CatalogTracker,
  rows: ViewRow[],
  shown: string[],
  writes: string[],
  opts: ComputeOptions,
): ComputedRecords | null {
  if (block.openRecord === false || !rows.length) return null;
  const readOnly = isReadOnlySource(tracker.slug);
  const explicit = block.detailFields ?? [];
  const base = explicit.length
    ? explicit
    : opts.audience === 'public'
      ? shown
      : readOnly
        ? tracker.fields.slice(0, READONLY_DEFAULT_FIELDS).map((f) => f.key)
        : tracker.fields.map((f) => f.key);
  const editable = new Set(
    opts.writable && !readOnly ? writes.filter((k) => tracker.fields.some((f) => f.key === k)) : [],
  );
  const keys = [...new Set([...base, ...editable])]
    .filter((k) => k !== 'label' && k !== 'created_at' && k !== 'updated_at')
    .filter((k) => fieldType(tracker, k))
    .slice(0, RECORD_MAX_FIELDS + editable.size);
  const fields = keys.map((key) => ({
    key,
    label: fieldLabel(tracker, key),
    kind: columnKind(tracker, key),
    ...(editable.has(key) ? { edit: editMeta(tracker, key) } : {}),
  }));
  const out: ComputedRecords['rows'] = {};
  for (const r of rows) {
    out[r.id] = {
      label: r.label,
      values: keys.map((k) => {
        const v = displayValue(tracker, r, k);
        return v.length > RECORD_VALUE_MAX ? `${v.slice(0, RECORD_VALUE_MAX - 1)}…` : v;
      }),
      // El valor crudo sólo de lo que se edita: es lo que el control necesita.
      raw: keys.map((k) => (editable.has(k) ? (rawValue(r, k) ?? null) : null)),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  const detail = opts.details?.get(tracker.slug);
  return { ...(detail ? { detail } : {}), fields, rows: out };
}

/** Lo que un bloque deja escribir: la misma lista que `editViewRow` acepta. */
export function blockWriteFields(block: ViewBlock): string[] {
  const record = 'recordEditable' in block ? (block.recordEditable ?? []) : [];
  if (block.type === 'table') return [...new Set([...block.editable, ...record])];
  if (block.type === 'board' || block.type === 'zones')
    return [...new Set([...(block.draggable ? [block.groupBy] : []), ...record])];
  if (
    block.type === 'gallery' ||
    block.type === 'calendar' ||
    block.type === 'cards' ||
    block.type === 'detail'
  )
    return [...record];
  return [];
}

function compareMetric(
  block: Extract<ViewBlock, { type: 'metric' }>,
  rows: ViewRow[],
  today: string,
  format: ValueFormat,
): { value: number | null; rows: number; compare: ComputedCompare } {
  const period = block.period ?? 'month';
  const dateField = block.dateField ?? 'created_at';
  const groups = new Map<string, ViewRow[]>();
  for (const r of rows) {
    const v = rawValue(r, dateField);
    const day = typeof v === 'string' ? dayOf(v) : null;
    if (!day) continue;
    const key = bucketOf(day, period);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const value = (key: string) => aggregate(groups.get(key) ?? [], block.aggregate, block.field);
  const now = bucketOf(today, period);
  const current = value(now);
  const previous = value(shiftBucket(now, period, -1));
  const delta =
    current !== null && previous !== null && previous !== 0
      ? (current - previous) / Math.abs(previous)
      : null;
  const direction: ComputedCompare['direction'] =
    current === null || previous === null || current === previous
      ? 'flat'
      : current > previous
        ? 'up'
        : 'down';
  const n = SERIES_LENGTH[period];
  return {
    value: current,
    rows: groups.get(now)?.length ?? 0,
    compare: {
      period,
      currentLabel: PERIOD_NOW[period],
      previousLabel: PERIOD_PREV[period],
      previous,
      previousDisplay: formatValue(previous, format),
      delta,
      direction,
      good: direction === 'flat' ? null : direction === (block.goodWhen ?? 'up'),
      series: Array.from({ length: n }, (_, i) => {
        const key = shiftBucket(now, period, i - (n - 1));
        return { label: bucketLabel(key, period), value: value(key) ?? 0 };
      }),
    },
  };
}

/** La hora HH:MM de un evento, si el spec nombra un campo de hora y la fila lo trae. */
function eventTime(row: ViewRow, key: string | undefined): string | null {
  if (!key) return null;
  const v = rawValue(row, key);
  const m = typeof v === 'string' ? /^(\d{1,2}):(\d{2})/.exec(v.trim()) : null;
  return m ? `${String(m[1]).padStart(2, '0')}:${m[2]}` : null;
}

/** Cuántos eventos entrega el calendario como mucho (tres meses de agenda apretada). */
const CALENDAR_MAX_EVENTS = 300;

function computeBlock(
  block: ViewBlock,
  sources: Map<string, ViewSource>,
  today: string,
  opts: ComputeOptions,
): ComputedBlock {
  if (block.type === 'text') {
    return { type: 'text', id: block.id, width: block.width, markdown: block.markdown };
  }
  if (block.type === 'media') {
    // La dirección vuelve a pasar por su puerta aquí: un spec que llegó por
    // otro camino (una versión vieja, una fila editada a mano) tampoco pinta
    // nada que no sea https ni inserta nada fuera de la lista.
    const embed = block.kind === 'embed' && block.url ? embedSrc(block.url) : null;
    const src = block.kind === 'embed' ? (embed?.src ?? null) : httpsUrl(block.url);
    if (block.url && !src)
      return problem(
        block,
        block.kind === 'embed'
          ? 'Ese enlace no se puede insertar: sirven YouTube, Google Maps, Loom y Google Slides o Docs publicados.'
          : 'La imagen necesita una dirección https://.',
      );
    return {
      type: 'media',
      id: block.id,
      width: block.width,
      title: block.title ?? null,
      kind: block.kind,
      src,
      provider: embed?.provider ?? null,
      alt: block.alt ?? null,
      caption: block.caption ?? null,
      aspect: block.aspect,
    };
  }
  if (block.type === 'links') {
    return {
      type: 'links',
      id: block.id,
      width: block.width,
      title: block.title ?? null,
      style: block.style,
      links: block.links.flatMap((l) => {
        const safe = safeHref(l.href);
        return safe
          ? [
              {
                label: l.label,
                href: safe.href,
                external: safe.external,
                description: l.description ?? null,
                tone: l.tone,
              },
            ]
          : [];
      }),
    };
  }
  if (block.type === 'voice') {
    return {
      type: 'voice',
      id: block.id,
      width: block.width,
      title: block.title ?? null,
      form: block.form,
      autoStart: block.autoStart ?? false,
    };
  }
  const src = sources.get(block.tracker);
  if (!src) return problem(block, `La tabla «${block.tracker}» ya no existe en este espacio.`);
  if (src.blocked) return problem(block, src.blocked);
  // Un formulario escribe filas; una fuente de la plataforma o del Feed no las recibe. El
  // guardado ya lo rechaza (`checkSpecAgainst`), esto cubre un spec que llegue
  // por otro camino: se pinta el aviso, nunca un formulario que no puede enviar.
  if (block.type === 'form' && isReadOnlySource(block.tracker))
    return problem(
      block,
      `${src.tracker.name} es de sólo lectura: un formulario no puede escribir ahí.`,
    );
  const { tracker } = src;
  const opt = (k: string | undefined) => (k ? [k] : []);
  const missing = [
    ...('filters' in block ? block.filters.map((f) => f.field) : []),
    ...('detailFields' in block ? (block.detailFields ?? []) : []),
    ...(block.type === 'table'
      ? [...block.columns, ...(block.sort ? [block.sort.field] : [])]
      : []),
    ...(block.type === 'chart' || block.type === 'board' || block.type === 'zones'
      ? [block.groupBy]
      : []),
    ...(block.type === 'board' || block.type === 'zones' ? block.cardFields : []),
    ...(block.type === 'form' ? block.fields : []),
    ...((block.type === 'metric' || block.type === 'chart' || block.type === 'progress') &&
    block.field
      ? [block.field]
      : []),
    ...(block.type === 'metric' && block.compare ? opt(block.dateField) : []),
    ...(block.type === 'chart' ? opt(block.hourField) : []),
    ...(block.type === 'progress' ? opt(block.groupBy) : []),
    ...(block.type === 'gallery'
      ? [
          block.titleField,
          ...opt(block.subtitleField),
          ...block.metaFields,
          ...opt(block.badgeField),
          ...opt(block.imageField),
          ...(block.sort ? [block.sort.field] : []),
        ]
      : []),
    ...(block.type === 'calendar'
      ? [block.dateField, block.labelField, ...opt(block.colorField), ...opt(block.timeField)]
      : []),
    ...(block.type === 'cards'
      ? [
          block.titleField,
          ...opt(block.subtitleField),
          ...opt(block.imageField),
          ...opt(block.statusField),
          ...opt(block.dateField),
          ...opt(block.groupBy),
          ...block.dataFields,
          ...block.sortOptions,
          ...(block.sort ? [block.sort.field] : []),
        ]
      : []),
    ...(block.type === 'detail'
      ? [
          block.titleField,
          ...opt(block.subtitleField),
          ...opt(block.statusField),
          ...block.sections.flatMap((sec) => sec.fields),
          ...block.gallery,
        ]
      : []),
  ].filter((key) => !fieldType(tracker, key));
  if (missing.length) {
    return problem(
      block,
      `${tracker.name} ya no tiene ${missing.length === 1 ? 'el campo' : 'los campos'} ${missing.map((m) => `«${m}»`).join(', ')}. Pídele a Cortex que ajuste este bloque.`,
    );
  }

  const rows =
    'filters' in block && block.filters.length
      ? src.rows.filter((r) => block.filters.every((f) => matches(tracker, r, f, today)))
      : src.rows;
  const writes = blockWriteFields(block);

  switch (block.type) {
    case 'metric': {
      const format = formatOf(tracker, block.field, block.format);
      const compared =
        block.compare === 'previous_period' ? compareMetric(block, rows, today, format) : null;
      const value = compared ? compared.value : aggregate(rows, block.aggregate, block.field);
      const count = compared ? compared.rows : rows.length;
      return {
        type: 'metric',
        id: block.id,
        width: block.width,
        title: block.title,
        value,
        display: formatValue(value, format),
        rows: count,
        goal:
          block.goal !== undefined && block.goal !== 0
            ? {
                value: block.goal,
                display: formatValue(block.goal, format),
                ratio: value === null ? 0 : value / block.goal,
                direction: block.goalDirection ?? 'up',
                status: goalStatus(value, block.goal, block.goalDirection ?? 'up'),
              }
            : null,
        tone: block.tone,
        caption: block.caption ?? null,
        source: tracker.name,
        compare: compared?.compare ?? null,
      };
    }

    case 'table': {
      const keys = block.columns.length
        ? block.columns
        : ['label', ...tracker.fields.slice(0, 5).map((f) => f.key)];
      const shown = sortRows(tracker, rows, block.sort).slice(0, block.limit);
      return {
        type: 'table',
        id: block.id,
        width: block.width,
        title: block.title,
        columns: keys.map((key) => {
          const field = tracker.fields.find((f) => f.key === key);
          return {
            key,
            label: fieldLabel(tracker, key),
            kind: columnKind(tracker, key),
            ...(richKind(tracker, key) ? { rich: richKind(tracker, key) as RichKind } : {}),
            ...(opts.writable && field && block.editable.includes(key)
              ? { edit: editMeta(tracker, key) }
              : {}),
          };
        }),
        rows: shown.map((r) => ({
          id: r.id,
          cells: keys.map((key) => displayValue(tracker, r, key)),
          ...(isAlertRow(tracker, r) ? { alert: true } : {}),
          sort: keys.map((key) => {
            const v = rawValue(r, key);
            return v === undefined ? null : v;
          }),
        })),
        total: rows.length,
        searchable: block.searchable,
        source: tracker.name,
        actions: actionsFor(opts, block.actions, tracker, shown),
        record: buildRecords(block, tracker, shown, keys, writes, opts),
      };
    }

    case 'chart': {
      const format = formatOf(tracker, block.field, block.format);
      const type = fieldType(tracker, block.groupBy);
      const isDate = type === 'date' || type === 'builtin_date';
      if (block.chart === 'heatmap') {
        if (!isDate)
          return problem(
            block,
            `El mapa de calor necesita un campo de fecha; «${block.groupBy}» no lo es.`,
          );
        const builtin = block.groupBy === 'created_at' || block.groupBy === 'updated_at';
        if (!builtin && !block.hourField)
          return problem(
            block,
            `«${block.groupBy}» sólo trae el día. Para el mapa de calor usa created_at / updated_at o indica un campo de hora (hourField).`,
          );
        const lists: ViewRow[][][] = Array.from({ length: 7 }, () =>
          Array.from({ length: 24 }, () => [] as ViewRow[]),
        );
        for (const r of rows) {
          const stamp =
            block.groupBy === 'created_at'
              ? r.created_at
              : block.groupBy === 'updated_at'
                ? r.updated_at
                : r.values[block.groupBy];
          if (typeof stamp !== 'string' || !stamp) continue;
          const hv = block.hourField ? r.values[block.hourField] : undefined;
          if (block.hourField && typeof hv !== 'string') continue;
          const wh = weekdayHour(stamp, block.hourField ? (hv as string) : undefined);
          if (wh) lists[wh.weekday]?.[wh.hour]?.push(r);
        }
        let max = 0;
        const cells = lists.map((day) =>
          day.map((list) => {
            const value = list.length ? (aggregate(list, block.aggregate, block.field) ?? 0) : 0;
            max = Math.max(max, value);
            return { value, display: list.length ? formatValue(value, format) : '' };
          }),
        );
        const perDay = cells.map((day, i) => {
          const list = lists[i]?.flat() ?? [];
          const value = list.length ? (aggregate(list, block.aggregate, block.field) ?? 0) : 0;
          return { label: WEEKDAY_LABELS[i] ?? '', value, display: formatValue(value, format) };
        });
        const any = rows.length > 0 && max > 0;
        return {
          type: 'chart',
          id: block.id,
          width: block.width,
          title: block.title,
          chart: 'heatmap',
          points: any ? perDay : [],
          heat: { rows: [...WEEKDAY_LABELS], max, cells },
          total: formatValue(aggregate(rows, block.aggregate, block.field), format),
          tone: block.tone,
          source: tracker.name,
        };
      }
      const groups = new Map<string, ViewRow[]>();
      for (const r of rows) {
        const v = rawValue(r, block.groupBy);
        let key: string;
        if (isDate) {
          const day = typeof v === 'string' ? dayOf(v) : null;
          if (!day) continue;
          key = bucketOf(day, block.bucket);
        } else {
          key = v === undefined ? 'Sin dato' : String(v);
        }
        const list = groups.get(key);
        if (list) list.push(r);
        else groups.set(key, [r]);
      }
      let entries = [...groups.entries()].map(([key, list]) => ({
        key,
        list,
        value: aggregate(list, block.aggregate, block.field) ?? 0,
      }));
      if (block.chart === 'funnel') {
        // Las etapas, en el orden de las opciones y con las vacías en cero: un
        // embudo sin su etapa vacía miente sobre dónde se cae la gente.
        const order = tracker.fields.find((f) => f.key === block.groupBy)?.options ?? [];
        entries = order.slice(0, block.limit).map((key) => {
          const list = groups.get(key) ?? [];
          return {
            key,
            list,
            value: list.length ? (aggregate(list, block.aggregate, block.field) ?? 0) : 0,
          };
        });
      } else if (isDate) {
        entries.sort((a, b) => a.key.localeCompare(b.key));
        entries = entries.slice(-block.limit);
      } else if (type === 'select') {
        const order = tracker.fields.find((f) => f.key === block.groupBy)?.options ?? [];
        entries.sort((a, b) => {
          const ia = order.indexOf(a.key);
          const ib = order.indexOf(b.key);
          return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        });
        entries = entries.slice(0, block.limit);
      } else {
        entries.sort((a, b) => b.value - a.value);
        if (
          entries.length > block.limit &&
          (block.aggregate === 'count' || block.aggregate === 'sum')
        ) {
          const head = entries.slice(0, block.limit - 1);
          const rest = entries.slice(block.limit - 1).flatMap((e) => e.list);
          entries = [
            ...head,
            { key: 'Otros', list: rest, value: aggregate(rest, block.aggregate, block.field) ?? 0 },
          ];
        } else entries = entries.slice(0, block.limit);
      }
      const total = aggregate(rows, block.aggregate, block.field);
      return {
        type: 'chart',
        id: block.id,
        width: block.width,
        title: block.title,
        chart: block.chart,
        points: entries.map((e) => ({
          label: isDate ? bucketLabel(e.key, block.bucket) : e.key,
          value: e.value,
          display: formatValue(e.value, format),
        })),
        total: formatValue(total, format),
        tone: block.tone,
        source: tracker.name,
      };
    }

    case 'board':
    case 'zones': {
      const options = tracker.fields.find((f) => f.key === block.groupBy)?.options ?? [];
      const details = block.cardFields.length
        ? block.cardFields
        : tracker.fields
            .filter((f) => f.key !== block.groupBy)
            .slice(0, 2)
            .map((f) => f.key);
      const buckets = new Map<string, ViewRow[]>(options.map((o) => [o, []]));
      const loose: ViewRow[] = [];
      for (const r of rows) {
        const v = rawValue(r, block.groupBy);
        const list = v === undefined ? undefined : buckets.get(String(v));
        if (list) list.push(r);
        else loose.push(r);
      }
      const columns = [...buckets.entries()].map(([key, list]) => ({ key, label: key, list }));
      if (loose.length) columns.push({ key: '__none', label: 'Sin estado', list: loose });
      const visible = columns.flatMap((c) => c.list.slice(0, block.limit));
      const shared = {
        id: block.id,
        width: block.width,
        title: block.title,
        dragField: opts.writable && block.draggable ? block.groupBy : null,
        actions: actionsFor(opts, block.actions, tracker, visible),
        record: buildRecords(block, tracker, visible, [block.groupBy, ...details], writes, opts),
        columns: columns.map((c) => ({
          key: c.key,
          label: c.label,
          count: c.list.length,
          cards: c.list.slice(0, block.limit).map((r) => ({
            id: r.id,
            label: r.label,
            ...(isAlertRow(tracker, r) ? { alert: true } : {}),
            details: details.map((key) => detailOf(tracker, r, key)).filter((d) => d.value !== '—'),
          })),
        })),
        source: tracker.name,
      };
      return block.type === 'zones'
        ? {
            ...shared,
            type: 'zones',
            layout: zoneLayout(
              block.layout,
              columns.map((c) => c.key),
            ),
          }
        : { ...shared, type: 'board' };
    }

    case 'gallery': {
      const shown = sortRows(tracker, rows, block.sort).slice(0, block.limit);
      const badgeOptions = block.badgeField
        ? (tracker.fields.find((f) => f.key === block.badgeField)?.options ?? [])
        : [];
      const text = (r: ViewRow, key: string | undefined) => {
        if (!key) return null;
        const v = displayValue(tracker, r, key);
        return v === '—' ? null : v;
      };
      return {
        type: 'gallery',
        id: block.id,
        width: block.width,
        title: block.title,
        columns: block.columns,
        cards: shown.map((r) => {
          const badge = block.badgeField ? rawValue(r, block.badgeField) : undefined;
          const at = badge === undefined ? -1 : badgeOptions.indexOf(String(badge));
          const image = block.imageField ? rawValue(r, block.imageField) : undefined;
          return {
            id: r.id,
            ...(isAlertRow(tracker, r) ? { alert: true } : {}),
            title: text(r, block.titleField) ?? r.label,
            subtitle: text(r, block.subtitleField),
            meta: block.metaFields
              .map((key) => detailOf(tracker, r, key))
              .filter((m) => m.value !== '—'),
            badge:
              badge === undefined
                ? null
                : { label: String(badge), tone: at >= 0 ? toneAt(at) : 'primary' },
            image: typeof image === 'string' ? httpsUrl(image) : null,
          };
        }),
        total: rows.length,
        source: tracker.name,
        actions: actionsFor(opts, block.actions, tracker, shown),
        record: buildRecords(
          block,
          tracker,
          shown,
          [
            block.titleField,
            ...opt(block.subtitleField),
            ...block.metaFields,
            ...opt(block.badgeField),
          ],
          writes,
          opts,
        ),
      };
    }

    case 'calendar': {
      const month = today.slice(0, 7);
      const modes = block.modes ?? [];
      // Con selector, abre en el modo pedido o, si no está entre los elegibles, en el primero.
      const mode =
        block.mode !== 'agenda' && modes.length && !modes.includes(block.mode as 'day')
          ? (modes[0] as 'day' | 'week' | 'month')
          : block.mode;
      const agenda = mode === 'agenda';
      const months = agenda ? [] : [addMonths(month, -1), month, addMonths(month, 1)];
      const from = agenda ? today : `${months[0]}-01`;
      const to = agenda ? addDays(today, block.days - 1) : lastDayOfMonth(months[2] ?? month);
      const colorOptions = block.colorField
        ? (tracker.fields.find((f) => f.key === block.colorField)?.options ?? [])
        : [];
      const dated: Array<{ row: ViewRow; day: string }> = [];
      for (const r of rows) {
        const v = rawValue(r, block.dateField);
        const day = typeof v === 'string' ? dayOf(v) : null;
        if (day && day >= from && day <= to) dated.push({ row: r, day });
      }
      dated.sort(
        (a, b) => a.day.localeCompare(b.day) || a.row.label.localeCompare(b.row.label, 'es'),
      );
      const kept = dated.slice(0, CALENDAR_MAX_EVENTS);
      return {
        type: 'calendar',
        id: block.id,
        width: block.width,
        title: block.title,
        mode,
        modes,
        today,
        range: { from, to },
        months,
        events: kept.map(({ row, day }) => {
          const tag = block.colorField ? rawValue(row, block.colorField) : undefined;
          const at = tag === undefined ? -1 : colorOptions.indexOf(String(tag));
          return {
            id: row.id,
            day,
            label:
              block.labelField === 'label'
                ? row.label
                : displayValue(tracker, row, block.labelField),
            time: eventTime(row, block.timeField),
            tag: tag === undefined ? null : String(tag),
            tone: at >= 0 ? toneAt(at) : null,
          };
        }),
        legend: colorOptions.map((label, i) => ({ label, tone: toneAt(i) })),
        hidden: dated.length - kept.length,
        source: tracker.name,
        actions: actionsFor(
          opts,
          block.actions,
          tracker,
          kept.map((k) => k.row),
        ),
        record: buildRecords(
          block,
          tracker,
          kept.map((k) => k.row),
          [block.dateField, block.labelField, ...opt(block.colorField)],
          writes,
          opts,
        ),
      };
    }

    case 'cards':
      return computeCards(block, { src, rows, today, opts });

    case 'detail':
      return buildDetail(block, { src, rows, sources, today, opts });

    case 'progress': {
      const format = formatOf(tracker, block.field, block.format);
      const value = (list: ViewRow[]) => aggregate(list, block.aggregate, block.field) ?? 0;
      let groups: Array<{ label: string; value: number }>;
      if (!block.groupBy) {
        groups = [{ label: 'Total', value: value(rows) }];
      } else {
        const by = block.groupBy;
        const type = fieldType(tracker, by);
        const isDate = type === 'date' || type === 'builtin_date';
        const options =
          type === 'select' ? (tracker.fields.find((f) => f.key === by)?.options ?? []) : [];
        const lists = new Map<string, ViewRow[]>(options.map((o) => [o, []]));
        for (const t of block.targets) if (!lists.has(t.group)) lists.set(t.group, []);
        for (const r of rows) {
          const v = rawValue(r, by);
          if (v === undefined) continue;
          const key = isDate
            ? typeof v === 'string' && dayOf(v)
              ? bucketLabel(bucketOf(dayOf(v) as string, 'month'), 'month')
              : null
            : String(v);
          if (!key) continue;
          const list = lists.get(key);
          if (list) list.push(r);
          else lists.set(key, [r]);
        }
        groups = [...lists.entries()].map(([label, list]) => ({ label, value: value(list) }));
        if (!options.length) groups.sort((a, b) => b.value - a.value);
        groups = groups.slice(0, block.limit);
      }
      const relative = block.target === undefined && block.targets.length === 0;
      const max = Math.max(0, ...groups.map((g) => g.value));
      const targetFor = (label: string) =>
        block.targets.find((t) => t.group.trim().toLowerCase() === label.trim().toLowerCase())
          ?.target ??
        block.target ??
        null;
      return {
        type: 'progress',
        id: block.id,
        width: block.width,
        title: block.title,
        tone: block.tone,
        relative,
        items: groups.map((g) => {
          const target = relative ? null : targetFor(g.label);
          return {
            label: g.label,
            value: g.value,
            display: formatValue(g.value, format),
            target,
            targetDisplay: target === null ? null : formatValue(target, format),
            ratio: target ? g.value / target : relative && max > 0 ? g.value / max : 0,
          };
        }),
        source: tracker.name,
      };
    }

    case 'form': {
      const keys = block.fields.length ? block.fields : tracker.fields.map((f) => f.key);
      return {
        type: 'form',
        id: block.id,
        width: block.width,
        title: block.title,
        intro: block.intro ?? null,
        tracker: tracker.slug,
        submitLabel: block.submitLabel,
        successMessage: block.successMessage,
        editWindowMinutes: editWindowOf(block),
        steps: block.steps?.length ? block.steps : null,
        voice: formVoiceOf(block),
        // El campo de estado de la aprobación lo pone el servidor: no se pide.
        fields: keys
          .filter((key) => key !== block.approval?.field)
          .map((key) => tracker.fields.find((f) => f.key === key))
          .filter((f): f is TrackerField => Boolean(f))
          .map(formField),
      };
    }
  }
}

/** Sólo las opciones que están puestas: el JSON del bloque no carga `undefined`. */
function formField(f: TrackerField): ComputedFormField {
  const out: ComputedFormField = {
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required,
    options: f.options ?? [],
  };
  for (const k of FORM_FIELD_EXTRAS)
    if (f[k] !== undefined) (out as Record<string, unknown>)[k] = f[k];
  return out;
}

const FORM_FIELD_EXTRAS = [
  'min',
  'max',
  'minLength',
  'maxLength',
  'format',
  'pattern',
  'message',
  'default',
  'help',
  'placeholder',
  'example',
  'showIf',
  'accept',
  'multiple',
  'tracker',
  'scan',
] as const;

// ---------------------------------------------------------------------------
// La barra de filtros, las páginas y el aspecto
// ---------------------------------------------------------------------------

const fold = (v: string) =>
  v
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();

function matchesBar(
  tracker: CatalogTracker,
  row: ViewRow,
  field: string,
  value: FilterBarValue,
): boolean {
  const v = rawValue(row, field);
  if (value.kind === 'search') {
    const q = fold(value.value);
    return !q || fold(String(v ?? '')).includes(q) || fold(row.label).includes(q);
  }
  if (v === undefined) return false;
  if (value.kind === 'date_range') {
    const day = dayOf(String(v));
    if (!day) return false;
    return (!value.from || day >= value.from) && (!value.to || day <= value.to);
  }
  const type = fieldType(tracker, field);
  return type === 'number' || type === 'money'
    ? Number(v) === Number(value.value)
    : fold(String(v)) === fold(value.value);
}

/**
 * Las fuentes con la barra de filtros aplicada. Cada fuente se filtra UNA vez
 * y todos los bloques (y avisos) que la leen ven lo mismo: «Sede: Cali» no
 * puede dejar una cifra de Cali junto a una tabla de todas las sedes.
 */
export function applyFilterBar(
  spec: Pick<ViewSpec, 'filtersBar'>,
  sources: Map<string, ViewSource>,
  state: ViewFilterState,
): Map<string, ViewSource> {
  const bar = spec.filtersBar ?? [];
  if (!bar.length || !Object.keys(state).length) return sources;
  const out = new Map(sources);
  for (const item of bar) {
    const value = state[item.id];
    const src = out.get(item.source);
    if (!value || !src || src.blocked || !fieldType(src.tracker, item.field)) continue;
    out.set(item.source, {
      ...src,
      rows: src.rows.filter((r) => matchesBar(src.tracker, r, item.field, value)),
    });
  }
  return out;
}

/** Cuántas opciones saca un menú de la barra de un campo que no es de opciones. */
const BAR_MAX_OPTIONS = 60;

function computeFilterBar(
  spec: ViewSpec,
  sources: Map<string, ViewSource>,
  state: ViewFilterState,
): ComputedFilterBarItem[] {
  return (spec.filtersBar ?? []).map((item) => {
    const src = sources.get(item.source);
    let options: string[] = [];
    if (item.kind === 'select' && src && !src.blocked) {
      const declared = src.tracker.fields.find((f) => f.key === item.field);
      options =
        declared?.type === 'select' && declared.options?.length
          ? declared.options
          : [
              ...new Set(
                src.rows
                  .map((r) => rawValue(r, item.field))
                  .filter((v): v is string | number => v !== undefined)
                  .map((v) => String(v).trim())
                  .filter(Boolean),
              ),
            ]
              .sort((a, b) => a.localeCompare(b, 'es', { numeric: true }))
              .slice(0, BAR_MAX_OPTIONS);
    }
    return {
      id: item.id,
      label: item.label,
      kind: item.kind,
      source: src?.tracker.name ?? item.source,
      options,
      value: state[item.id] ?? null,
    };
  });
}

/**
 * Las páginas, cada una con sus bloques en el orden del spec. Un bloque puede
 * estar en varias (una fila de cifras arriba de cada pestaña); el que no está
 * en ninguna sale en la primera.
 */
export function computePages(
  spec: Pick<ViewSpec, 'pages' | 'blocks'>,
): Array<{ id: string; title: string; blockIds: string[] }> {
  const pages = spec.pages ?? [];
  if (!pages.length) return [];
  const order = spec.blocks.map((b) => b.id);
  const listed = new Set(pages.flatMap((p) => p.blockIds));
  const loose = order.filter((id) => !listed.has(id));
  return pages.map((p, i) => {
    const wanted = new Set([...p.blockIds, ...(i === 0 ? loose : [])]);
    return { id: p.id, title: p.title, blockIds: order.filter((id) => wanted.has(id)) };
  });
}

export function computeTheme(spec: Pick<ViewSpec, 'theme' | 'accent'>): ComputedTheme {
  const layout = spec.theme?.layout ?? 'dashboard';
  const tv = layout === 'tv';
  return {
    accent: spec.theme?.accent ?? spec.accent,
    density: spec.theme?.density ?? 'comfortable',
    header: spec.theme?.header ?? 'plain',
    layout,
    // El tablero TV es siempre un panel oscuro de alto contraste.
    style: tv ? 'dark-panel' : (spec.theme?.style ?? 'clean'),
    cover: httpsUrl(spec.theme?.cover),
    ...(tv
      ? {
          tv: {
            rotateSeconds: spec.theme?.tv?.rotateSeconds ?? 15,
            clock: spec.theme?.tv?.clock ?? true,
          },
        }
      : {}),
  };
}

/** Cuántas filas recientes viajan por alerta para detectar las nuevas. */
const ALERT_FEED_ROWS = 15;

export function computeView(
  spec: ViewSpec,
  unfiltered: Map<string, ViewSource>,
  now: Date = new Date(),
  opts: Partial<ComputeOptions> = {},
): ComputedView {
  const today = todayIn(now);
  const options: ComputeOptions = {
    writable: Boolean(opts.writable),
    audience: opts.audience ?? 'team',
    filters: opts.filters ?? {},
    viewer: opts.viewer ?? null,
    record: opts.record ?? null,
    // El detalle que abre las filas de cada tabla: el primero de la vista que la lee.
    details: new Map(
      spec.blocks
        .flatMap((b) => (b.type === 'detail' ? ([[b.tracker, b.id]] as const) : []))
        .reverse(),
    ),
    actionLabels: actionLabelsOf(spec),
    approval: new Map(
      spec.blocks.flatMap((b) =>
        b.type === 'form' && b.approval ? ([[b.tracker, b.approval]] as const) : [],
      ),
    ),
  };
  const sources = applyFilterBar(spec, unfiltered, options.filters);
  // El registro abierto: qué detalle lo muestra. Sólo ese bloque sale «listo».
  const target = options.record
    ? findDetailTarget(spec, sources, options.record.rowId, options.record.blockId, today)
    : null;
  if (options.record)
    options.record = {
      ...options.record,
      blockId: target?.block.id ?? spec.blocks.find((b) => b.type === 'detail')?.id ?? null,
    };
  const alerts: ComputedAlertFeed[] = [];
  for (const alert of spec.alerts) {
    const src = sources.get(alert.source);
    if (!src) continue;
    const rows = src.rows
      .filter((r) => alert.filters.every((f) => matches(src.tracker, r, f, today)))
      // Por última actualización y no por creación: una fila que CAMBIÓ y
      // ahora cumple el filtro («pasó a Aterrizó») también es noticia, y tiene
      // que caber entre las recientes para que el navegador la vea.
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, ALERT_FEED_ROWS)
      .map((r) => ({
        id: r.id,
        label: r.label,
        createdAt: r.created_at,
        rev: r.updated_at,
      }));
    alerts.push({
      id: alert.id,
      source: src.tracker.name,
      message: alert.message ?? null,
      sound: alert.sound,
      desktop: alert.desktop,
      on: alert.on,
      rows,
    });
  }
  return {
    blocks: spec.blocks.map((block) =>
      block.type === 'voice' && !spec.blocks.some((b) => b.id === block.form && b.type === 'form')
        ? problem(
            block,
            `El asistente de voz maneja el formulario «${block.form}», que ya no está en esta vista.`,
          )
        : computeBlock(block, sources, today, options),
    ),
    computedAt: now.toISOString(),
    partial: [...unfiltered.values()].filter((s) => s.truncated).map((s) => s.tracker.name),
    refreshSeconds:
      spec.theme?.layout === 'tv' && (spec.refreshSeconds === 0 || spec.refreshSeconds > 30)
        ? 30
        : spec.refreshSeconds,
    writable: options.writable,
    alerts,
    filtersBar: computeFilterBar(spec, unfiltered, options.filters),
    pages: computePages(spec),
    theme: computeTheme(spec),
    record: options.record
      ? {
          blockId: options.record.blockId ?? '',
          rowId: options.record.rowId,
          found: Boolean(target),
        }
      : null,
  };
}

/** id de botón → rótulo, de todos los bloques de la vista (incluidas las listas relacionadas). */
function actionLabelsOf(spec: Pick<ViewSpec, 'blocks'>): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of spec.blocks) {
    if ('actions' in b) for (const a of b.actions) out.set(a.id, a.label);
    if (b.type === 'detail')
      for (const r of b.related) for (const a of r.actions) out.set(a.id, a.label);
  }
  return out;
}

/**
 * Las piezas de fila que comparten compute.ts y los bloques que viven en su
 * propio archivo (record.ts, cards.ts). Un solo objeto, y no una docena de
 * exports sueltos: así el barril del paquete no los publica como API.
 */
export const rowKit = {
  rawValue,
  displayValue,
  detailOf,
  fieldLabel,
  columnKind,
  editMeta,
  sortRows,
  actionsFor,
  toneAt,
  isAlertRow,
  dayOf,
  addDays,
  matches,
  problem,
  buildRecords,
};
