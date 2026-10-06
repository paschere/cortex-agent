'use client';

import type { FilterState } from '@/lib/views/filter-param';
import type { ComputedBlock, ComputedView, TrackerField } from '@cortex/agent-tools';
import {
  defaultValues,
  validateRowValues,
  violationsByKey,
  visibleKeys,
} from '@cortex/agent-tools/src/trackers/validation';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronRight,
  Inbox,
  Loader2,
  PanelRightOpen,
  Search,
  Send,
} from 'lucide-react';
import { useCallback, useId, useMemo, useState, useTransition } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DictateRecord, type Dictated } from './DictateRecord';
import { ViewChart } from './ViewChart';
import { ViewZones } from './ViewZones';
import { CalendarBlock } from './blocks/Calendar';
import { FormBlock } from './blocks/FormBlock';
import { GalleryBlock } from './blocks/Gallery';
import { LinksBlock, MediaBlock } from './blocks/Media';
import { MetricBlock } from './blocks/Metric';
import { ProgressBlock } from './blocks/Progress';
import {
  RecordDrawer,
  RecordOpenerProvider,
  recordBlockOf,
  useRecordOpener,
} from './blocks/RecordDrawer';
import { RichValue } from './blocks/RichValue';
import { FilterBar, PageTabs } from './blocks/ViewChrome';
import { useBrandScope } from './blocks/brand';
import { type SubmitFn, submitterFor } from './blocks/form-transport';
import {
  Card,
  EmptyState,
  STATUS_COLUMN_RE,
  StatusChip,
  TONE_BAR,
  ViewThemeProvider,
  statusTone,
  useViewTheme,
} from './blocks/theme';
import { useFlashClass } from './flash-context';
import {
  EditableCell,
  EditableValue,
  RowActions,
  ViewWriterProvider,
  useViewWriter,
} from './view-writes';
import './views.css';

/**
 * EL LIENZO DE UNA VISTA.
 *
 * Pinta lo que `computeView` ya resolvió: no calcula, no lee la base, no sabe
 * de qué espacio es. Por eso es el mismo componente en tres sitios — la vista
 * dentro de la app, el enlace público y la vista previa del editor — y por eso
 * sólo importa TIPOS de `@cortex/agent-tools` (el barril arrastra `node:dns` y
 * rompe el bundle de cliente; ver lib/reports-shape.ts).
 *
 * La rejilla es de seis columnas: un tercio ocupa dos, una mitad tres. En un
 * teléfono todo es ancho completo, que es como se lee una vista en WhatsApp.
 *
 * Alrededor de los bloques: la barra de filtros (si el spec la tiene), las
 * pestañas de las páginas y la ficha de una fila (components/views/blocks).
 * Quien monta el lienzo decide si la barra filtra (`filters`, con su
 * `onChange`) y qué página se ve (`page`); sin eso, la página se elige aquí y
 * la barra se pinta apagada. Los bloques de cada tipo viven en
 * components/views/blocks; aquí quedan la tabla, el tablero y el formulario.
 */

export type SubmitTarget =
  | { kind: 'app'; viewId: string }
  | { kind: 'public'; token: string }
  | { kind: 'preview' }
  /** El escaparate de desarrollo (/v/views-showcase): escribe de mentira, sin red. */
  | { kind: 'demo' };

export type { SubmitFn } from './blocks/form-transport';

const SPAN: Record<ComputedBlock['width'], string> = {
  full: 'md:col-span-6',
  half: 'md:col-span-3',
  third: 'md:col-span-3 xl:col-span-2',
};

export interface CanvasFilters {
  state: FilterState;
  onChange: (next: FilterState) => void;
  pending?: boolean;
}

