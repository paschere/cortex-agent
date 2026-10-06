'use client';

import type {
  DataGridProps,
  GridColumn,
  GridColumnType,
  GridRow,
  GridView,
} from '@/components/datagrid/types';
import { csvFileName, toCsv } from '@/lib/datagrid/csv';
import { bogotaDay, formatNumber } from '@/lib/datagrid/format';
import { VIEW_PARAM, decodeView, encodeView, searchWithView } from '@/lib/datagrid/url';
import {
  type GridGroup,
  activeFilterCount,
  applyView,
  buildSearchIndex,
  describeFilter,
  isActiveFilter,
  normalizeView,
  visibleColumns,
} from '@/lib/datagrid/view';
import { clsx } from 'clsx';
import {
  ArrowUpDown,
  Bookmark,
  Columns3,
  Download,
  Group,
  ListFilter,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { TableLayout } from './TableLayout';
import {
  AddColumnDialog,
  BulkEditDialog,
  ConfirmDialog,
  NewRowDialog,
  RowDrawer,
  Sheet,
} from './dialogs';
import { BoardLayout, CalendarLayout, CardsLayout, titleColumn } from './layouts';
import {
  ColumnsPanel,
  FilterPanel,
  GroupPanel,
  LAYOUTS,
  LayoutPanel,
  SortPanel,
  ViewsPanel,
  boardColumns,
  dateColumns,
} from './panels';
import {
  PopoverButton,
  Toasts,
  errorText,
  ghostButton,
  primaryButton,
  toolbarButton,
  useIsMobile,
  useToasts,
} from './primitives';

/**
 * EL VISUALIZADOR DE DATOS DE CORTEX.
 *
 * Un componente para ver, buscar, filtrar, ordenar, agrupar, crear y editar
 * filas, en tabla, tablero, tarjetas o calendario. El contrato está en
 * `./types.ts`; el motor (filtrar, ordenar, agrupar, CSV, la vista en la URL)
 * en `lib/datagrid/*`, puro y probado.
 *
 * CAMBIOS POR ADELANTADO. Editar, mover, crear y borrar se ven al instante; si
 * la pantalla dice que no (`onEdit` lanza), el valor vuelve a lo que era y un
 * aviso dice por qué. Nunca queda en pantalla algo que no se guardó.
 *
 * LA VISTA EN LA URL. Lo que se filtra viaja en `?vista=…` (con
 * `history.replaceState`, sin navegar), así que copiar el enlace comparte
 * exactamente lo que se ve.
 */

const PAGE = 500;
const ALL_TYPES: GridColumnType[] = [
  'text',
  'long_text',
  'number',
  'money',
  'percent',
  'date',
  'datetime',
  'select',
  'status',
  'multi_select',
  'person',
  'boolean',
  'link',
  'email',
  'phone',
];

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const empty = (v: unknown) =>
    v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
  if (empty(a) && empty(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** La forma de una vista sin su identidad: para saber si cambió. */
function shapeKey(view: Partial<GridView>): string {
  const { id: _i, name: _n, shared: _s, canManage: _c, ...rest } = view;
  return encodeView(rest);
}

function queryKey(view: GridView): string {
  return JSON.stringify([view.search ?? '', view.filters, view.match, view.sort, view.groupBy]);
}

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DataGrid(props: DataGridProps) {
  const {
    rows: propRows,
    savedViews,
    onQuery,
    onEdit,
    onCreate,
    onDelete,
    onBulkEdit,
    onAddColumn,
    onSaveView,
    onDeleteView,
  } = props;
  const noun = props.noun ?? { one: 'fila', many: 'filas' };
  const fem = noun.gender ? noun.gender === 'f' : /a$/i.test(noun.one.trim());
  const words = {
    nuevo: fem ? 'Nueva' : 'Nuevo',
    ninguno: fem ? 'Ninguna' : 'Ningún',
    este: fem ? 'esta' : 'este',
    o: fem ? 'a' : 'o',
  };
  const One = `${noun.one.charAt(0).toUpperCase()}${noun.one.slice(1)}`;
  const urlParam = props.urlParam === false ? null : (props.urlParam ?? VIEW_PARAM);
  const gridId = useId().replace(/[:«»]/g, '');
  const router = useRouter();
  const mobile = useIsMobile();
  const { toasts, push, dismiss } = useToasts();

  // --- Columnas ---------------------------------------------------------------
  const [extraColumns, setExtraColumns] = useState<GridColumn[]>([]);
  const columns = useMemo(
    () => [
      ...props.columns,
      ...extraColumns.filter((c) => !props.columns.some((p) => p.key === c.key)),
    ],
    [props.columns, extraColumns],
  );

  // --- La vista -----------------------------------------------------------------
  const baseView = useMemo(
    () => normalizeView(columns, props.initialView),
    [columns, props.initialView],
  );
  const [view, setViewState] = useState<GridView>(() =>
    normalizeView(props.columns, props.initialView),
  );
  const setView = useCallback(
    (update: (v: GridView) => GridView) => setViewState((v) => update(v)),
    [],
  );
  const mounted = useRef(false);

  // La vista que trae el enlace gana a la inicial, pero solo después de montar
  // (el servidor no ve la URL completa y el primer dibujo tiene que coincidir).
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al montar.
  useEffect(() => {
    if (urlParam) {
      const fromUrl = decodeView(
        new URLSearchParams(window.location.search).get(urlParam),
        columns,
      );
      if (fromUrl) setViewState(fromUrl);
    }
    mounted.current = true;
  }, []);

  useEffect(() => {
    if (!mounted.current || !urlParam) return;
    const t = window.setTimeout(() => {
      const differs = shapeKey(view) !== shapeKey(baseView) || Boolean(view.id);
      const next = `${window.location.pathname}${searchWithView(window.location.search, differs ? view : null, urlParam)}${window.location.hash}`;
      if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`)
        window.history.replaceState(window.history.state, '', next);
    }, 250);
    return () => window.clearTimeout(t);
  }, [view, baseView, urlParam]);

  // --- Filas (con cambios por adelantado) --------------------------------------
  const [rows, setRows] = useState<GridRow[]>(propRows);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const serverMode = Boolean(onQuery) && (props.total ?? propRows.length) > propRows.length;
  const [serverTotal, setServerTotal] = useState(props.total ?? propRows.length);
  const [loading, setLoading] = useState(false);
  const lastQuery = useRef(queryKey(normalizeView(props.columns, props.initialView)));

  useEffect(() => {
    setRows(propRows);
    setServerTotal(props.total ?? propRows.length);
  }, [propRows, props.total]);

  const [saved, setSaved] = useState<GridView[]>(savedViews ?? []);
  useEffect(() => setSaved(savedViews ?? []), [savedViews]);

  // --- Búsqueda (con un respiro para no filtrar en cada tecla) ------------------
  const [searchText, setSearchText] = useState(view.search ?? '');
  useEffect(() => setSearchText(view.search ?? ''), [view.search]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if ((view.search ?? '') !== searchText) setView((v) => ({ ...v, search: searchText }));
    }, 160);
    return () => window.clearTimeout(t);
  }, [searchText, view.search, setView]);

  // --- Paginación en el servidor -------------------------------------------------
  useEffect(() => {
    if (!serverMode || !onQuery) return;
    const key = queryKey(view);
    if (key === lastQuery.current) return;
    const t = window.setTimeout(async () => {
      lastQuery.current = key;
      setLoading(true);
      try {
        const res = await onQuery(view, { offset: 0, limit: PAGE });
        if (lastQuery.current !== key) return;
        setRows(res.rows);
        setServerTotal(res.total);
      } catch (err) {
        push('error', errorText(err, 'No se pudieron traer las filas. Intenta de nuevo.'));
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [serverMode, onQuery, view, push]);

  const loadMore = useCallback(async () => {
    if (!serverMode || !onQuery || loading || rowsRef.current.length >= serverTotal) return;
    setLoading(true);
    const key = lastQuery.current;
    try {
      const res = await onQuery(view, { offset: rowsRef.current.length, limit: PAGE });
      if (key !== lastQuery.current) return;
      setRows((rs) => {
        const seen = new Set(rs.map((r) => r.id));
        return [...rs, ...res.rows.filter((r) => !seen.has(r.id))];
      });
      setServerTotal(res.total);
    } catch (err) {
      push('error', errorText(err, 'No se pudieron traer más filas.'));
    } finally {
      setLoading(false);
    }
  }, [serverMode, onQuery, loading, serverTotal, view, push]);

  // --- Aplicar la vista ------------------------------------------------------------
  const deferredView = useDeferredValue(view);
  const needsIndex = !serverMode && Boolean(deferredView.search?.trim());
  const searchIndex = useMemo(
    () => (needsIndex ? buildSearchIndex(rows, columns) : undefined),
    [needsIndex, rows, columns],
  );
  const result = useMemo(
    () =>
      applyView(
        rows,
        columns,
        serverMode ? { sort: deferredView.sort, groupBy: deferredView.groupBy } : deferredView,
        { searchIndex },
      ),
    [rows, columns, deferredView, serverMode, searchIndex],
  );
  const shownColumns = useMemo(() => visibleColumns(columns, view), [columns, view]);
  const people = useMemo(() => {
    if (props.people) return props.people;
    const set = new Set<string>();
    for (const c of columns)
      if (c.type === 'person')
        for (const r of rows.slice(0, 3000)) {
          const v = r.values[c.key];
          if (typeof v === 'string' && v.trim()) set.add(v.trim());
        }
    return [...set].sort((a, b) => a.localeCompare(b, 'es'));
  }, [props.people, columns, rows]);

  // --- Selección ---------------------------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastToggled = useRef<number | null>(null);
  const visibleIds = result.rows;
  const toggleRow = useCallback(
    (id: string, index: number, range: boolean) => {
      setSelected((s) => {
        const next = new Set(s);
        if (range && lastToggled.current !== null) {
          const [a, b] = [
            Math.min(lastToggled.current, index),
            Math.max(lastToggled.current, index),
          ];
          const on = !s.has(id);
          for (const r of visibleIds.slice(a, b + 1)) {
            if (on) next.add(r.id);
            else next.delete(r.id);
          }
        } else if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      lastToggled.current = index;
    },
    [visibleIds],
  );
  const toggleAll = useCallback(() => {
    setSelected((s) =>
      s.size && visibleIds.every((r) => s.has(r.id))
        ? new Set()
        : new Set(visibleIds.map((r) => r.id)),
    );
  }, [visibleIds]);
  useEffect(() => {
    // Lo marcado que ya no existe deja de contar.
    setSelected((s) => {
      if (!s.size) return s;
      const ids = new Set(rows.map((r) => r.id));
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [rows]);
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);

  // --- Escribir ------------------------------------------------------------------------
  const patchRows = useCallback(
    (ids: Set<string>, key: string, value: unknown, onlyIf?: unknown) => {
      setRows((rs) =>
        rs.map((r) =>
          ids.has(r.id) && (onlyIf === undefined || same(r.values[key], onlyIf))
            ? { ...r, values: { ...r.values, [key]: value } }
            : r,
        ),
      );
    },
    [],
  );

  const editCell = useCallback(
    async (rowId: string, key: string, value: unknown) => {
      if (!onEdit) return;
      const row = rowsRef.current.find((r) => r.id === rowId);
      if (!row) return;
      const prev = row.values[key];
      if (same(prev, value)) return;
      const col = columns.find((c) => c.key === key);
      patchRows(new Set([rowId]), key, value);
      try {
        await onEdit(rowId, key, value);
      } catch (err) {
        setRows((rs) =>
          rs.map((r) =>
            r.id === rowId && same(r.values[key], value)
              ? { ...r, values: { ...r.values, [key]: prev } }
              : r,
          ),
        );
        push(
          'error',
          errorText(err, `No se pudo guardar «${col?.label ?? key}». Volvió a su valor anterior.`),
        );
      }
    },
    [onEdit, columns, patchRows, push],
  );

  const bulkEdit = async (key: string, value: unknown) => {
    const ids = [...selected];
    if (!ids.length || (!onBulkEdit && !onEdit)) return;
    const before = new Map(
      rowsRef.current.filter((r) => selected.has(r.id)).map((r) => [r.id, r.values[key]]),
    );
    patchRows(new Set(ids), key, value);
    try {
      if (onBulkEdit) await onBulkEdit(ids, key, value);
      else if (onEdit) for (const id of ids) await onEdit(id, key, value);
      push(
        'ok',
        `Listo: ${formatNumber(ids.length, 0)} ${ids.length === 1 ? noun.one : noun.many} cambiad${words.o}${ids.length === 1 ? '' : 's'}.`,
      );
    } catch (err) {
      setRows((rs) =>
        rs.map((r) =>
          before.has(r.id) ? { ...r, values: { ...r.values, [key]: before.get(r.id) } } : r,
        ),
      );
      push('error', errorText(err, 'No se pudo aplicar el cambio. Todo volvió a como estaba.'));
    }
  };

  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const deleteRows = async (ids: string[]) => {
    if (!onDelete || !ids.length) return;
    const snapshot = rowsRef.current;
    const gone = new Set(ids);
    setRows((rs) => rs.filter((r) => !gone.has(r.id)));
    setSelected(new Set());
    setDetailId((d) => (d && gone.has(d) ? null : d));
    if (serverMode) setServerTotal((t) => Math.max(0, t - ids.length));
    try {
      await onDelete(ids);
      push(
        'ok',
        ids.length === 1
          ? `Se borró 1 ${noun.one}.`
          : `Se borraron ${formatNumber(ids.length, 0)} ${noun.many}.`,
      );
    } catch (err) {
      setRows(snapshot);
      if (serverMode) setServerTotal((t) => t + ids.length);
      push('error', errorText(err, 'No se pudo borrar. Nada cambió.'));
    }
  };

  const [newRow, setNewRow] = useState<Record<string, unknown> | null>(null);
  const createRow = async (values: Record<string, unknown>): Promise<boolean> => {
    if (!onCreate) return false;
    try {
      const row = await onCreate(values);
      setRows((rs) => [row, ...rs.filter((r) => r.id !== row.id)]);
      if (serverMode) setServerTotal((t) => t + 1);
      push('ok', `${One} cread${words.o}.`);
      return true;
    } catch (err) {
      push('error', errorText(err, `No se pudo crear: ${noun.one} sin guardar.`));
      return false;
    }
  };
  const createInGroup = (group: GridGroup) => {
    const key = view.layout === 'board' ? view.layoutKey : view.groupBy;
    setNewRow(key && group.value !== null ? { [key]: group.value } : {});
  };

  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const addColumn = async (input: {
    label: string;
    type: GridColumnType;
    options?: string[];
    required: boolean;
  }) => {
    if (!onAddColumn) return false;
    try {
      const col = await onAddColumn({
        label: input.label,
        type: input.type,
        required: input.required,
        editable: true,
        ...(input.options ? { options: input.options.map((value) => ({ value })) } : {}),
      });
      setExtraColumns((cs) => [...cs.filter((c) => c.key !== col.key), col]);
      setView((v) => ({ ...v, hidden: v.hidden.filter((k) => k !== col.key) }));
      push('ok', `Columna «${col.label}» agregada.`);
      return true;
    } catch (err) {
      push('error', errorText(err, 'No se pudo agregar la columna.'));
      return false;
    }
  };

  // --- Abrir una fila ------------------------------------------------------------------
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailRow = detailId ? (rows.find((r) => r.id === detailId) ?? null) : null;
  const openRow = useCallback(
    (row: GridRow) => {
      if (row.href) router.push(row.href);
      else setDetailId(row.id);
    },
    [router],
  );

  // --- Vistas guardadas ------------------------------------------------------------------
  const activeSaved = saved.find((v) => v.id && v.id === view.id);
  const dirty = activeSaved
    ? shapeKey(activeSaved) !== shapeKey(view)
    : shapeKey(view) !== shapeKey(baseView);
  const saveView = async (input: { name: string; shared: boolean; asNew: boolean }) => {
    if (!onSaveView) return;
    try {
      const { id: _id, ...rest } = view;
      const out = await onSaveView({
        ...rest,
        ...(input.asNew ? {} : { id: view.id }),
        name: input.name,
        shared: input.shared,
      });
      setSaved((s) =>
        [...s.filter((x) => x.id !== out.id), out].sort((a, b) =>
          (a.name ?? '').localeCompare(b.name ?? '', 'es'),
        ),
      );
      setViewState((v) => ({ ...v, id: out.id, name: out.name }));
      push(
        'ok',
        input.asNew ? `Vista «${out.name}» guardada.` : `Cambios guardados en «${out.name}».`,
      );
    } catch (err) {
      push('error', errorText(err, 'No se pudo guardar la vista.'));
    }
  };
  const renameView = async (v: GridView, name: string) => {
    if (!onSaveView) return;
    try {
      const out = await onSaveView({ ...v, name });
      setSaved((s) => s.map((x) => (x.id === out.id ? out : x)));
      if (view.id === out.id) setViewState((cur) => ({ ...cur, name: out.name }));
    } catch (err) {
      push('error', errorText(err, 'No se pudo renombrar la vista.'));
    }
  };
  const removeView = async (v: GridView) => {
    if (!onDeleteView || !v.id) return;
    try {
      await onDeleteView(v.id);
      setSaved((s) => s.filter((x) => x.id !== v.id));
      if (view.id === v.id) setViewState((cur) => ({ ...cur, id: undefined, name: undefined }));
      push('ok', `Vista «${v.name}» borrada.`);
    } catch (err) {
      push('error', errorText(err, 'No se pudo borrar la vista.'));
    }
  };
  const copyLink = async () => {
    try {
      const url = new URL(window.location.href);
      const encoded = encodeView(view);
      if (urlParam) {
        if (encoded) url.searchParams.set(urlParam, encoded);
        else url.searchParams.delete(urlParam);
      }
      await navigator.clipboard.writeText(url.toString());
      push('ok', 'Enlace copiado: abre exactamente esta vista.');
    } catch {
      push('error', 'No se pudo copiar el enlace.');
    }
  };

  // --- Exportar ------------------------------------------------------------------------
  const [exporting, setExporting] = useState(false);
  const exportCsv = async (only?: GridRow[]) => {
    let list = only ?? result.rows;
    if (!only && serverMode && onQuery && rows.length < serverTotal) {
      setExporting(true);
      try {
        const all: GridRow[] = [];
        for (let offset = 0; offset < Math.min(serverTotal, 50_000); offset += 2000) {
          const res = await onQuery(view, { offset, limit: 2000 });
          all.push(...res.rows);
          if (res.rows.length < 2000) break;
        }
        list = applyView(all, columns, { sort: view.sort, groupBy: view.groupBy }).rows;
      } catch (err) {
        push('error', errorText(err, 'No se pudo exportar.'));
        setExporting(false);
        return;
      }
      setExporting(false);
    }
    download(
      csvFileName(props.exportName ?? noun.many, bogotaDay(new Date())),
      toCsv(list, shownColumns),
    );
    push(
      'ok',
      `${formatNumber(list.length, 0)} ${list.length === 1 ? noun.one : noun.many} exportad${words.o}${list.length === 1 ? '' : 's'}.`,
    );
  };

  // --- Pedírselo a Cortex ----------------------------------------------------------------
  const askHref = useMemo(() => {
    if (!props.askCortexContext) return null;
    const filters = view.filters
      .filter(isActiveFilter)
      .map((f) => {
        const c = columns.find((x) => x.key === f.key);
        return c ? describeFilter(c, f) : null;
      })
      .filter(Boolean);
    const bits = [
      props.askCortexContext,
      filters.length
        ? `Estoy mirando las que cumplen: ${filters.join(view.match === 'any' ? ' o ' : '; ')}.`
        : '',
      view.search ? `Con la búsqueda «${view.search}».` : '',
      `Son ${formatNumber(serverMode ? serverTotal : result.rows.length, 0)} ${noun.many}.`,
    ].filter(Boolean);
    return `/chat?prompt=${encodeURIComponent(bits.join(' ').slice(0, 1800))}`;
  }, [
    props.askCortexContext,
    view,
    columns,
    serverMode,
    serverTotal,
    result.rows.length,
    noun.many,
  ]);

  // --- Diseño activo -------------------------------------------------------------------
  const boardCol =
    columns.find((c) => c.key === view.layoutKey && boardColumns([c]).length) ??
    boardColumns(columns)[0];
  const dateCol =
    columns.find((c) => c.key === view.layoutKey && dateColumns([c]).length) ??
    dateColumns(columns)[0];
  const layout =
    view.layout === 'board' && !boardCol
      ? 'table'
      : view.layout === 'calendar' && !dateCol
        ? 'table'
        : view.layout;
  const canEdit = Boolean(onEdit);
  const filterCount = activeFilterCount(view) + (view.search?.trim() ? 1 : 0);
  const height = props.height ?? 'max(420px, calc(100dvh - 280px))';
  const total = serverMode ? serverTotal : rows.length;
  const shown = serverMode ? serverTotal : result.rows.length;
  const totalLabel =
    shown === total
      ? `${formatNumber(total, 0)} ${total === 1 ? noun.one : noun.many}`
      : `${formatNumber(shown, 0)} de ${formatNumber(total, 0)} ${noun.many}`;
  const [sheetOpen, setSheetOpen] = useState(false);
  const title = titleColumn(columns);

  // --- Dibujar -------------------------------------------------------------------------
  const clearAll = () => {
    setSearchText('');
    setView((v) => ({ ...v, search: '', filters: [] }));
  };

  const filterChips = view.filters.filter(isActiveFilter);
  const searchBox = (
    <label className={clsx('relative flex items-center', mobile ? 'min-w-0 flex-1' : 'w-64')}>
      <Search className="pointer-events-none absolute left-3 h-4 w-4 text-ink-faint" aria-hidden />
      <input
        type="search"
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        placeholder={`Buscar ${noun.many}…`}
        aria-label={`Buscar ${noun.many}`}
        className="h-9 w-full rounded-pill border border-border bg-surface pl-9 pr-3 text-xs text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
    </label>
  );

  const viewsPanel = (close: () => void) => (
    <ViewsPanel
      views={saved}
      current={view}
      dirty={dirty}
      canSave={Boolean(onSaveView)}
      canDelete={Boolean(onDeleteView)}
      onApply={(v) => {
        setViewState(normalizeView(columns, v));
        close();
      }}
      onSave={saveView}
      onRename={renameView}
      onDelete={removeView}
      onReset={() => {
        setViewState(baseView);
        close();
      }}
      onCopyLink={() => {
        void copyLink();
        close();
      }}
    />
  );
  const hasViews = Boolean(onSaveView || saved.length);
  const viewsButton = hasViews ? (
    <PopoverButton
      title="Vistas guardadas"
      label={view.name ? <span className="max-w-[140px] truncate">{view.name}</span> : 'Vistas'}
      icon={<Bookmark className="h-4 w-4" aria-hidden />}
      active={Boolean(view.id)}
      width={340}
    >
      {viewsPanel}
    </PopoverButton>
  ) : null;

  const LayoutIcon = LAYOUTS.find((l) => l.id === layout)?.icon ?? SlidersHorizontal;

  const body = (() => {
    if (!rows.length && !loading && !filterCount && !serverMode) {
      const empty = props.emptyState;
      return (
        <div className="rounded-card border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
          <p className="text-base font-bold text-ink">
            {empty?.title ?? `Todavía no hay ${noun.many}`}
          </p>
          {empty?.body ? (
            <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">{empty.body}</p>
          ) : null}
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {onCreate ? (
              <button type="button" onClick={() => setNewRow({})} className={primaryButton}>
                <Plus className="h-4 w-4" aria-hidden />
                {words.nuevo} {noun.one}
              </button>
            ) : null}
            {empty?.action ? (
              <Link href={empty.action.href} className={toolbarButton}>
                {empty.action.label}
              </Link>
            ) : null}
          </div>
        </div>
      );
    }
    if (!result.rows.length) {
      return (
        <div className="rounded-card border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
          {loading ? (
            <p className="inline-flex items-center gap-2 text-sm text-ink-muted">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
              Buscando…
            </p>
          ) : (
            <>
              <p className="text-base font-bold text-ink">
                {words.ninguno} {noun.one} coincide
              </p>
              <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">
                {filterCount
                  ? 'Prueba con menos filtros o con otra búsqueda.'
                  : `No hay ${noun.many} aquí.`}
              </p>
              {filterCount ? (
                <button type="button" onClick={clearAll} className={clsx(toolbarButton, 'mt-5')}>
                  <X className="h-4 w-4" aria-hidden />
                  Quitar filtros y búsqueda
                </button>
              ) : null}
            </>
          )}
        </div>
      );
    }
    const visibleCols = shownColumns;
    if (layout === 'board' && boardCol)
      return (
        <BoardLayout
          columns={visibleCols}
          rows={result.rows}
          groupColumn={boardCol}
          canMove={canEdit && boardCol.editable !== false}
          onMove={(row, value) => void editCell(row.id, boardCol.key, value)}
          onOpen={openRow}
          onCreateInGroup={onCreate ? createInGroup : null}
          height={height}
        />
      );
    if (layout === 'calendar' && dateCol)
      return (
        <CalendarLayout
          columns={visibleCols}
          rows={result.rows}
          dateColumn={dateCol}
          canMove={canEdit && dateCol.editable !== false}
          onMove={(row, value) => void editCell(row.id, dateCol.key, value)}
          onOpen={openRow}
          mobile={mobile}
        />
      );
    if (layout === 'cards' || mobile)
      return (
        <CardsLayout
          columns={visibleCols}
          rows={result.rows}
          onOpen={openRow}
          selected={selected}
          onToggle={
            onDelete || onBulkEdit || onEdit
              ? (id) =>
                  toggleRow(
                    id,
                    result.rows.findIndex((r) => r.id === id),
                    false,
                  )
              : null
          }
          mobile={mobile}
          flashIds={props.flashIds}
        />
      );
    return (
      <TableLayout
        flashIds={props.flashIds}
        gridId={gridId}
        columns={visibleCols}
        rows={result.rows}
        groups={result.groups}
        view={view}
        setView={setView}
        selected={selected}
        onToggleRow={toggleRow}
        onToggleAll={toggleAll}
        canEdit={canEdit}
        onCellEdit={(id, key, value) => void editCell(id, key, value)}
        onOpenRow={openRow}
        onAddColumn={onAddColumn ? () => setAddColumnOpen(true) : null}
        onCreateInGroup={onCreate && view.groupBy ? createInGroup : null}
        onEndReached={serverMode ? loadMore : undefined}
        height={height}
        people={people}
        noun={noun}
        totalLabel={totalLabel}
        onCopy={(text) => {
          void navigator.clipboard?.writeText(text).then(() => push('ok', 'Copiado.'));
        }}
      />
    );
  })();

  return (
    <div className="flex flex-col gap-3" data-datagrid="">
      {/* Barra de herramientas */}
      <div
        className="flex flex-wrap items-center gap-2"
        role="toolbar"
        aria-label={`Herramientas de ${noun.many}`}
      >
        {searchBox}
        {mobile ? (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className={clsx(
              toolbarButton,
              filterCount && 'border-primary/30 bg-primary-soft text-primary-ink',
            )}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            Filtros
            {filterCount ? <span className="tabular">{filterCount}</span> : null}
          </button>
        ) : (
          <>
            <PopoverButton
              title="Filtros"
              label="Filtros"
              icon={<ListFilter className="h-4 w-4" aria-hidden />}
              badge={activeFilterCount(view)}
              width={460}
            >
              {() => <FilterPanel columns={columns} view={view} setView={setView} />}
            </PopoverButton>
            <PopoverButton
              title="Ordenar"
              label="Ordenar"
              icon={<ArrowUpDown className="h-4 w-4" aria-hidden />}
              badge={view.sort.length}
              width={400}
            >
              {() => <SortPanel columns={columns} view={view} setView={setView} />}
            </PopoverButton>
            <PopoverButton
              title="Agrupar por"
              label={
                view.groupBy ? (
                  <span className="max-w-[120px] truncate">
                    {columns.find((c) => c.key === view.groupBy)?.label ?? 'Agrupar'}
                  </span>
                ) : (
                  'Agrupar'
                )
              }
              icon={<Group className="h-4 w-4" aria-hidden />}
              active={Boolean(view.groupBy)}
              width={260}
            >
              {(close) => (
                <GroupPanel columns={columns} view={view} setView={setView} close={close} />
              )}
            </PopoverButton>
            <PopoverButton
              title="Columnas"
              label="Columnas"
              icon={<Columns3 className="h-4 w-4" aria-hidden />}
              badge={view.hidden.length || undefined}
              width={320}
            >
              {() => <ColumnsPanel columns={columns} view={view} setView={setView} />}
            </PopoverButton>
            <PopoverButton
              title="Diseño"
              label={LAYOUTS.find((l) => l.id === layout)?.label ?? 'Diseño'}
              icon={<LayoutIcon className="h-4 w-4" aria-hidden />}
              width={360}
            >
              {() => <LayoutPanel columns={columns} view={view} setView={setView} />}
            </PopoverButton>
            {viewsButton}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {loading ? (
            <LoaderCircle className="h-4 w-4 animate-spin text-ink-faint" aria-label="Cargando" />
          ) : null}
          {!mobile ? (
            <button
              type="button"
              onClick={() => void exportCsv()}
              disabled={exporting || !result.rows.length}
              className={toolbarButton}
              title="Exportar lo que ves a CSV (Excel)"
            >
              <Download className="h-4 w-4" aria-hidden />
              {exporting ? 'Exportando…' : 'Exportar'}
            </button>
          ) : null}
          {askHref && !mobile ? (
            <Link href={askHref} className={toolbarButton}>
              <Sparkles className="h-4 w-4 text-primary" aria-hidden />
              Pídeselo a Cortex
            </Link>
          ) : null}
          {onCreate ? (
            <button
              type="button"
              onClick={() => setNewRow({})}
              className={primaryButton}
              aria-label={`${words.nuevo} ${noun.one}`}
            >
              <Plus className="h-4 w-4" aria-hidden />
              {mobile ? null : 'Nuevo'}
            </button>
          ) : null}
        </div>
      </div>

      {/* Filtros activos, en palabras */}
      {filterChips.length || view.search?.trim() ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Filtros activos">
          {view.search?.trim() ? (
            <span className="inline-flex items-center gap-1 rounded-pill bg-surface-2 py-1 pl-3 pr-1 text-micro font-semibold text-ink">
              «{view.search.trim()}»
              <button
                type="button"
                onClick={() => setSearchText('')}
                className="grid h-5 w-5 place-items-center rounded-pill hover:bg-surface"
                aria-label="Quitar búsqueda"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ) : null}
          {filterChips.map((f) => {
            const c = columns.find((x) => x.key === f.key);
            if (!c) return null;
            const i = view.filters.indexOf(f);
            return (
              <span
                key={`${f.key}-${i}`}
                className="inline-flex max-w-full items-center gap-1 rounded-pill bg-primary-soft py-1 pl-3 pr-1 text-micro font-semibold text-primary-ink"
              >
                <span className="truncate">{describeFilter(c, f)}</span>
                <button
                  type="button"
                  onClick={() =>
                    setView((v) => ({ ...v, filters: v.filters.filter((_, j) => j !== i) }))
                  }
                  className="grid h-5 w-5 shrink-0 place-items-center rounded-pill hover:bg-surface"
                  aria-label={`Quitar ${describeFilter(c, f)}`}
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            );
          })}
          {filterChips.length > 1 ? (
            <span className="text-micro text-ink-faint">
              {view.match === 'any' ? '(basta una)' : '(todas)'}
            </span>
          ) : null}
          <button type="button" onClick={clearAll} className={clsx(ghostButton, 'h-7')}>
            Limpiar
          </button>
          <span className="tabular ml-auto text-micro text-ink-muted" aria-live="polite">
            {totalLabel}
          </span>
        </div>
      ) : null}

      {/* Lo marcado */}
      {selected.size ? (
        <section
          className="flex flex-wrap items-center gap-2 rounded-pill border border-primary/20 bg-primary-soft px-3 py-1.5"
          aria-label="Filas marcadas"
        >
          <span className="tabular text-xs font-bold text-primary-ink">
            {formatNumber(selected.size, 0)} {selected.size === 1 ? noun.one : noun.many} marcad
            {words.o}
            {selected.size === 1 ? '' : 's'}
          </span>
          {onEdit || onBulkEdit ? (
            <BulkButton
              columns={columns}
              count={selected.size}
              people={people}
              onSubmit={(k, v) => void bulkEdit(k, v)}
            />
          ) : null}
          <button
            type="button"
            onClick={() => void exportCsv(selectedRows)}
            className={ghostButton}
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            Exportar
          </button>
          {onDelete ? (
            <button
              type="button"
              onClick={() => setConfirmIds([...selected])}
              className={clsx(ghostButton, 'text-rose hover:bg-rose-soft hover:text-rose')}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Borrar
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className={clsx(ghostButton, 'ml-auto')}
          >
            Quitar selección
          </button>
        </section>
      ) : null}

      {body}

      {mobile && result.rows.length ? (
        <p className="tabular text-center text-micro text-ink-faint">{totalLabel}</p>
      ) : null}

      {/* Lo que se abre encima */}
      <NewRowDialog
        open={newRow !== null}
        onOpenChange={(o) => !o && setNewRow(null)}
        columns={columns}
        initial={newRow ?? {}}
        title={`${words.nuevo} ${noun.one}`}
        submitLabel={`Crear ${noun.one}`}
        people={people}
        onSubmit={createRow}
      />
      <RowDrawer
        row={detailRow}
        columns={columns}
        onOpenChange={(o) => !o && setDetailId(null)}
        title={
          detailRow && title
            ? String(detailRow.values[title.key] ?? '').trim() || 'Detalle'
            : 'Detalle'
        }
        canEdit={canEdit}
        people={people}
        onSave={(key, value) => detailRow && void editCell(detailRow.id, key, value)}
        onDelete={onDelete && detailRow ? () => setConfirmIds([detailRow.id]) : null}
        custom={detailRow && props.renderRowDetail ? props.renderRowDetail(detailRow) : undefined}
        extra={detailRow && props.renderRowExtra ? props.renderRowExtra(detailRow) : undefined}
      />
      {onAddColumn ? (
        <AddColumnDialog
          open={addColumnOpen}
          onOpenChange={setAddColumnOpen}
          types={props.addColumnTypes ?? ALL_TYPES}
          onSubmit={addColumn}
        />
      ) : null}
      <ConfirmDialog
        open={confirmIds !== null}
        onOpenChange={(o) => !o && setConfirmIds(null)}
        title={
          confirmIds?.length === 1
            ? `¿Borrar ${words.este} ${noun.one}?`
            : `¿Borrar ${confirmIds?.length ?? 0} ${noun.many}?`
        }
        body="No se puede deshacer desde aquí."
        confirm="Borrar"
        onConfirm={() => confirmIds && void deleteRows(confirmIds)}
      />
      {mobile ? (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen} side="bottom" title="Filtrar y ordenar">
          <div className="flex flex-col gap-6">
            <FilterPanel columns={columns} view={view} setView={setView} />
            <SortPanel columns={columns} view={view} setView={setView} />
            <LayoutPanel columns={columns} view={view} setView={setView} />
            {hasViews ? viewsPanel(() => setSheetOpen(false)) : null}
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <button type="button" onClick={() => void exportCsv()} className={toolbarButton}>
                <Download className="h-4 w-4" aria-hidden />
                Exportar
              </button>
              {askHref ? (
                <Link href={askHref} className={toolbarButton}>
                  <Sparkles className="h-4 w-4 text-primary" aria-hidden />
                  Pídeselo a Cortex
                </Link>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setSheetOpen(false)}
              className={clsx(primaryButton, 'justify-center')}
            >
              Ver {totalLabel}
            </button>
          </div>
        </Sheet>
      ) : null}
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

function BulkButton({
  columns,
  count,
  people,
  onSubmit,
}: {
  columns: GridColumn[];
  count: number;
  people?: string[];
  onSubmit: (key: string, value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={ghostButton}>
        <Pencil className="h-3.5 w-3.5" aria-hidden />
        Cambiar un campo
      </button>
      {open ? (
        <BulkEditDialog
          open={open}
          onOpenChange={setOpen}
          columns={columns}
          count={count}
          people={people}
          onSubmit={onSubmit}
        />
      ) : null}
    </>
  );
}

export default DataGrid;
