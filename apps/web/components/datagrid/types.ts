/**
 * EL CONTRATO DEL VISUALIZADOR DE DATOS.
 *
 * Un solo componente para ver, filtrar, ordenar, agrupar, crear y editar filas:
 * lo usan las tablas de la empresa (/trackers) y Clientes, y cualquier pantalla
 * que tenga una lista de cosas. Este archivo es el acuerdo entre quien construye
 * el componente y quien lo usa: agregar campos opcionales sí; cambiar o quitar,
 * no.
 *
 * Los datos llegan ya leídos (el componente no consulta la base). Para listas
 * grandes, `onQuery` deja que la pantalla pagine y filtre en el servidor con la
 * misma vista.
 */

/**
 * Formas de los valores (ver lib/datagrid/format.ts): `date` es `YYYY-MM-DD`;
 * `datetime` un ISO (se muestra en hora de Bogotá); `percent` en puntos (12.5 =
 * «12,5 %»); `multi_select` un arreglo de valores de opción; `person` un nombre
 * (o `{ name }`).
 */
export type GridColumnType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'money'
  | 'percent'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multi_select'
  | 'person'
  | 'boolean'
  | 'link'
  | 'email'
  | 'phone'
  | 'status';

export interface GridOption {
  value: string;
  label?: string;
  /** Tono del chip: el mismo vocabulario de lib/status-chip.ts. */
  tone?: 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';
}

export interface GridColumn {
  key: string;
  label: string;
  type: GridColumnType;
  options?: GridOption[];
  /** Moneda para `money` (COP por defecto). */
  currency?: string;
  editable?: boolean;
  required?: boolean;
  /** Ancho sugerido en px; el usuario lo puede cambiar. */
  width?: number;
  /** Visible en la tarjeta/móvil como dato principal. */
  primary?: boolean;
  /** Ayuda corta que aparece en el encabezado. */
  description?: string;
  /** No se puede ocultar (p. ej. el nombre). */
  pinned?: boolean;
}

export interface GridRow {
  id: string;
  values: Record<string, unknown>;
  /** A dónde lleva abrir la fila (detalle), si existe. */
  href?: string | null;
  /** Solo lectura para esta fila aunque la columna sea editable. */
  locked?: boolean;
  /** Fila para mirar con cuidado (p. ej. un duplicado): se pinta en tono de alerta. */
  alert?: boolean;
}

export type GridFilterOp =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'in'
  | 'not_in'
  | 'empty'
  | 'not_empty'
  | 'before'
  | 'after'
  | 'last_days'
  | 'next_days';

export interface GridFilter {
  key: string;
  op: GridFilterOp;
  value?: unknown;
}

export interface GridSort {
  key: string;
  dir: 'asc' | 'desc';
}

export type GridLayout = 'table' | 'board' | 'cards' | 'calendar';

/** Qué cifra muestra el pie de una columna numérica. */
export type GridAggregate = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'none';

export interface GridView {
  id?: string;
  name?: string;
  search?: string;
  filters: GridFilter[];
  /** Todas deben cumplirse (and) o basta una (or). */
  match?: 'all' | 'any';
  sort: GridSort[];
  groupBy?: string | null;
  hidden: string[];
  order?: string[];
  widths?: Record<string, number>;
  layout: GridLayout;
  /** Columna de fecha para el calendario, de agrupación para el tablero. */
  layoutKey?: string | null;
  /** (opcional) Cifra del pie por columna numérica; sin ella, suma (promedio en %). */
  aggregates?: Record<string, GridAggregate>;
  /** (opcional) Vista guardada visible para todo el equipo, no solo para quien la creó. */
  shared?: boolean;
  /** (opcional) Quien mira puede renombrarla o borrarla (la creó, o administra). */
  canManage?: boolean;
}

export interface GridQueryResult {
  rows: GridRow[];
  total: number;
}

export interface DataGridProps {
  columns: GridColumn[];
  rows: GridRow[];
  /** Total real si `rows` es una página. */
  total?: number;
  initialView?: Partial<GridView>;
  savedViews?: GridView[];
  onSaveView?: (view: GridView) => Promise<GridView>;
  onDeleteView?: (id: string) => Promise<void>;
  /** Paginación/filtrado en el servidor con la misma vista. */
  onQuery?: (view: GridView, page: { offset: number; limit: number }) => Promise<GridQueryResult>;
  onEdit?: (rowId: string, key: string, value: unknown) => Promise<void>;
  onCreate?: (values: Record<string, unknown>) => Promise<GridRow>;
  onDelete?: (rowIds: string[]) => Promise<void>;
  onBulkEdit?: (rowIds: string[], key: string, value: unknown) => Promise<void>;
  /** Columnas nuevas desde la grilla (tablas de la empresa). */
  onAddColumn?: (column: Omit<GridColumn, 'key'> & { key?: string }) => Promise<GridColumn>;
  /** Nombre del archivo al exportar CSV. */
  exportName?: string;
  /** Qué decir y qué ofrecer cuando no hay filas. */
  emptyState?: { title: string; body?: string; action?: { label: string; href: string } };
  /** Frase para pedirle a Cortex algo sobre estos datos (/chat?prompt=). */
  askCortexContext?: string;
  /** Panel lateral al abrir una fila (si no hay `href`). */
  renderRowDetail?: (row: GridRow) => React.ReactNode;
  /**
   * Nombre en singular/plural para los textos («cliente/clientes»). `gender`
   * (opcional) para «Nuevo cliente» / «Nueva guía»; sin él, se adivina por la
   * última letra del singular.
   */
  noun?: { one: string; many: string; gender?: 'm' | 'f' };
  /** (opcional) Tipos que ofrece «Agregar columna»; por defecto, todos. */
  addColumnTypes?: GridColumnType[];
  /**
   * (opcional) Parámetro de la URL donde vive la vista para compartirla con un
   * enlace (`?vista=…` por defecto). `false` si hay dos grillas en la pantalla.
   */
  urlParam?: string | false;
  /** (opcional) Alto del área con scroll en escritorio (CSS). Por defecto llena la ventana. */
  height?: string;
  /** (opcional) Nombres sugeridos al editar una columna `person`. */
  people?: string[];
  /**
   * (opcional) Contenido extra bajo los campos en el detalle por defecto de una
   * fila (p. ej. su historial). A diferencia de `renderRowDetail`, conserva la
   * edición de los campos.
   */
  renderRowExtra?: (row: GridRow) => React.ReactNode;
  /** (opcional) Filas que acaban de llegar o cambiar: titilan (LIVE_FLASH_CLASS). */
  flashIds?: ReadonlySet<string>;
}