export function ViewCanvas({
  view,
  target,
  onChanged,
  filters,
  page,
}: {
  view: ComputedView;
  target: SubmitTarget;
  /** Después de una escritura: el refresco en vivo lo usa para recalcular. */
  onChanged?: () => void;
  /** La barra de filtros conectada a quien recalcula. Sin esto, se pinta apagada. */
  filters?: CanvasFilters;
  /** La página elegida, si quien monta el lienzo la lleva (en la URL). */
  page?: { current: string | null; onSelect: (id: string) => void };
}) {
  const submit = submitterFor(target);
  const idBase = useId().replace(/:/g, '');
  const pages = view.pages ?? [];
  const [localPage, setLocalPage] = useState<string | null>(null);
  const wanted = page ? page.current : localPage;
  const current = pages.find((p) => p.id === wanted) ?? pages[0] ?? null;
  const visible = current ? new Set(current.blockIds) : null;
  const theme = view.theme;
  const compact = theme?.density === 'compact';
  const operator = theme?.layout === 'operator';
  const inPage = visible ? view.blocks.filter((b) => visible.has(b.id)) : view.blocks;
  // Planta: el formulario manda. Sube arriba (orden estable) para que quien
  // llega con el celular en la mano registre sin bajar por nada.
  const shown = operator
    ? [...inPage.filter((b) => b.type === 'form'), ...inPage.filter((b) => b.type !== 'form')]
    : inPage;
  const scope = useBrandScope();

  // La ficha abierta: se busca en la vista de AHORA, así que después de un
  // refresco muestra lo nuevo (o dice que la fila ya no está).
  const [opened, setOpened] = useState<{ blockId: string; rowId: string } | null>(null);
  const openRecord = useCallback(
    (blockId: string, rowId: string) => setOpened({ blockId, rowId }),
    [],
  );
  const openedBlock = opened
    ? recordBlockOf(view.blocks.find((b) => b.id === opened.blockId))
    : null;

  return (
    <ViewThemeProvider theme={theme}>
      <ViewWriterProvider
        target={view.writable ? target : { kind: 'preview' }}
        onChanged={onChanged}
      >
        <RecordOpenerProvider value={openRecord}>
          <div
            className={clsx(scope.className, operator && 'view-operator')}
            style={scope.style}
            data-view-layout={theme?.layout ?? 'dashboard'}
            data-view-style={theme?.style ?? 'clean'}
          >
            {(view.filtersBar?.length ?? 0) > 0 && (
              <FilterBar
                items={view.filtersBar ?? []}
                state={filters?.state ?? {}}
                onChange={filters?.onChange}
                pending={filters?.pending}
              />
            )}
            {pages.length > 1 && current && (
              <PageTabs
                pages={pages}
                current={current.id}
                accent={theme?.accent ?? 'primary'}
                idBase={idBase}
                onSelect={(id) => (page ? page.onSelect(id) : setLocalPage(id))}
              />
            )}
            <div
              id={pages.length > 1 ? `${idBase}-panel` : undefined}
              role={pages.length > 1 ? 'tabpanel' : undefined}
              aria-labelledby={
                pages.length > 1 && current ? `${idBase}-tab-${current.id}` : undefined
              }
              aria-busy={filters?.pending || undefined}
              className={clsx(
                'grid transition-opacity duration-200',
                operator ? 'mx-auto max-w-2xl grid-cols-6 gap-3' : 'grid-cols-1 md:grid-cols-6',
                !operator && (compact ? 'gap-3' : 'gap-4 md:gap-5'),
                filters?.pending && 'opacity-60',
              )}
            >
              {shown.map((block) => (
                <section
                  key={block.id}
                  className={clsx(
                    'view-block min-w-0',
                    // Planta: una columna; las métricas de a dos en el celular, de a tres arriba.
                    operator
                      ? block.type === 'metric'
                        ? 'view-metric-cell col-span-3 min-w-0 overflow-hidden sm:col-span-2'
                        : 'col-span-6'
                      : SPAN[block.width],
                  )}
                >
                  <Block block={block} target={target} submit={submit} />
                </section>
              ))}
              {shown.length === 0 && (
                <EmptyState
                  className="col-span-full"
                  icon={<Inbox className="h-5 w-5" aria-hidden />}
                  title="Esta página todavía no tiene bloques"
                  hint="Pídele a Cortex que agregue uno, o ábrela en el lienzo para armarla con las manos."
                />
              )}
              {view.partial.length > 0 && (
                <p className="col-span-full text-micro text-ink-faint">
                  Cifras calculadas sobre las 2.000 filas más recientes de {view.partial.join(', ')}
                  .
                </p>
              )}
            </div>
          </div>
          <RecordDrawer
            block={openedBlock}
            rowId={opened?.rowId ?? null}
            onClose={() => setOpened(null)}
          />
        </RecordOpenerProvider>
      </ViewWriterProvider>
    </ViewThemeProvider>
  );
}

/**
 * Un bloque suelto, ya calculado, sin rejilla alrededor y sin escribir nada.
 * Es lo que el lienzo de edición (components/views/editor) pinta dentro de cada
 * marco: el mismo dibujo que verá la vista guardada, para que editar no sea
 * mirar una maqueta distinta de lo que sale.
 */
export function ViewBlockPreview({ block }: { block: ComputedBlock }) {
  return (
    <ViewWriterProvider target={{ kind: 'preview' }}>
      <Block block={block} target={{ kind: 'preview' }} />
    </ViewWriterProvider>
  );
}

function Block({
  block,
  target,
  submit,
}: { block: ComputedBlock; target: SubmitTarget; submit?: SubmitFn }) {
  switch (block.type) {
    case 'text':
      return (
        <div className="prose max-w-none px-1 text-ink prose-headings:mb-2 prose-headings:font-extrabold prose-headings:tracking-tight prose-headings:text-ink prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-p:my-2 prose-p:text-sm prose-p:leading-relaxed prose-p:text-ink-muted prose-a:font-semibold prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-blockquote:border-l-primary prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-ink-muted prose-strong:text-ink prose-code:rounded prose-code:bg-surface-2 prose-code:px-1 prose-code:font-mono prose-code:text-xs prose-code:text-ink prose-code:before:content-none prose-code:after:content-none prose-ol:text-sm prose-ul:text-sm prose-li:text-ink-muted prose-li:marker:text-primary prose-hr:border-border prose-th:text-ink prose-td:text-ink-muted">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            disallowedElements={['img', 'iframe', 'script']}
            components={{
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                  {children}
                </a>
              ),
            }}
          >
            {block.markdown}
          </ReactMarkdown>
        </div>
      );
    case 'metric':
      return <MetricBlock block={block} />;
    case 'table':
      return <Table block={block} />;
    case 'chart':
      return (
        <Card title={block.title} source={block.source}>
          <ViewChart block={block} />
          {block.chart !== 'donut' && block.points.length > 0 && (
            <p className="mt-4 flex items-center justify-between border-t border-border/70 pt-3 text-micro text-ink-faint">
              <span>Total</span>
              <span className="tabular font-mono text-xs font-semibold text-ink">
                {block.total}
              </span>
            </p>
          )}
        </Card>
      );
    case 'board':
      return <Board block={block} />;
    case 'zones':
      return <ViewZones block={block} Card={Card} />;
    case 'form':
      return <FormBlock block={block} target={target} submit={submit} />;
    case 'gallery':
      return <GalleryBlock block={block} />;
    case 'calendar':
      return <CalendarBlock block={block} />;
    case 'progress':
      return <ProgressBlock block={block} />;
    case 'media':
      return <MediaBlock block={block} />;
    case 'links':
      return <LinksBlock block={block} />;
    case 'problem':
      return (
        <Card className="border-amber/40 bg-amber-soft/40">
          <div className="flex gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-pill bg-amber-soft text-amber">
              <AlertTriangle className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-semibold text-ink">{block.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">{block.message}</p>
            </div>
          </div>
        </Card>
      );
  }
}

/** Un clic en un control de la fila (celda editable, botón) no abre la ficha. */
const INTERACTIVE = 'button, a, input, select, textarea, label';

type TableBlock = Extract<ComputedBlock, { type: 'table' }>;

/**
 * Qué columnas se pintan como chips de estado: las que se llaman como un
 * estado («Estado», «Etapa», «Prioridad»…), las de opciones que se editan, y
 * las de texto cuyos valores son TODOS palabras de estado reconocidas.
 */
function statusColumns(block: TableBlock): Set<number> {
  const out = new Set<number>();
  block.columns.forEach((c, i) => {
    if (i === 0 || c.kind !== 'text') return;
    if (STATUS_COLUMN_RE.test(c.label.trim()) || c.edit?.type === 'select') {
      out.add(i);
      return;
    }
    const values = block.rows.map((r) => r.cells[i] ?? '').filter(Boolean);
    if (values.length >= 2 && values.every((v) => statusTone(v) !== null)) out.add(i);
  });
  return out;
}

function Table({ block }: { block: TableBlock }) {
  const flash = useFlashClass();
  const { layout } = useViewTheme();
  const operator = layout === 'operator';
  const open = useRecordOpener(block.id, block.record);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const chips = useMemo(() => statusColumns(block), [block]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = q
      ? block.rows.filter((r) => r.cells.some((c) => c.toLowerCase().includes(q)))
      : block.rows;
    if (sort) {
      const numeric = block.columns[sort.col]?.kind === 'number';
      list = [...list].sort((a, b) => {
        const va = a.sort[sort.col];
        const vb = b.sort[sort.col];
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        return (
          (numeric ? Number(va) - Number(vb) : String(va).localeCompare(String(vb), 'es')) *
          sort.dir
        );
      });
    }
    return list;
  }, [block, query, sort]);

  /** Lo que se ve en una celda: chip de estado, o el valor tal cual. */
  const show = (cell: string, i: number, raw?: string | number | null) => {
    const rich = block.columns[i]?.rich;
    if (rich) return <RichValue kind={rich} raw={raw} text={cell} />;
    return chips.has(i) && cell ? <StatusChip value={cell} tone={statusTone(cell)} /> : cell;
  };

  return (
    <Card
      title={block.title}
      source={`${block.total} ${block.total === 1 ? 'fila' : 'filas'} · ${block.source}`}
    >
      {block.searchable && block.rows.length > (operator ? 0 : 5) && (
        <label
          className={clsx(
            'view-no-print mb-4 flex items-center gap-2 rounded-pill border border-border bg-surface-2/70 px-4 transition-colors focus-within:border-border-strong focus-within:bg-surface',
            operator ? 'h-14 border-border-strong' : 'h-10',
          )}
        >
          <Search
            className={clsx('text-ink-faint', operator ? 'h-5 w-5' : 'h-4 w-4')}
            aria-hidden
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar en la tabla"
            aria-label={`Buscar en ${block.title}`}
            className={clsx(
              'w-full bg-transparent text-ink outline-none placeholder:text-ink-faint',
              operator ? 'text-lg' : 'text-sm',
            )}
          />
          {query && (
            <span className="tabular shrink-0 font-mono text-micro text-ink-faint">
              {rows.length}
            </span>
          )}
        </label>
      )}

      {/* Teléfono: una tarjeta por fila, con sus campos en renglones. */}
      <ul className={clsx('space-y-2.5', operator ? 'space-y-3' : 'sm:hidden')}>
        {rows.map((r) => (
          <li
            key={r.id}
            className={clsx(
              flash(block.id, r.id),
              'rounded-sm border shadow-card',
              operator ? 'border-2 p-4' : 'p-3.5',
              r.alert
                ? 'border-rose/50 bg-rose-soft'
                : operator
                  ? 'border-border-strong bg-surface'
                  : 'border-border bg-surface',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              {open ? (
                <button
                  type="button"
                  onClick={() => open(r.id)}
                  className={clsx(
                    'flex min-w-0 items-center gap-1 text-left font-bold text-ink',
                    operator ? 'text-lg' : 'text-sm',
                  )}
                >
                  <span className="truncate">{r.cells[0]}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                </button>
              ) : (
                <p
                  className={clsx(
                    'min-w-0 truncate font-bold text-ink',
                    operator ? 'text-lg' : 'text-sm',
                  )}
                >
                  {r.cells[0]}
                </p>
              )}
            </div>
            <dl className={clsx('mt-2.5', operator ? 'space-y-2.5' : 'space-y-1.5')}>
              {r.cells.slice(1).map((cell, j) => {
                const i = j + 1;
                const column = block.columns[i];
                if (!column) return null;
                return (
                  <div
                    key={column.key}
                    className={clsx(
                      'flex items-center justify-between gap-3',
                      operator ? 'text-base' : 'text-xs',
                    )}
                  >
                    <dt className="shrink-0 text-ink-faint">{column.label}</dt>
                    <dd
                      className={clsx(
                        'min-w-0 text-right text-ink',
                        column.kind !== 'text' && 'tabular font-mono',
                      )}
                    >
                      {column.edit ? (
                        <EditableValue
                          blockId={block.id}
                          rowId={r.id}
                          field={column.key}
                          edit={column.edit}
                          raw={r.sort[i] ?? null}
                          display={cell}
                          label={column.label}
                        />
                      ) : (
                        show(cell, i, r.sort[i])
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
            {block.actions.length > 0 && (
              <div className="mt-3 border-t border-border/70 pt-2.5">
                <RowActions
                  blockId={block.id}
                  actions={block.actions}
                  rowId={r.id}
                  rowLabel={r.cells[0] ?? ''}
                />
              </div>
            )}
          </li>
        ))}
      </ul>

      <div
        className={clsx(
          'view-table-scroll scroll-slim -mx-4 hidden max-h-[34rem] overflow-auto sm:-mx-6',
          rows.length > 0 && !operator && 'sm:block',
        )}
      >
        <table className="view-table w-full min-w-[34rem] border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              {block.columns.map((c, i) => (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={
                    sort?.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined
                  }
                  className={clsx(
                    'px-4 py-2.5 text-left text-micro font-semibold uppercase tracking-field text-ink-faint first:pl-6 last:pr-6',
                    c.kind === 'number' && 'text-right',
                  )}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setSort((s) =>
                        s?.col === i ? { col: i, dir: s.dir === 1 ? -1 : 1 } : { col: i, dir: -1 },
                      )
                    }
                    className={clsx(
                      'group/sort inline-flex items-center gap-1 rounded-pill transition-colors hover:text-ink',
                      sort?.col === i && 'text-ink',
                    )}
                  >
                    {c.label}
                    {sort?.col === i ? (
                      sort.dir === 1 ? (
                        <ArrowUp className="h-3 w-3" />
                      ) : (
                        <ArrowDown className="h-3 w-3" />
                      )
                    ) : (
                      <ArrowUpDown className="h-3 w-3 opacity-0 transition-opacity group-hover/sort:opacity-60" />
                    )}
                  </button>
                </th>
              ))}
              {block.actions.length > 0 && (
                <th scope="col" className="px-4 py-2.5" aria-label="Acciones" />
              )}
              {open && <th scope="col" className="w-12 py-2.5 pr-5" aria-label="Ficha" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: el clic en la fila es un atajo; con el teclado se abre con el botón «Abrir la ficha» de la última celda.
              <tr
                key={r.id}
                onClick={
                  open
                    ? (e) => {
                        if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
                        open(r.id);
                      }
                    : undefined
                }
                className={clsx(
                  flash(block.id, r.id),
                  'group/row transition-colors duration-100 [&>td]:border-b [&>td]:border-border/60 [&:last-child>td]:border-0',
                  // Fila con la marca de duplicado: tono de alerta para corregirla antes de despachar.
                  r.alert ? 'bg-rose-soft hover:bg-rose-soft/70' : 'hover:bg-surface-2/60',
                  open && 'cursor-pointer',
                )}
              >
                {r.cells.map((cell, i) => {
                  const column = block.columns[i];
                  const className = clsx(
                    'px-4 py-3 align-middle first:pl-6 last:pr-6',
                    i === 0 ? 'font-semibold text-ink' : 'text-ink-muted',
                    column?.kind !== 'text' && 'tabular font-mono text-xs',
                    column?.kind === 'number' && 'text-right text-ink',
                  );
                  return column?.edit ? (
                    <EditableCell
                      key={column.key}
                      blockId={block.id}
                      rowId={r.id}
                      field={column.key}
                      edit={column.edit}
                      raw={r.sort[i] ?? null}
                      display={cell}
                      className={className}
                    />
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: las columnas son fijas por bloque.
                    <td key={i} className={className}>
                      {show(cell, i, r.sort[i])}
                    </td>
                  );
                })}
                {block.actions.length > 0 && (
                  <td className="whitespace-nowrap px-4 py-2.5 text-right align-middle">
                    <RowActions
                      blockId={block.id}
                      actions={block.actions}
                      rowId={r.id}
                      rowLabel={r.cells[0] ?? ''}
                    />
                  </td>
                )}
                {open && (
                  <td className="w-12 py-2 pr-5 text-right align-middle">
                    <button
                      type="button"
                      onClick={() => open(r.id)}
                      aria-label={`Abrir la ficha de ${r.cells[0] ?? 'esta fila'}`}
                      title="Abrir la ficha"
                      className="grid h-8 w-8 place-items-center rounded-pill text-ink-faint opacity-60 transition-all duration-150 hover:bg-primary-soft hover:text-primary group-hover/row:opacity-100"
                    >
                      <PanelRightOpen className="h-4 w-4" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <EmptyState
          className="mt-2"
          icon={<Search className="h-5 w-5" aria-hidden />}
          title={query ? 'Nada coincide con esa búsqueda' : 'Todavía no hay filas'}
          hint={query ? 'Prueba con otra palabra.' : 'Las filas nuevas aparecen aquí solas.'}
        />
      )}
      {block.total > block.rows.length && (
        <p className="mt-3 text-micro text-ink-faint">
          Se muestran {block.rows.length} de {block.total}.
        </p>
      )}
    </Card>
  );
}

/** Tono del punto de cada columna del tablero: el de su nombre si dice un estado. */
function columnDot(label: string, i: number): string {
  const tone = statusTone(label);
  if (tone) return TONE_BAR[tone];
  return ['bg-primary', 'bg-sky', 'bg-amber', 'bg-emerald', 'bg-rose'][i % 5] ?? 'bg-primary';
}

function Board({ block }: { block: Extract<ComputedBlock, { type: 'board' }> }) {
  const flash = useFlashClass();
  const writer = useViewWriter();
  const open = useRecordOpener(block.id, block.record);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const canDrag = Boolean(writer && block.dragField);
  async function moveTo(cardId: string, column: string) {
    if (!writer || !block.dragField || column === '__none') return;
    setMoveError(null);
    const res = await writer.edit(block.id, cardId, { [block.dragField]: column });
    if (!res.ok) setMoveError(res.error);
  }
  return (
    <Card title={block.title} source={block.source}>
      <div className="scroll-slim -mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
        {block.columns.map((col, ci) => (
          <div
            key={col.key}
            onDragOver={(e) => {
              if (!canDrag || col.key === '__none') return;
              e.preventDefault();
              setOver(col.key);
            }}
            onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData('text/plain') || dragging;
              setDragging(null);
              if (id) void moveTo(id, col.key);
            }}
            className={clsx(
              'flex w-[17rem] min-w-[16rem] flex-1 shrink-0 snap-start flex-col rounded-sm border border-border/60 bg-surface-2/70 p-2.5 transition-colors',
              over === col.key && 'border-primary/50 bg-primary-soft/60 ring-2 ring-primary/40',
            )}
          >
            <div className="mb-2.5 flex items-center justify-between gap-2 px-1.5 pt-0.5">
              <span className="flex min-w-0 items-center gap-2 text-xs font-bold text-ink">
                <span
                  aria-hidden
                  className={clsx('h-2 w-2 shrink-0 rounded-pill', columnDot(col.label, ci))}
                />
                <span className="truncate">{col.label}</span>
              </span>
              <span className="tabular rounded-pill bg-surface px-2 py-0.5 font-mono text-micro font-semibold text-ink-muted shadow-card">
                {col.count}
              </span>
            </div>
            <ul className="flex-1 space-y-2">
              {col.cards.map((card) => (
                <li
                  key={card.id}
                  draggable={canDrag}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', card.id);
                    setDragging(card.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                  className={clsx(
                    flash(block.id, card.id),
                    card.alert
                      ? 'rounded-sm border border-rose/50 bg-rose-soft p-3 shadow-card transition-all duration-150'
                      : 'rounded-sm border border-border bg-surface p-3 shadow-card transition-all duration-150 hover:border-border-strong',
                    canDrag && 'cursor-grab hover:-translate-y-px active:cursor-grabbing',
                    dragging === card.id && 'rotate-1 opacity-50',
                  )}
                >
                  {open ? (
                    <button
                      type="button"
                      onClick={() => open(card.id)}
                      className="text-left text-sm font-semibold text-ink underline-offset-4 hover:underline"
                    >
                      {card.label}
                    </button>
                  ) : (
                    <p className="text-sm font-semibold text-ink">{card.label}</p>
                  )}
                  {card.details.length > 0 && (
                    <dl className="mt-2 space-y-1">
                      {card.details.map((d) => (
                        <div key={d.label} className="flex justify-between gap-2 text-micro">
                          <dt className="shrink-0 text-ink-faint">{d.label}</dt>
                          <dd className="tabular truncate font-mono text-ink">
                            <RichValue kind={d.kind} raw={d.raw} text={d.value} size={28} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {(block.actions.length > 0 || canDrag) && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <RowActions
                        blockId={block.id}
                        actions={block.actions}
                        rowId={card.id}
                        rowLabel={card.label}
                      />
                      {canDrag && (
                        // En un teléfono no se arrastra: la misma acción, en un menú.
                        <select
                          aria-label={`Mover ${card.label}`}
                          value={col.key}
                          onChange={(e) => void moveTo(card.id, e.target.value)}
                          className="ml-auto rounded-pill border border-border bg-surface px-2 py-0.5 text-micro text-ink-muted sm:hidden"
                        >
                          {block.columns
                            .filter((c) => c.key !== '__none' || c.key === col.key)
                            .map((c) => (
                              <option key={c.key} value={c.key} disabled={c.key === '__none'}>
                                {c.label}
                              </option>
                            ))}
                        </select>
                      )}
                    </div>
                  )}
                </li>
              ))}
              {col.count > col.cards.length && (
                <li className="px-1.5 text-micro font-semibold text-ink-faint">
                  y {col.count - col.cards.length} más
                </li>
              )}
              {col.count === 0 && (
                <li className="grid min-h-[5rem] place-items-center rounded-sm border border-dashed border-border-strong/70 px-2 text-center text-micro text-ink-faint">
                  {canDrag ? 'Arrastra una tarjeta aquí' : 'Sin tarjetas'}
                </li>
              )}
            </ul>
          </div>
        ))}
      </div>
      {moveError && <p className="mt-2 text-xs text-rose">{moveError}</p>}
    </Card>
  );
}
