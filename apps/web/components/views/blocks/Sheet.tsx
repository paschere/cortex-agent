'use client';

import { sheetCsv, sheetMatrix } from '@cortex/agent-tools/src/views/sheet-export';
import {
  type EditChange,
  EditHistory,
  duplicateValues,
  ghostValues,
  groupByRow,
  groupProgress,
  looksLikeStatusColumn,
  planFill,
  rangeStats,
  statusTone as finalTone,
} from '@cortex/agent-tools/src/views/sheet-edit';
import { sheetTotalDisplay } from '@cortex/agent-tools/src/views/sheet-math';
import {
  PASTE_MAX_ROWS,
  type PasteField,
  buildPasteRows,
  mapPasteColumns,
  normalizePasteCell,
  parseClipboard,
  toClipboard,
} from '@cortex/agent-tools/src/views/sheet-paste';
import * as Dialog from '@radix-ui/react-dialog';
import * as ExportMenuUi from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  Filter,
  Loader2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelRightOpen,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '@/lib/ui/dialog-queue';
import type { SubmitTarget } from '../ViewCanvas';
import { useFlashClass } from '../flash-context';
import { RowActions, checkCell, useViewWriter } from '../view-writes';
import { parseRelation } from './RelationPicker';
import { useRecordOpener } from './RecordDrawer';
import { RelationCombo, RelationField, relationLabel, relationValue } from './SheetRelation';
import {
  BatchBar,
  BatchFieldDialog,
  BumpText,
  ColIcon,
  FloatingMenu,
  MenuItem,
  SaveBadge,
  type SaveState,
  type SheetBlockData,
  type SheetCol,
  type SheetRow,
  StatusPicker,
  SummaryStrip,
  UndoRedoButtons,
} from './SheetParts';
import { WindowBar, WindowFooter } from './SheetWindowBar';
import { useSheetWindow } from '../sheet-window-context';
import { useVariant } from './design';
import { Card, StatusChip, TONE_SOFT, statusTone as themeTone } from './theme';

/**
 * LA HOJA: una tabla que se trabaja como una hoja de cálculo.
 *
 * Teclado: flechas mueven la celda activa (Mayús+flecha extiende el rango);
 * Enter o F2 (o escribir) la edita; Enter guarda y baja, Tab guarda y avanza,
 * Esc descarta; Ctrl/Cmd+V pega varias filas y columnas desde Excel o Sheets
 * (escribe directo; sólo abre la vista previa si hay problemas); Espacio
 * cambia un sí/no; Ctrl/Cmd+Z y Ctrl/Cmd+Mayús+Z (o Ctrl+Y) deshacen y rehacen
 * lo editado en esta sesión; Ctrl/Cmd+D duplica la fila. El servidor decide qué
 * celdas se pueden escribir (el spec, el rol y los campos con origen): aquí sólo
 * se pide. Totales y subtotales se calculan sobre las filas que el filtro deja
 * ver, con las mismas funciones que usa la exportación.
 *
 * CREAR DESDE LA CELDA. Cada grupo (y la hoja) termina con una fila fantasma:
 * escribir en ella arma la fila —hereda el grupo— y se crea sola cuando están
 * los campos obligatorios, sin diálogo. En una relación, «+ Crear «texto»». El
 * controlador de relleno (esquina de la celda activa) copia o continúa una
 * serie hacia abajo en una sola escritura.
 *
 * Teléfono: la hoja se desplaza de lado con las columnas fijas y tocar una
 * celda editable abre una hoja de edición; el número de fila abre la ficha.
 */

type Sheet = SheetBlockData;
type Row = SheetRow;
type Col = SheetCol;

const WIDTH_REM: Record<string, number> = { number: 7.5, date: 6.5, text: 10 };
const REM = 16;
/** Con más líneas que esto la hoja se virtualiza (sólo se pintan las visibles). */
const VIRTUAL_MIN = 120;
const NO_VALUES: string[] = [];

function widthOf(c: Col, i: number, narrow: boolean): number {
  if (i === 0) return narrow ? 9 : 13;
  if (c.type === 'checkbox') return 5.5;
  if (c.type === 'select') return 9.5;
  if (c.type === 'longtext') return 14;
  return WIDTH_REM[c.kind] ?? 10;
}

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter']);

/** ¿Pantalla táctil o angosta? Ahí se edita en una hoja desde abajo, no en la celda. */
function useCompact(): boolean {
  const [v, setV] = useState(false);
  useEffect(() => {
    const q = window.matchMedia('(pointer: coarse), (max-width: 639px)');
    setV(q.matches);
    const on = () => setV(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return v;
}

function editableCol(c: Col): boolean {
  return Boolean(c.edit) && c.edit?.type !== 'file';
}

/** Una relación se elige de una lista (con búsqueda); nunca se escribe a mano en la celda. */
const isRelationCol = (c: Col | undefined): boolean => c?.edit?.type === 'relation';

function rawText(v: string | number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

const GROUP_BG: Record<string, string> = {
  emerald: 'bg-emerald-soft/70',
  rose: 'bg-rose-soft/70',
  amber: 'bg-amber-soft/70',
  sky: 'bg-sky-soft/70',
  primary: 'bg-primary-soft/60',
};

type ToneName = 'emerald' | 'rose' | 'amber' | 'sky';
const toneOfStatus = (v: string): ToneName | null => {
  const t = finalTone(v) ?? themeTone(v);
  return t === 'emerald' || t === 'rose' || t === 'amber' || t === 'sky' ? t : null;
};

type Pos = { r: number; c: number };

export function SheetBlock({ block, target }: { block: Sheet; target?: SubmitTarget }) {
  const writer = useViewWriter();
  const flash = useFlashClass();
  const open = useRecordOpener(block.id, block.record);
  const compact = useCompact();
  const variant = useVariant();
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [filters, setFilters] = useState<Record<number, Set<string>>>({});
  const [filterOpen, setFilterOpen] = useState<number | null>(null);
  // Los grupos plegados se recuerdan por su clave (no por su lugar): cargar más hacia el
  // pasado o un refresco en vivo reacomoda los grupos sin soltar los que ya se plegaron.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set((block.groups ?? []).flatMap((g) => (g.collapsed ? [g.key] : []))),
  );
  const knownGroups = useRef<Set<string>>(new Set((block.groups ?? []).map((g) => g.key)));
  // Un grupo que llega por primera vez nace plegado si el spec lo pide.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo cuando cambian los grupos
  useEffect(() => {
    const fresh = (block.groups ?? []).filter((g) => !knownGroups.current.has(g.key));
    if (!fresh.length) return;
    for (const g of fresh) knownGroups.current.add(g.key);
    const closed = fresh.filter((g) => g.collapsed).map((g) => g.key);
    if (closed.length) setCollapsed((c) => new Set([...c, ...closed]));
  }, [block.groups]);
  const [active, setActive] = useState<Pos | null>(null);
  const [rangeEnd, setRangeEnd] = useState<Pos | null>(null);
  const [editing, setEditing] = useState<{ draft: string } | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [newRow, setNewRow] = useState<{ group?: string } | null>(null);
  const [pasteState, setPasteState] = useState<PasteDraft | null>(null);
  const cancelled = useRef(false);
  // Selección de varias filas, filas recién creadas (hasta que el servidor las devuelva),
  // borradores de la fila fantasma y el estado del guardado.
  const [selRows, setSelRows] = useState<Set<string>>(new Set());
  const lastPicked = useRef<number | null>(null);
  const [local, setLocal] = useState<Row[]>([]);
  const [ghostDraft, setGhostDraft] = useState<Record<string, Record<string, string>>>({});
  const [creating, setCreating] = useState<Set<string>>(new Set());
  const [save, setSave] = useState<SaveState>({ state: 'idle', at: 0 });
  const inflight = useRef(0);
  const retryRef = useRef<(() => void) | null>(null);
  const history = useRef(new EditHistory());
  const [, setHistTick] = useState(0);
  const dragging = useRef(false);
  const [fillTo, setFillTo] = useState<number | null>(null);
  const fillToRef = useRef<number | null>(null);
  const [batchDialog, setBatchDialog] = useState<{ key?: string; title: string } | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [rowMenu, setRowMenu] = useState<{ id: string; el: HTMLElement } | null>(null);
  const focusGhost = useRef<{ id: string; c: number } | null>(null);
  // Pantalla completa: el mismo bloque (mismo estado: filtros, orden, celda activa,
  // grupos plegados) pasa a ocupar la ventana. Con la API Fullscreen del navegador
  // sobre el documento (así los diálogos y listas que flotan siguen viéndose); sin
  // ella —iPhone— queda sólo el velo fijo.
  const [full, setFull] = useState(false);
  const nativeFull = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fsButtonRef = useRef<HTMLButtonElement>(null);
  const [holdHeight, setHoldHeight] = useState<number | null>(null);
  const enterFull = useCallback(() => {
    setHoldHeight(wrapRef.current?.offsetHeight ?? null);
    setFull(true);
    const el = document.documentElement;
    if (el.requestFullscreen && !document.fullscreenElement) {
      el.requestFullscreen().then(
        () => {
          nativeFull.current = true;
        },
        () => {
          nativeFull.current = false;
        },
      );
    }
  }, []);
  const exitFull = useCallback(() => {
    setFull(false);
    if (nativeFull.current && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    nativeFull.current = false;
    queueMicrotask(() => fsButtonRef.current?.focus());
  }, []);
  // Salir con Esc del navegador (que no llega a la página) también cierra el velo.
  useEffect(() => {
    if (!full) return;
    const onChange = () => {
      if (!document.fullscreenElement && nativeFull.current) {
        nativeFull.current = false;
        setFull(false);
        queueMicrotask(() => fsButtonRef.current?.focus());
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    queueMicrotask(() => rootRef.current?.focus());
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.body.style.overflow = prev;
    };
  }, [full]);
  // Si el bloque se desmonta en pantalla completa, se suelta la del navegador.
  useEffect(
    () => () => {
      if (nativeFull.current && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    },
    [],
  );
  const [viewW, setViewW] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setViewW(el.clientWidth);
      setViewH(el.clientHeight);
    });
    ro.observe(el);
    setViewW(el.clientWidth);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  // El arrastre de un rango termina al soltar el botón en cualquier parte.
  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  // El servidor ya trajo lo nuevo: lo optimista sobra.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo cuando cambia el bloque
  useEffect(() => {
    setPending({});
    setLocal([]);
  }, [block]);

  const say = (ok: boolean, text: string) => {
    setNote({ ok, text });
    setTimeout(() => setNote((n) => (n?.text === text ? null : n)), 5000);
  };

  const pasteFields: PasteField[] = block.write?.fields ?? [];
  const canAdd = Boolean(block.write?.add && writer?.paste);
  const groupField = block.write?.groupField ?? null;
  const colIndex = useMemo(() => new Map(block.columns.map((c, i) => [c.key, i])), [block.columns]);
  const fieldsByCol = useMemo(
    () => block.columns.map((c) => pasteFields.find((f) => f.key === c.key) ?? null),
    [block.columns, pasteFields],
  );
  const firstEditable = block.columns.findIndex((c) => editableCol(c));

  /** El valor con que una fila nueva entra a un grupo (nunca el de «Sin …»). */
  const groupKeyOf = useCallback(
    (gi: number): string | null => {
      if (!groupField || gi < 0) return null;
      const key = block.groups?.[gi]?.key ?? '';
      if (!key) return null;
      const f = pasteFields.find((x) => x.key === groupField);
      if (!f) return null;
      return f.type === 'relation' && !/^[0-9a-f-]{36}$/i.test(key) ? null : key;
    },
    [block.groups, groupField, pasteFields],
  );

  // --- La ventana: búsqueda y filtros por columna miran TODO el histórico, en el servidor ---
  const winCtl = useSheetWindow();
  const win = block.window;
  const winLoading = Boolean(winCtl?.loading.has(block.id));
  const rowsRef = useRef(block.rows);
  rowsRef.current = block.rows;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `winCtl` cambia de identidad en cada refresco; sólo importa lo escrito
  useEffect(() => {
    if (!win || !winCtl) return;
    const text = query.trim();
    const cols: Record<string, string[]> = {};
    for (const [ci, set] of Object.entries(filters)) {
      const col = block.columns[Number(ci)];
      if (!set.size || !col) continue;
      cols[col.key] = [...set].map((shown) => {
        if (shown === '—') return '';
        const row = rowsRef.current.find((r) => r.cells[Number(ci)] === shown);
        const raw = row?.sort[Number(ci)];
        if (raw === null || raw === undefined) return shown;
        // Una relación viaja por su id; lo demás por su valor guardado.
        const id = col.type === 'relation' ? /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(String(raw)) : null;
        return id ? id[0].toLowerCase() : String(raw);
      });
    }
    const t = setTimeout(
      () => winCtl.update(block.id, { q: text || undefined, cols: Object.keys(cols).length ? cols : undefined }),
      text ? 350 : 0,
    );
    return () => clearTimeout(t);
  }, [query, filters, Boolean(win), block.id]);

  // La celda activa sigue a SU fila cuando llegan filas nuevas (arriba, abajo o en medio).
  const activeRowId = useRef<string | null>(null);

  // --- Filas visibles: búsqueda, filtros por columna, orden dentro de cada grupo ---
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = block.rows.filter((r) => {
      if (q && !r.cells.some((c) => c.toLowerCase().includes(q))) return false;
      for (const [ci, set] of Object.entries(filters))
        if (set.size && !set.has(r.cells[Number(ci)] ?? '')) return false;
      return true;
    });
    if (sort) {
      const numeric = block.columns[sort.col]?.kind === 'number';
      const key = (r: Row) => r.sort[sort.col];
      list = [...list].sort((a, b) => {
        if (a.group !== b.group) return a.group - b.group;
        const va = key(a);
        const vb = key(b);
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        return (
          (numeric
            ? Number(va) - Number(vb)
            : String(va).localeCompare(String(vb), 'es', { numeric: true })) * sort.dir
        );
      });
    }
    return list;
  }, [block, query, filters, sort]);

  const ghostRow = useCallback(
    (gi: number): Row => ({
      id: `ghost:${gi}`,
      cells: block.columns.map(() => ''),
      sort: block.columns.map(() => null),
      group: gi,
      tones: block.columns.map(() => null),
      ghost: true,
    }),
    [block.columns],
  );

  const lines = useMemo(() => {
    const out: Array<{ kind: 'group'; gi: number; count: number } | { kind: 'row'; row: Row }> = [];
    const rows: Row[] = [...visible, ...local];
    if (!block.groups) {
      for (const row of rows) out.push({ kind: 'row', row });
      if (canAdd) out.push({ kind: 'row', row: ghostRow(-1) });
      return out;
    }
    const order: number[] = [];
    const byGroup = new Map<number, Row[]>();
    for (const row of rows) {
      if (!byGroup.has(row.group)) {
        byGroup.set(row.group, []);
        order.push(row.group);
      }
      byGroup.get(row.group)?.push(row);
    }
    for (const gi of order) {
      const rs = byGroup.get(gi) ?? [];
      out.push({ kind: 'group', gi, count: rs.length });
      if (collapsed.has(block.groups?.[gi]?.key ?? '')) continue;
      for (const row of rs) out.push({ kind: 'row', row });
      if (canAdd) out.push({ kind: 'row', row: ghostRow(gi) });
    }
    return out;
  }, [block.groups, visible, local, collapsed, canAdd, ghostRow]);

  const navRows = useMemo(
    () => lines.flatMap((l) => (l.kind === 'row' ? [l.row] : [])),
    [lines],
  );
  const realRows = useMemo(() => navRows.filter((r) => !r.ghost && !r.fresh), [navRows]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recordar la fila de la celda activa sólo cuando el usuario la mueve
  useEffect(() => {
    activeRowId.current = active ? (navRows[active.r]?.id ?? null) : null;
  }, [active]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-anclar sólo cuando cambian las filas
  useEffect(() => {
    const id = activeRowId.current;
    if (!id || !active) return;
    const r = navRows.findIndex((x) => x.id === id);
    if (r >= 0 && r !== active.r) {
      setActive({ r, c: active.c });
      setRangeEnd(null);
    }
  }, [navRows]);
  // El número que se ve: las filas fantasma no cuentan.
  const numberOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of navRows) if (!r.ghost) m.set(r.id, m.size + 1);
    return m;
  }, [navRows]);

  // Los valores distintos de una columna sólo se calculan con su filtro abierto (no en cada pintado).
  const openValues = useMemo(
    () => (filterOpen === null ? NO_VALUES : block.rows.map((r) => r.cells[filterOpen] ?? '')),
    [filterOpen, block.rows],
  );
  const navIndex = useMemo(() => new Map(navRows.map((r, i) => [r.id, i])), [navRows]);

  // --- Virtualización: con muchas líneas sólo se pintan las visibles + un margen ---
  // Altura fija por densidad (se mide la real la primera vez); los encabezados de grupo, las
  // filas fantasma y las filas comunes cuentan como líneas. Las columnas congeladas y el
  // encabezado pegado siguen siendo `sticky` dentro del mismo contenedor.
  const baseRowH = block.density === 'compact' && variant !== 'airy' ? 32 : 40;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [measured, setMeasured] = useState({ row: 0, group: 0, head: 40, foot: 38 });
  const virtual = lines.length > VIRTUAL_MIN;
  const rowPx = measured.row || baseRowH;
  const groupPx = measured.group || 84;
  const offsets = useMemo(() => {
    const o = new Float64Array(lines.length + 1);
    for (let i = 0; i < lines.length; i++) o[i + 1] = (o[i] ?? 0) + (lines[i]?.kind === 'group' ? groupPx : rowPx);
    return o;
  }, [lines, rowPx, groupPx]);
  const lineOfRow = useMemo(() => {
    const m = new Map<string, number>();
    lines.forEach((l, i) => {
      if (l.kind === 'row') m.set(l.row.id, i);
    });
    return m;
  }, [lines]);
  // El grupo que se está recorriendo: su tarjeta queda pegada bajo el encabezado hasta que la
  // del siguiente grupo llega y la empuja hacia arriba (como los títulos de una lista larga).
  const groupLines = useMemo(() => {
    const out: number[] = [];
    lines.forEach((l, i) => {
      if (l.kind === 'group') out.push(i);
    });
    return out;
  }, [lines]);
  const pinned = useMemo(() => {
    if (!groupLines.length) return null;
    let k = -1;
    for (let j = 0; j < groupLines.length; j++) {
      if ((offsets[groupLines[j] ?? 0] ?? 0) < scrollTop - 1) k = j;
      else break;
    }
    if (k < 0) return null;
    const li = groupLines[k] ?? 0;
    const line = lines[li];
    if (line?.kind !== 'group') return null;
    const next = groupLines[k + 1];
    const gap = next === undefined ? Number.POSITIVE_INFINITY : (offsets[next] ?? 0) - scrollTop;
    return { gi: line.gi, count: line.count, shift: Math.min(0, gap - groupPx) };
  }, [groupLines, lines, offsets, scrollTop, groupPx]);
  const span = useMemo(() => {
    if (!virtual) return { from: 0, to: lines.length };
    const margin = rowPx * 12;
    const top = Math.max(0, scrollTop - measured.head - margin);
    const bottom = scrollTop + viewH + margin;
    const find = (y: number) => {
      let lo = 0;
      let hi = lines.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((offsets[mid + 1] ?? 0) <= y) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    return { from: find(top), to: Math.min(lines.length, find(bottom) + 1) };
  }, [virtual, lines.length, offsets, scrollTop, viewH, rowPx, measured.head]);

  // Tras crear una fila desde la fantasma, el cursor vuelve a ella para seguir escribiendo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo cuando cambian las filas
  useEffect(() => {
    const f = focusGhost.current;
    if (!f) return;
    const r = navRows.findIndex((x) => x.id === f.id);
    if (r >= 0) {
      focusGhost.current = null;
      setActive({ r, c: f.c });
      setRangeEnd(null);
    }
  }, [navRows]);

  // --- Anchos y columnas congeladas ---
  const widths = block.columns.map((c, i) => widthOf(c, i, compact) * REM);
  const gutter = (compact ? 4 : 5.75) * REM;
  // En el teléfono sólo la primera columna queda fija: dos se comen toda la pantalla.
  const frozen = compact ? Math.min(block.frozen, 1) : block.frozen;
  const leftOf = (i: number) => gutter + widths.slice(0, i).reduce((a, b) => a + b, 0);
  const tableWidth = gutter + widths.reduce((a, b) => a + b, 0);

  // --- Estados: la columna de avance de los grupos ---
  const statusCol = useMemo(
    () =>
      block.columns.findIndex(
        (c, i) =>
          c.type === 'select' &&
          looksLikeStatusColumn([...new Set(block.rows.map((r) => r.cells[i] ?? '').filter(Boolean))]),
      ),
    [block.columns, block.rows],
  );

  // --- Guardado: una sola puerta para que el indicador diga la verdad ---
  async function track<T extends { ok: boolean; error?: string }>(thunk: () => Promise<T>): Promise<T> {
    inflight.current += 1;
    setSave((s) => ({ ...s, state: 'saving' }));
    let res: T;
    try {
      res = await thunk();
    } catch {
      res = { ok: false, error: 'Sin conexión. Inténtalo otra vez.' } as T;
    }
    inflight.current -= 1;
    if (!res.ok) {
      retryRef.current = () => void track(thunk);
      setSave({ state: 'error', at: Date.now(), error: res.error });
    } else if (inflight.current === 0) {
      retryRef.current = null;
      setSave({ state: 'saved', at: Date.now() });
    }
    return res;
  }

  const currentRaw = (r: Row, ci: number) => rawText(pending[`${r.id}:${ci}`] ?? r.sort[ci]);

  /**
   * Escribe un lote de cambios de celdas (uno o muchos) con lo que se vio
   * antes (`expect`: un cambio ajeno no se pisa), muestra el valor al instante
   * y, si salió bien, lo anota para deshacer.
   */
  async function writeChanges(changes: EditChange[], label: string, record = true): Promise<boolean> {
    if (!writer || !changes.length) return false;
    const keyOf = (c: EditChange) => {
      const ci = colIndex.get(c.key);
      return ci === undefined ? null : `${c.rowId}:${ci}`;
    };
    setPending((p) => {
      const next = { ...p };
      for (const c of changes) {
        const k = keyOf(c);
        if (k) next[k] = c.after;
      }
      return next;
    });
    const items = groupByRow(changes);
    const thunk = async (): Promise<{ ok: boolean; error?: string; failed: string[]; message?: string }> => {
      const only = changes[0];
      if (changes.length === 1 && only) {
        const res = await writer.edit(
          block.id,
          only.rowId,
          { [only.key]: only.after },
          { expect: { [only.key]: only.before }, label },
        );
        return res.ok
          ? { ok: true, failed: [], message: res.message }
          : { ok: false, error: res.error, failed: [only.rowId] };
      }
      if (writer.editMany) {
        const res = await writer.editMany(block.id, items);
        if (!res.ok) return { ok: false, error: res.error, failed: items.map((i) => i.rowId) };
        return {
          ok: res.failed.length === 0,
          error: res.failed[0]?.error,
          failed: res.failed.map((f) => f.rowId),
        };
      }
      const failed: string[] = [];
      let error: string | undefined;
      for (const it of items) {
        const res = await writer.edit(block.id, it.rowId, it.patch, { expect: it.expect, label });
        if (!res.ok) {
          failed.push(it.rowId);
          error ??= res.error;
        }
      }
      return { ok: failed.length === 0, error, failed };
    };
    const out = await track(thunk);
    const failedIds = new Set(out.failed);
    if (failedIds.size) {
      setPending((p) => {
        const next = { ...p };
        for (const c of changes) {
          const k = keyOf(c);
          if (k && failedIds.has(c.rowId)) delete next[k];
        }
        return next;
      });
    }
    const done = changes.filter((c) => !failedIds.has(c.rowId));
    if (record && done.length) {
      history.current.push({ label, changes: done });
      setHistTick((n) => n + 1);
    }
    if (!out.ok) say(false, out.error ?? 'No se pudo guardar.');
    else if (changes.length === 1 && out.message) say(true, out.message);
    return out.ok;
  }

  async function undoRedo(kind: 'undo' | 'redo') {
    const h = history.current;
    const took = kind === 'undo' ? h.takeUndo() : h.takeRedo();
    if (!took) return;
    setHistTick((n) => n + 1);
    const ok = await writeChanges(took.write, `${kind === 'undo' ? 'Deshacer' : 'Rehacer'}: ${took.entry.label}`, false);
    if (ok) {
      if (kind === 'undo') h.confirmUndo(took.entry);
      else h.confirmRedo(took.entry);
      say(true, `${kind === 'undo' ? 'Deshecho' : 'Rehecho'}: ${took.entry.label}`);
    } else if (kind === 'undo') h.restoreUndo(took.entry);
    else h.restoreRedo(took.entry);
    setHistTick((n) => n + 1);
  }

  // --- Crear filas (fila fantasma, duplicar, pegar de más) ---
  function localRowFrom(values: Record<string, string>, gi: number): Row {
    const display = (c: Col): string => {
      const v = values[c.key];
      if (v === undefined || v === '') return '';
      if (c.type === 'relation') return relationLabel(v) || v;
      if (c.type === 'checkbox') return v === '1' ? 'Sí' : 'No';
      return v;
    };
    return {
      id: `new:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`,
      cells: block.columns.map(display),
      sort: block.columns.map((c) => values[c.key] ?? null),
      group: gi,
      tones: block.columns.map(() => null),
      fresh: true,
    };
  }

  async function createRows(
    list: Array<{ values: Record<string, string>; gi: number }>,
  ): Promise<{ ok: boolean; error?: string; result?: import('@cortex/agent-tools').SheetPasteResult }> {
    if (!writer?.paste || !list.length) return { ok: false, error: 'Aquí no se agregan filas.' };
    const paste = writer.paste;
    const out = await track(async () => {
      const res = await paste(block.id, list.map((l) => l.values), true, true);
      if (!res.ok) return { ok: false, error: res.error };
      const bad = res.result.lines.find((l) => l.action === 'error');
      if (bad || res.result.errors > 0)
        return { ok: false, error: bad?.error ?? 'No se pudo guardar.', result: res.result };
      return { ok: true, result: res.result };
    });
    if (out.ok) setLocal((cur) => [...cur, ...list.map((l) => localRowFrom(l.values, l.gi))]);
    return out;
  }

  /** Escribir en la fila fantasma: guarda en el borrador; con lo obligatorio completo, crea la fila. */
  function ghostSet(r: Row, ci: number, value: string, move?: 'down' | 'right' | 'left') {
    const col = block.columns[ci];
    if (!col) return;
    const nextDraft = { ...(ghostDraft[r.id] ?? {}) };
    if (value === '') delete nextDraft[col.key];
    else nextDraft[col.key] = value;
    setGhostDraft((d) => ({ ...d, [r.id]: nextDraft }));
    const inherited = groupKeyOf(r.group) ? groupField : null;
    const missing = block.columns.filter(
      (c) => c.edit?.required && c.key !== inherited && !(c.key in nextDraft),
    );
    if (value !== '' && missing.length === 0) void createFromDraft(r, nextDraft);
    else {
      advance(move === 'down' ? 'right' : move);
      if (value !== '' && missing.length)
        say(true, `Falta ${missing.map((m) => `«${m.label}»`).join(', ')} para crear la fila.`);
    }
  }

  async function createFromDraft(r: Row, draft: Record<string, string>) {
    if (creating.has(r.id) || !Object.keys(draft).length) return;
    const values = ghostValues({ draft, groupField, groupKey: groupKeyOf(r.group) });
    setCreating((s) => new Set(s).add(r.id));
    const out = await createRows([{ values, gi: r.group }]);
    setCreating((s) => {
      const n = new Set(s);
      n.delete(r.id);
      return n;
    });
    if (!out.ok) return say(false, out.error ?? 'No se pudo crear la fila.');
    setGhostDraft((d) => {
      const { [r.id]: _gone, ...rest } = d;
      return rest;
    });
    focusGhost.current = { id: r.id, c: Math.max(0, firstEditable) };
    say(true, 'Fila agregada.');
  }

  /** Duplicar filas (la clave de pegado queda marcada «(copia)»). */
  async function duplicateRows(ids: string[]) {
    if (!block.write?.add || !writer?.paste) return say(false, 'Aquí no se agregan filas.');
    const rows = ids.flatMap((id) => {
      const r = realRows.find((x) => x.id === id);
      return r ? [r] : [];
    });
    if (!rows.length) return;
    const list = rows.map((r) => {
      const raw: Record<string, string | number | null> = {};
      block.columns.forEach((c, i) => {
        raw[c.key] = r.sort[i] ?? null;
      });
      const values = duplicateValues(pasteFields, raw, block.write?.pasteKey ?? null);
      const gk = groupKeyOf(r.group);
      if (groupField && gk && !values[groupField]) values[groupField] = gk;
      return { values, gi: r.group };
    });
    const out = await createRows(list);
    if (!out.ok) return say(false, out.error ?? 'No se pudo duplicar.');
    const keyLabel = pasteFields.find((f) => f.key === block.write?.pasteKey)?.label;
    say(
      true,
      `${rows.length === 1 ? 'Fila duplicada' : `${rows.length} filas duplicadas`}${keyLabel ? `: cambia «${keyLabel}» en la copia` : ''}.`,
    );
  }

  // --- Escribir una celda ---
  async function commit(r: Row, ci: number, next: string, move?: 'down' | 'right' | 'left') {
    const col = block.columns[ci];
    if (!col?.edit || !writer) return;
    setEditing(null);
    if (r.fresh) return say(false, 'Esa fila se está guardando; en un instante se puede editar.');
    let value = next.trim();
    if (col.type === 'number' || col.type === 'money') {
      const n = normalizePasteCell(
        { key: col.key, label: col.label, type: col.type, options: [] },
        value,
      );
      if (!n.ok) return say(false, n.error);
      value = n.value;
    } else if (col.type === 'date' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const n = normalizePasteCell({ key: col.key, label: col.label, type: 'date', options: [] }, value);
      if (!n.ok) return say(false, n.error);
      value = n.value;
    }
    const isRel = col.edit.type === 'relation';
    if (r.ghost) {
      if (!isRel) {
        const problem = value === '' ? null : checkCell(col.edit, col.label, value);
        if (problem) return say(false, problem);
      }
      return ghostSet(r, ci, value, move);
    }
    const before = rawText(r.sort[ci]);
    if (isRel ? parseRelation(value)?.id === parseRelation(before)?.id : value === before)
      return advance(move);
    // Una relación la valida el servidor (la fila tiene que existir y el rol poder verla).
    const problem = isRel ? (value === '' && col.edit.required ? `«${col.label}» es obligatorio.` : null) : checkCell(col.edit, col.label, value);
    if (problem) return say(false, problem);
    advance(move);
    await writeChanges(
      [{ rowId: r.id, key: col.key, before, after: value }],
      `${col.label} → ${isRel ? relationLabel(value) || 'vacío' : value || 'vacío'}`,
    );
  }

  function advance(move?: 'down' | 'right' | 'left') {
    if (!move) return;
    setRangeEnd(null);
    setActive((a) => {
      if (!a) return a;
      if (move === 'down') return { r: Math.min(navRows.length - 1, a.r + 1), c: a.c };
      const dir = move === 'right' ? 1 : -1;
      return { r: a.r, c: Math.max(0, Math.min(block.columns.length - 1, a.c + dir)) };
    });
  }

  function startEdit(initial?: string, at?: Pos) {
    const pos = at ?? active;
    if (!pos) return;
    const col = block.columns[pos.c];
    const row = navRows[pos.r];
    if (!col || !row || !editableCol(col)) return;
    if (col.type === 'checkbox') {
      void commit(row, pos.c, rawText(row.sort[pos.c]) === '1' || ghostDraft[row.id]?.[col.key] === '1' ? '0' : '1');
      return;
    }
    cancelled.current = false;
    // La relación y el estado arrancan con la lista abierta (o con lo que se escribió).
    if (isRelationCol(col) || col.edit?.type === 'select') return setEditing({ draft: initial ?? '' });
    setEditing({ draft: initial ?? (row.ghost ? '' : rawText(pending[`${row.id}:${pos.c}`] ?? row.sort[pos.c])) });
  }

  // --- Rango seleccionado ---
  const rect = useMemo(() => {
    if (!active) return null;
    const e = rangeEnd ?? active;
    return {
      r0: Math.min(active.r, e.r),
      r1: Math.max(active.r, e.r),
      c0: Math.min(active.c, e.c),
      c1: Math.max(active.c, e.c),
    };
  }, [active, rangeEnd]);
  const inRange = (ri: number, ci: number) =>
    Boolean(rect && (rect.r0 !== rect.r1 || rect.c0 !== rect.c1) && ri >= rect.r0 && ri <= rect.r1 && ci >= rect.c0 && ci <= rect.c1);

  const rangeInfo = useMemo(() => {
    if (!rect || (rect.r0 === rect.r1 && rect.c0 === rect.c1)) return null;
    const vals: Array<string | number | null> = [];
    let numericCol: Col | null = null;
    for (let r = rect.r0; r <= rect.r1; r++) {
      const row = navRows[r];
      if (!row || row.ghost) continue;
      for (let c = rect.c0; c <= rect.c1; c++) {
        const col = block.columns[c];
        if (!col) continue;
        const raw = pending[`${row.id}:${c}`] ?? row.sort[c];
        vals.push(col.kind === 'number' ? (raw as string | number | null) : raw === null || raw === undefined || raw === '' ? null : 'x');
        if (col.kind === 'number') numericCol ??= col;
      }
    }
    // El texto cuenta como «con valor» pero no suma: rangeStats sólo suma lo numérico.
    const stats = rangeStats(vals);
    return { stats, col: numericCol, cells: (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1) };
  }, [rect, navRows, block.columns, pending]);

  // --- Rellenar hacia abajo ---
  async function applyFill(box: { r0: number; r1: number; c0: number; c1: number }, to: number) {
    const targets: number[] = [];
    for (let i = box.r1 + 1; i <= to; i++) {
      const row = navRows[i];
      if (row && !row.ghost && !row.fresh) targets.push(i);
    }
    if (!targets.length) return;
    const changes: EditChange[] = [];
    for (let c = box.c0; c <= box.c1; c++) {
      const col = block.columns[c];
      if (!col?.edit || col.edit.type === 'file' || col.readonly) continue;
      const src: string[] = [];
      for (let r = box.r0; r <= box.r1; r++) {
        const row = navRows[r];
        if (row && !row.ghost) src.push(currentRaw(row, c));
      }
      if (!src.length) continue;
      const series = !['relation', 'select', 'checkbox'].includes(col.type);
      const plan = planFill(
        col.key,
        src,
        targets.map((i) => ({ id: (navRows[i] as Row).id, before: currentRaw(navRows[i] as Row, c) })),
        series,
      );
      if (col.edit.type !== 'relation') {
        for (const p of plan) {
          const problem = p.after === '' ? null : checkCell(col.edit, col.label, p.after);
          if (problem) return say(false, `Relleno cancelado: ${problem}`);
        }
      }
      changes.push(...plan);
    }
    if (!changes.length) return say(true, 'Nada que cambiar: ya tenían ese valor.');
    setActive({ r: box.r0, c: box.c0 });
    setRangeEnd({ r: to, c: box.c1 });
    await writeChanges(changes, `Relleno de ${changes.length} ${changes.length === 1 ? 'celda' : 'celdas'}`);
  }

  function startFill(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!rect) return;
    const box = rect;
    fillToRef.current = box.r1;
    setFillTo(box.r1);
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-cell]');
      if (!el) return;
      const r = Number((el.getAttribute('data-cell') ?? '').split(':')[0]);
      if (!Number.isFinite(r)) return;
      const to = Math.max(box.r1, r);
      fillToRef.current = to;
      setFillTo(to);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const to = fillToRef.current ?? box.r1;
      fillToRef.current = null;
      setFillTo(null);
      if (to > box.r1) void applyFill(box, to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // --- Selección de varias filas ---
  const selectedIds = [...selRows].filter((id) => realRows.some((r) => r.id === id));
  function pickRow(row: Row, e: { shiftKey: boolean }) {
    const idx = realRows.findIndex((x) => x.id === row.id);
    setSelRows((cur) => {
      const next = new Set(cur);
      if (e.shiftKey && lastPicked.current !== null) {
        const [a, b] = [Math.min(lastPicked.current, idx), Math.max(lastPicked.current, idx)];
        for (let i = a; i <= b; i++) next.add((realRows[i] as Row).id);
      } else if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
    lastPicked.current = idx;
  }
  const allPicked = realRows.length > 0 && realRows.every((r) => selRows.has(r.id));

  async function runBatchAction(a: Sheet['actions'][number]) {
    if (!writer) return;
    const ids = selectedIds.filter((id) => !a.rowIds || a.rowIds.includes(id));
    if (!ids.length) return say(false, `«${a.label}» no aplica a las filas elegidas.`);
    if (
      a.confirm &&
      !(await confirmDialog({
        title: `¿${a.label} en ${ids.length} ${ids.length === 1 ? 'fila' : 'filas'}?`,
        confirmLabel: a.label,
      }))
    )
      return;
    setBatchBusy(true);
    const out = await track(async () => {
      let okN = 0;
      let error: string | undefined;
      for (const id of ids) {
        const row = realRows.find((r) => r.id === id);
        const res = await writer.act(block.id, { ...a, confirm: false }, id, row?.cells[0] ?? '');
        if (res.ok) okN += 1;
        else error ??= res.error;
      }
      return { ok: okN === ids.length, error, okN };
    });
    setBatchBusy(false);
    if (out.ok) {
      say(true, `${a.label}: ${out.okN} ${out.okN === 1 ? 'fila' : 'filas'}.`);
      setSelRows(new Set());
    } else say(false, `${a.label}: ${out.okN} de ${ids.length}. ${out.error ?? ''}`);
  }

  async function applyBatchField(key: string, value: string): Promise<string | null> {
    const ci = colIndex.get(key);
    const changes: EditChange[] = selectedIds.flatMap((id) => {
      const row = realRows.find((r) => r.id === id);
      if (!row) return [];
      const before = ci === undefined ? '' : currentRaw(row, ci);
      return before === value ? [] : [{ rowId: id, key, before, after: value }];
    });
    if (!changes.length) return 'Todas ya tenían ese valor.';
    const label = pasteFields.find((f) => f.key === key)?.label ?? key;
    // Un campo que no está entre las columnas (p. ej. el grupo) no tiene «antes» a la vista: sin `expect`.
    const ok = await writeChanges(changes, `${label} en ${changes.length} filas`);
    return ok ? null : 'No se pudo guardar en todas; revisa el aviso.';
  }

  // --- Teclado de la rejilla ---
  function onKeyDown(e: React.KeyboardEvent) {
    if (editing) return;
    const meta = e.metaKey || e.ctrlKey;
    // Ctrl/Cmd+Mayús+F: pantalla completa (no choca con escribir para editar).
    if (meta && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (full) exitFull();
      else enterFull();
      return;
    }
    if (meta && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      void undoRedo(e.shiftKey ? 'redo' : 'undo');
      return;
    }
    if (meta && !e.altKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      void undoRedo('redo');
      return;
    }
    if (!active) {
      if (NAV_KEYS.has(e.key) && navRows.length) {
        setActive({ r: 0, c: 0 });
        e.preventDefault();
      }
      return;
    }
    const maxR = navRows.length - 1;
    const maxC = block.columns.length - 1;
    if (meta && e.key.toLowerCase() === 'c') {
      if (rect) {
        const m: string[][] = [];
        for (let r = rect.r0; r <= rect.r1; r++) {
          const row = navRows[r];
          if (!row || row.ghost) continue;
          m.push(row.cells.slice(rect.c0, rect.c1 + 1));
        }
        if (m.length) void navigator.clipboard?.writeText(toClipboard(m));
      }
      return;
    }
    if (meta && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      const ids = selectedIds.length ? selectedIds : navRows[active.r] && !navRows[active.r]?.ghost ? [(navRows[active.r] as Row).id] : [];
      if (ids.length) void duplicateRows(ids);
      return;
    }
    if (meta) return;
    const to = rangeEnd ?? active;
    const step = (dr: number, dc: number) => {
      if (e.shiftKey) setRangeEnd({ r: Math.max(0, Math.min(maxR, to.r + dr)), c: Math.max(0, Math.min(maxC, to.c + dc)) });
      else {
        setRangeEnd(null);
        setActive({ r: Math.max(0, Math.min(maxR, active.r + dr)), c: Math.max(0, Math.min(maxC, active.c + dc)) });
      }
    };
    switch (e.key) {
      case 'ArrowDown':
        step(1, 0);
        break;
      case 'ArrowUp':
        step(-1, 0);
        break;
      case 'ArrowRight':
        step(0, 1);
        break;
      case 'ArrowLeft':
        step(0, -1);
        break;
      case 'Tab':
        setRangeEnd(null);
        setActive({ r: active.r, c: Math.max(0, Math.min(maxC, active.c + (e.shiftKey ? -1 : 1))) });
        break;
      case 'Home':
        setRangeEnd(null);
        setActive({ r: active.r, c: 0 });
        break;
      case 'End':
        setRangeEnd(null);
        setActive({ r: active.r, c: maxC });
        break;
      case 'Escape':
        if (rangeEnd || selRows.size) {
          setRangeEnd(null);
          setSelRows(new Set());
        } else return;
        break;
      case 'Enter':
      case 'F2':
        startEdit();
        break;
      case ' ': {
        const col = block.columns[active.c];
        const row = navRows[active.r];
        if (e.shiftKey && row && !row.ghost && !row.fresh) pickRow(row, { shiftKey: false });
        else if (col?.type === 'checkbox') startEdit();
        else return;
        break;
      }
      case 'Delete':
      case 'Backspace': {
        if (!rect) break;
        const changes: EditChange[] = [];
        for (let r = rect.r0; r <= rect.r1; r++) {
          const row = navRows[r];
          if (!row || row.ghost || row.fresh) continue;
          for (let c = rect.c0; c <= rect.c1; c++) {
            const col = block.columns[c];
            if (!col || !editableCol(col) || col.edit?.required || col.type === 'checkbox') continue;
            const before = currentRaw(row, c);
            if (before !== '') changes.push({ rowId: row.id, key: col.key, before, after: '' });
          }
        }
        if (changes.length) void writeChanges(changes, changes.length === 1 ? 'Vaciar celda' : `Vaciar ${changes.length} celdas`);
        break;
      }
      default:
        if (e.key.length === 1) {
          startEdit(e.key);
          break;
        }
        return;
    }
    e.preventDefault();
  }

  // Mantener la celda activa a la vista (en una hoja virtualizada la fila puede no estar pintada:
  // se desplaza por cálculo y luego se ajusta de lado con la celda ya pintada).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo cuando se mueve la celda activa
  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;
    const sel = `[data-cell="${active.r}:${active.c}"]`;
    if (virtual) {
      const id = navRows[active.r]?.id;
      const line = id === undefined ? undefined : lineOfRow.get(id);
      if (line !== undefined) {
        const top = (offsets[line] ?? 0) + measured.head;
        const bottom = top + rowPx;
        if (top < root.scrollTop + measured.head) root.scrollTop = top - measured.head;
        else if (bottom > root.scrollTop + root.clientHeight - measured.foot)
          root.scrollTop = bottom - root.clientHeight + measured.foot;
      }
      requestAnimationFrame(() =>
        root.querySelector(sel)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
      );
      return;
    }
    root.querySelector(sel)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  // La tarjeta del grupo (manifiesto): se pinta en su línea y, pegada arriba, la del grupo
  // que se está recorriendo, hasta que el siguiente la empuja.
  function groupCard(gi: number, count: number, floating = false) {
    const g = block.groups?.[gi];
    if (!g) return null;
    const isClosed = collapsed.has(g.key);
    const members = visible.filter((r) => r.group === gi);
    const all = block.rows.filter((r) => r.group === gi);
    const progress =
      statusCol >= 0
        ? groupProgress(all.map((r) => rawText(pending[`${r.id}:${statusCol}`]) || (r.cells[statusCol] ?? '')))
        : null;
    const estado = g.fields.find((f) => /^(estado|status)$/i.test(f.label));
    const tone: ToneName | null =
      (estado ? toneOfStatus(estado.value) : null) ??
      (progress
        ? progress.rejected > 0
          ? 'rose'
          : progress.total > 0 && progress.done === progress.total
            ? 'emerald'
            : null
        : null);
    const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <div
        className={clsx(
          'flex flex-wrap items-center gap-x-5 gap-y-2 rounded-sm border border-border/70 border-l-4 px-3 py-2 shadow-card',
        floating && 'shadow-pop',
          GROUP_BG[tone ?? 'primary'],
        )}
        style={tone ? undefined : { borderLeftColor: 'rgb(var(--primary) / 0.5)' }}
      >
        <button
          type="button"
          aria-expanded={!isClosed}
          onClick={() =>
            setCollapsed((c) => {
              const n = new Set(c);
              if (n.has(g.key)) n.delete(g.key);
              else n.add(g.key);
              return n;
            })
          }
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink"
        >
          {isClosed ? (
            <ChevronRight className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronDown className="h-4 w-4" aria-hidden />
          )}
          {g.label}
          <span className="tabular rounded-pill bg-surface/70 px-1.5 font-mono text-micro font-normal text-ink-muted">
            {count}
          </span>
        </button>
        {g.fields.map((f) => (
          <span key={f.label} className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
            <span className="text-micro text-ink-faint">{f.label}</span>
            {f === estado && f.value ? (
              <StatusChip value={f.value} tone={toneOfStatus(f.value)} />
            ) : (
              <span className="tabular font-mono font-semibold text-ink">{f.value}</span>
            )}
          </span>
        ))}
        {progress && progress.total > 0 && (
          <span className="inline-flex items-center gap-2 text-micro text-ink-muted">
            <span
              role="progressbar"
              aria-label={`Avance de ${g.label}`}
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
              className="relative h-1.5 w-20 overflow-hidden rounded-pill bg-surface/80"
            >
              <span
                className={clsx('absolute inset-y-0 left-0 rounded-pill', progress.rejected ? 'bg-rose' : 'bg-emerald')}
                style={{ width: `${pct}%`, transition: 'width .3s ease' }}
              />
            </span>
            <span className="tabular font-mono">
              {progress.done}/{progress.total}
            </span>
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-0.5">
          {g.subtotals.map((ci) => {
            const c = block.columns[ci];
            if (!c) return null;
            const op = block.totals.find((t) => t.col === ci)?.op ?? 'sum';
            return (
              <span key={c.key} className="inline-flex items-baseline gap-1.5 text-xs text-ink-muted">
                <span className="text-micro text-ink-faint">{c.label}</span>
                <BumpText
                  className="tabular font-mono text-sm font-semibold text-ink"
                  text={sheetTotalDisplay(
                    members.map((r) => r.sort[ci]),
                    op,
                    c.fmt,
                  )}
                />
              </span>
            );
          })}
        </span>
      </div>
    );
  }

  const scrollRaf = useRef(0);
  function onGridScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    cancelAnimationFrame(scrollRaf.current);
    scrollRaf.current = requestAnimationFrame(() => setScrollTop(el.scrollTop));
  }
  // Mide la altura real de una fila, de un encabezado de grupo, del encabezado y del pie.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se re-mide al cambiar lo pintado
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !virtual) return;
    const h = (q: string) => root.querySelector<HTMLElement>(q)?.getBoundingClientRect().height ?? 0;
    const next = {
      row: h('tbody tr[data-vk="row"]') || measured.row,
      group: h('tbody tr[data-vk="group"]') || measured.group,
      head: h('thead') || measured.head,
      foot: h('tfoot') || measured.foot,
    };
    if (
      Math.abs(next.row - measured.row) > 0.5 ||
      Math.abs(next.group - measured.group) > 0.5 ||
      Math.abs(next.head - measured.head) > 0.5 ||
      Math.abs(next.foot - measured.foot) > 0.5
    )
      setMeasured(next);
  }, [virtual, span.from, span.to, compact, block.density, viewW]);

  // --- Pegar ---
  async function startPaste(text: string) {
    if (!block.write || !writer) return;
    const matrix = parseClipboard(text);
    if (!matrix.length) return;
    const cur = active ? navRows[active.r] : undefined;
    if (matrix.length === 1 && matrix[0]?.length === 1 && active && cur) {
      // Una sola celda sobre una celda: es editar.
      if (block.columns[active.c]?.edit) return void commit(cur, active.c, matrix[0]?.[0] ?? '');
      return;
    }
    if (!block.write.paste || !writer.paste) return say(false, 'Aquí no se pegan varias filas.');
    const detected = mapPasteColumns(matrix, pasteFields, 0);
    const width = Math.max(0, ...matrix.map((r) => r.length));
    // Sin encabezados, se pega desde la celda activa hacia la derecha, en el orden en que se ven las columnas.
    const targets = detected.header
      ? detected.targets
      : Array.from({ length: width }, (_, i) => fieldsByCol[(active?.c ?? 0) + i] ?? null);
    const body = detected.header ? detected.body : matrix;
    const rows = buildPasteRows(body, targets);
    if (rows.length === 0 || targets.every((t) => !t))
      return say(false, 'No encontré columnas que se puedan pegar aquí.');
    if (body.length > PASTE_MAX_ROWS) say(false, `Se pegan las primeras ${PASTE_MAX_ROWS} filas.`);
    const hasErrors = rows.some((r) => r.errors.length);
    if (hasErrors) {
      setPasteState({ rows, header: detected.header, targets, busy: false, server: null, error: null });
      return;
    }
    const pasteKey = block.write.pasteKey;
    const keyIncluded = Boolean(pasteKey && targets.some((t) => t?.key === pasteKey));
    const lastRow = navRows[navRows.length - 1];
    const gk = (row: Row | undefined) => (row ? groupKeyOf(row.group) : null);

    // A) Sin clave en lo pegado y sobre filas que existen: se escribe celda por celda, como en una hoja.
    if (!detected.header && !keyIncluded && active && cur && !cur.ghost && !cur.fresh) {
      const changes: EditChange[] = [];
      const extra: Array<{ values: Record<string, string>; gi: number }> = [];
      rows.forEach((pr, i) => {
        const row = navRows[active.r + i];
        if (row && !row.ghost && !row.fresh) {
          for (const [key, val] of Object.entries(pr.values)) {
            const ci = colIndex.get(key);
            if (ci === undefined) continue;
            const before = currentRaw(row, ci);
            if (before !== val) changes.push({ rowId: row.id, key, before, after: val });
          }
        } else {
          const base = row ?? lastRow;
          const values = { ...pr.values };
          const g = gk(base);
          if (groupField && g && !(groupField in values)) values[groupField] = g;
          extra.push({ values, gi: base?.group ?? -1 });
        }
      });
      let ok = true;
      if (changes.length) ok = await writeChanges(changes, `Pegado en ${changes.length} ${changes.length === 1 ? 'celda' : 'celdas'}`);
      if (extra.length) {
        const out = await createRows(extra);
        if (!out.ok) return say(false, out.error ?? 'No se pudieron agregar las filas que sobraban.');
      }
      if (ok && !changes.length && !extra.length) say(true, 'Nada que cambiar: ya tenían esos valores.');
      else if (ok) say(true, `Pegado: ${changes.length} celdas${extra.length ? ` y ${extra.length} filas nuevas` : ''}.`);
      return;
    }

    // B) Con clave (o con encabezados, o sobre la fila fantasma): se crea o actualiza por clave, directo.
    const values = rows.map((r) => ({ ...r.values }));
    if (cur?.ghost && groupField && gk(cur) && !targets.some((t) => t?.key === groupField))
      for (const v of values) v[groupField] = gk(cur) as string;
    const paste = writer.paste;
    const res = await track(async () => {
      const r = await paste(block.id, values, true);
      return r.ok ? { ok: true as const, result: r.result } : { ok: false as const, error: r.error };
    });
    if (!res.ok || !('result' in res)) return say(false, res.error ?? 'No se pudo pegar.');
    const r = res.result;
    if (r.errors > 0)
      setPasteState({ rows, header: detected.header, targets, busy: false, server: r, error: null });
    else say(true, `Pegado: ${r.created} nuevas, ${r.updated} actualizadas, ${r.same} sin cambios.`);
  }

  async function applyPaste() {
    if (!pasteState || !writer?.paste) return;
    setPasteState({ ...pasteState, busy: true });
    const res = await writer.paste(block.id, pasteState.rows.map((r) => r.values), true);
    if (res.ok) {
      const r = res.result;
      if (r.errors) setPasteState({ ...pasteState, busy: false, server: r, error: null });
      else {
        setPasteState(null);
        say(true, `Pegado: ${r.created} nuevas, ${r.updated} actualizadas, ${r.same} sin cambios.`);
      }
    } else setPasteState({ ...pasteState, busy: false, error: res.error });
  }

  const colTotals = block.totals.map((t) => {
    const col = block.columns[t.col];
    return {
      col: t.col,
      text: col ? sheetTotalDisplay(visible.map((r) => r.sort[t.col]), t.op, col.fmt) : '',
    };
  });
  const totalOf = (col: number) => colTotals.find((t) => t.col === col)?.text;

  const downloadAllCsv = async () => {
    const all = (await winCtl?.fetchAll(block.id)) as Sheet | null | undefined;
    if (!all || all.type !== 'sheet') return say(false, 'No se pudo leer todo el histórico. Inténtalo otra vez.');
    downloadCsv(all);
  };

  const downloadCsv = (source?: Sheet) => {
    const target = source && 'rows' in source ? source : block;
    const m = sheetMatrix(target, target === block ? new Set(visible.map((r) => r.id)) : undefined);
    const url = URL.createObjectURL(new Blob([sheetCsv(m)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${block.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const filtered = Object.values(filters).some((s) => s.size) || query.trim() !== '';
  const dense = block.density === 'compact' && variant !== 'airy';
  const rowH = dense ? 'h-8' : 'h-10';
  const cellBase = clsx('px-2 text-xs', rowH);
  const h = history.current;
  const batchActions = block.actions.filter((a) => a.kind !== 'assign' && !a.askReason);
  const batchFields = pasteFields.filter((f) => f.type !== 'file');
  const canMove = Boolean(groupField && pasteFields.some((f) => f.key === groupField));
  const fillBox = !compact && rect && writer && !editing ? rect : null;

  // Esc fuera de una edición sale de la pantalla completa; Tab no se escapa del velo.
  const onWrapKeyDown = (e: React.KeyboardEvent) => {
    if (!full) return;
    const wrap = wrapRef.current;
    if (!wrap || !(e.target instanceof Node) || !wrap.contains(e.target)) return;
    const busy = Boolean(editing) || newRow || pasteState || filterOpen !== null || rowMenu || batchDialog;
    if (e.key === 'Escape' && !busy && !e.defaultPrevented && !rangeEnd && !selRows.size) {
      e.preventDefault();
      exitFull();
      return;
    }
    if (e.key === 'Tab' && !editing) {
      const items = Array.from(
        wrap.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
        ),
      ).filter((el) => el.offsetParent !== null);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && e.target === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && e.target === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const cellAnchor = (): HTMLElement | null =>
    active ? (rootRef.current?.querySelector(`[data-cell="${active.r}:${active.c}"]`) as HTMLElement | null) : null;

  return (
    <div className="h-full" style={full && holdHeight ? { height: holdHeight } : undefined}>
    <div
      ref={wrapRef}
      role={full ? 'dialog' : undefined}
      aria-modal={full ? true : undefined}
      aria-label={full ? `${block.title}, pantalla completa` : undefined}
      onKeyDown={onWrapKeyDown}
      className={full ? 'fixed inset-0 z-[60] bg-canvas' : 'h-full'}
    >
    <Card
      className={full ? 'sheet-full flex h-full flex-col !rounded-none !border-0 !p-3 sm:!p-4' : undefined}
      title={block.title}
      source={`${block.total} ${block.total === 1 ? 'fila' : 'filas'} · ${block.source}${block.truncated ? ' · hay más de las que se muestran' : ''}`}
    >
      {win && winCtl && (
        <WindowBar win={win} loading={winLoading} onReach={(id) => winCtl.choose(block.id, id)} />
      )}
      <div className="view-no-print mb-3 flex flex-wrap items-center gap-2">
        <label className="flex h-9 min-w-[10rem] flex-1 items-center gap-2 rounded-pill border border-border bg-surface-2/70 px-3 focus-within:border-border-strong focus-within:bg-surface sm:max-w-xs">
          <Search className="h-4 w-4 text-ink-faint" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={win ? 'Buscar en todo el histórico' : 'Buscar en la hoja'}
            aria-label={`Buscar en ${block.title}`}
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
        </label>
        {filtered && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setFilters({});
            }}
            className="inline-flex h-9 items-center gap-1 rounded-pill border border-border px-3 text-xs font-semibold text-ink-muted hover:text-ink"
          >
            <X className="h-3.5 w-3.5" aria-hidden /> Quitar filtros
          </button>
        )}
        <span className="tabular font-mono text-micro text-ink-faint">
          {filtered ? `${visible.length} de ${block.rows.length}` : ''}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {writer && (
            <UndoRedoButtons
              canUndo={h.canUndo}
              canRedo={h.canRedo}
              undoLabel={h.nextUndo?.label}
              redoLabel={h.nextRedo?.label}
              onUndo={() => void undoRedo('undo')}
              onRedo={() => void undoRedo('redo')}
            />
          )}
          {block.groups && (
            <button
              type="button"
              onClick={() =>
                setCollapsed((c) =>
                  c.size ? new Set() : new Set((block.groups ?? []).map((g) => g.key)),
                )
              }
              className="inline-flex h-9 items-center gap-1 rounded-pill border border-border px-3 text-xs font-semibold text-ink-muted hover:text-ink"
            >
              {collapsed.size ? 'Desplegar todo' : 'Plegar todo'}
            </button>
          )}
          {block.write?.paste && writer?.paste && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await startPaste(await navigator.clipboard.readText());
                } catch {
                  setPasteState({ rows: [], header: false, targets: [], busy: false, server: null, error: null, manual: true });
                }
              }}
              className="inline-flex h-9 items-center gap-1.5 rounded-pill border border-border px-3 text-xs font-semibold text-ink hover:bg-surface-2"
            >
              <ClipboardPaste className="h-3.5 w-3.5" aria-hidden /> Pegar de Excel
            </button>
          )}
          {block.write?.add && writer?.paste && (
            <button
              type="button"
              onClick={() => setNewRow({})}
              className="inline-flex h-9 items-center gap-1.5 rounded-pill bg-primary px-3 text-xs font-semibold text-white hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden /> Nueva fila
            </button>
          )}
          <button
            ref={fsButtonRef}
            type="button"
            onClick={full ? exitFull : enterFull}
            aria-pressed={full}
            title={full ? 'Salir de pantalla completa (Esc)' : 'Pantalla completa (Ctrl/Cmd+Mayús+F)'}
            className={clsx(
              'inline-flex h-9 items-center gap-1.5 rounded-pill border px-3 text-xs font-semibold',
              full ? 'border-primary bg-primary text-white hover:opacity-90' : 'border-border text-ink-muted hover:text-ink',
            )}
          >
            {full ? <Minimize2 className="h-3.5 w-3.5" aria-hidden /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden />}
            {full ? 'Salir' : 'Pantalla completa'}
          </button>
          {win && winCtl && (win.more || win.search) ? (
            <ExportMenuUi.Root>
              <ExportMenuUi.Trigger className="inline-flex h-9 items-center gap-1.5 rounded-pill border border-border px-3 text-xs font-semibold text-ink-muted hover:text-ink">
                <Download className="h-3.5 w-3.5" aria-hidden /> CSV <ChevronDown className="h-3 w-3" aria-hidden />
              </ExportMenuUi.Trigger>
              <ExportMenuUi.Portal>
                <ExportMenuUi.Content
                  align="end"
                  sideOffset={6}
                  className="view-no-print z-[70] min-w-[13rem] rounded-card border border-border bg-surface p-1 text-xs shadow-pop"
                >
                  <ExportMenuUi.Item
                    onSelect={() => downloadCsv()}
                    className="cursor-pointer rounded-sm px-3 py-2 font-medium text-ink outline-none data-[highlighted]:bg-surface-2"
                  >
                    Lo que ves ({visible.length} filas)
                  </ExportMenuUi.Item>
                  <ExportMenuUi.Item
                    onSelect={() => void downloadAllCsv()}
                    className="cursor-pointer rounded-sm px-3 py-2 font-medium text-ink outline-none data-[highlighted]:bg-surface-2"
                  >
                    Todo el histórico
                  </ExportMenuUi.Item>
                </ExportMenuUi.Content>
              </ExportMenuUi.Portal>
            </ExportMenuUi.Root>
          ) : (
          <button
            type="button"
            onClick={() => downloadCsv()}
            className="inline-flex h-9 items-center gap-1.5 rounded-pill border border-border px-3 text-xs font-semibold text-ink-muted hover:text-ink"
            title="Descargar lo que se ve como CSV, con grupos y totales"
          >
            <Download className="h-3.5 w-3.5" aria-hidden /> CSV
          </button>
          )}
        </div>
      </div>

      <div
        ref={rootRef}
        role="grid"
        aria-label={block.title}
        aria-rowcount={navRows.length}
        aria-colcount={block.columns.length}
        aria-multiselectable
        // biome-ignore lint/a11y/noNoninteractiveTabindex: la rejilla es el control; las flechas mueven la celda activa.
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={virtual || block.groups?.length ? onGridScroll : undefined}
        style={{ ...(viewW ? ({ '--sheet-view': `${viewW}px` } as React.CSSProperties) : {}), overflowAnchor: 'none' }}
        onPaste={(e) => {
          if (editing) return;
          const text = e.clipboardData.getData('text/plain');
          if (text) {
            e.preventDefault();
            void startPaste(text);
          }
        }}
        className={clsx(
          'sheet-grid view-table-scroll scroll-slim overflow-auto border-y border-border outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
          full ? 'min-h-0 flex-1 -mx-3 sm:-mx-4' : '-mx-4 max-h-[70vh] sm:-mx-6',
        )}
      >
        {pinned && (
          <div
            className="pointer-events-none sticky left-0 z-[25] h-0 w-[var(--sheet-view,72rem)] max-w-full"
            style={{ top: measured.head }}
          >
            <div
              className="pointer-events-auto px-2 pt-1 transition-opacity"
              style={{ transform: `translateY(${pinned.shift}px)` }}
            >
              <div className="rounded-sm bg-surface">{groupCard(pinned.gi, pinned.count, true)}</div>
            </div>
          </div>
        )}
        <table
          className="border-separate border-spacing-0 text-xs"
          style={{ width: tableWidth, tableLayout: 'fixed' }}
        >
          <colgroup>
            <col style={{ width: gutter }} />
            {widths.map((w, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columnas fijas por bloque
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 top-0 z-30 border-b border-r border-border bg-surface-2 text-micro text-ink-faint"
                style={{ height: 34 }}
              >
                {writer && realRows.length > 0 ? (
                  <input
                    type="checkbox"
                    checked={allPicked}
                    onChange={() => setSelRows(allPicked ? new Set() : new Set(realRows.map((r) => r.id)))}
                    aria-label="Elegir todas las filas"
                    className="h-4 w-4 cursor-pointer accent-[rgb(var(--primary))]"
                  />
                ) : (
                  <span className="sr-only">Fila</span>
                )}
              </th>
              {block.columns.map((c, i) => (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={sort?.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
                  className={clsx(
                    'top-0 border-b border-border bg-surface-2 px-2 text-left text-micro font-semibold tracking-field text-ink-muted',
                    i < frozen ? 'sticky z-20' : 'sticky z-10',
                    i === frozen - 1 && 'border-r',
                    c.kind === 'number' && 'text-right',
                  )}
                  style={{ ...(i < frozen ? { left: leftOf(i) } : {}), height: 34 }}
                >
                  <div className={clsx('flex items-center gap-1.5', c.kind === 'number' && 'justify-end')}>
                    <ColIcon col={c} />
                    <button
                      type="button"
                      onClick={() =>
                        setSort((s) =>
                          s?.col === i ? (s.dir === 1 ? { col: i, dir: -1 } : null) : { col: i, dir: 1 },
                        )
                      }
                      className={clsx('inline-flex min-w-0 items-center gap-1 hover:text-ink', sort?.col === i && 'text-ink')}
                    >
                      <span className="truncate">{c.label}</span>
                      {sort?.col === i &&
                        (sort.dir === 1 ? (
                          <ArrowUp className="h-3 w-3 shrink-0" aria-hidden />
                        ) : (
                          <ArrowDown className="h-3 w-3 shrink-0" aria-hidden />
                        ))}
                    </button>
                    <ColumnFilter
                      label={c.label}
                      open={filterOpen === i}
                      onToggle={() => setFilterOpen((o) => (o === i ? null : i))}
                      values={filterOpen === i ? openValues : NO_VALUES}
                      selected={filters[i]}
                      onChange={(set) => setFilters((f) => ({ ...f, [i]: set }))}
                      align={i > block.columns.length / 2 ? 'right' : 'left'}
                    />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {virtual && span.from > 0 && (
              <tr aria-hidden style={{ height: offsets[span.from] }}>
                <td colSpan={1 + block.columns.length} className="p-0" />
              </tr>
            )}
            {(virtual ? lines.slice(span.from, span.to) : lines).map((line) => {
              if (line.kind === 'group') {
                if (!block.groups?.[line.gi]) return null;
                return (
                  <tr key={`g${line.gi}`} data-vk="group">
                    <td colSpan={1 + block.columns.length} className="border-b border-border p-0">
                      <div className="sticky left-0 w-[var(--sheet-view,72rem)] max-w-full px-2 py-2">
                        {groupCard(line.gi, line.count)}
                      </div>
                    </td>
                  </tr>
                );
              }
              const r = line.row;
              const ri = navIndex.get(r.id) ?? -1;
              const picked = selRows.has(r.id);
              const no = numberOf.get(r.id) ?? 0;
              const band = r.rowTone ? TONE_SOFT[r.rowTone] : ri % 2 === 1 ? 'sheet-band' : 'bg-surface';
              const draft = r.ghost ? (ghostDraft[r.id] ?? {}) : null;
              const draftCount = draft ? Object.keys(draft).length : 0;
              return (
                <tr
                  key={r.id}
                  data-vk="row"
                  aria-selected={picked || undefined}
                  className={clsx(
                    flash(block.id, r.id),
                    'group/row',
                    r.ghost && 'sheet-ghost',
                    r.fresh && 'opacity-80',
                    r.rowTone ? TONE_SOFT[r.rowTone] : r.alert ? 'bg-rose-soft' : ri % 2 === 1 ? 'sheet-band' : '',
                    !r.rowTone && !r.alert && 'hover:bg-surface-2/70',
                    picked && '!bg-primary-soft/60',
                  )}
                >
                  <td
                    className={clsx(
                      'sticky left-0 z-10 border-b border-r border-border bg-surface-2 text-center text-micro text-ink-faint',
                      rowH,
                    )}
                  >
                    {r.ghost ? (
                      <div className="flex h-full items-center justify-center gap-1 px-1">
                        {creating.has(r.id) ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : draftCount > 0 ? (
                          <>
                            <button
                              type="button"
                              title="Crear la fila ahora"
                              aria-label="Crear la fila ahora"
                              onClick={() => void createFromDraft(r, draft ?? {})}
                              className="rounded-sm p-1 text-primary hover:bg-primary-soft"
                            >
                              <Check className="h-3.5 w-3.5" aria-hidden />
                            </button>
                            <button
                              type="button"
                              title="Descartar lo escrito"
                              aria-label="Descartar lo escrito"
                              onClick={() =>
                                setGhostDraft((d) => {
                                  const { [r.id]: _gone, ...rest } = d;
                                  return rest;
                                })
                              }
                              className="rounded-sm p-1 hover:bg-surface"
                            >
                              <X className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          </>
                        ) : (
                          <Plus className="h-3.5 w-3.5 text-primary/70" aria-hidden />
                        )}
                      </div>
                    ) : (
                      <div className="flex h-full items-center justify-center gap-1 px-1">
                        {writer && !r.fresh && (
                          <input
                            type="checkbox"
                            checked={picked}
                            onChange={() => undefined}
                            onClick={(e) => pickRow(r, e)}
                            aria-label={`Elegir la fila ${no}`}
                            className={clsx(
                              'h-4 w-4 shrink-0 cursor-pointer accent-[rgb(var(--primary))] focus-visible:opacity-100',
                              compact || picked || selRows.size ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100',
                            )}
                          />
                        )}
                        {open && !full && !r.fresh ? (
                          <button
                            type="button"
                            onClick={() => open(r.id)}
                            aria-label={`Abrir la ficha de ${r.cells[0]}`}
                            className="inline-flex h-full min-w-[1.25rem] items-center justify-center hover:text-primary"
                          >
                            <span className="tabular font-mono group-hover/row:hidden max-sm:hidden">{no}</span>
                            <PanelRightOpen className="hidden h-3.5 w-3.5 group-hover/row:block max-sm:block" aria-hidden />
                          </button>
                        ) : (
                          <span className="tabular min-w-[1.25rem] font-mono">{no}</span>
                        )}
                        {!compact && writer && !r.fresh && (
                          <button
                            type="button"
                            aria-label={`Más acciones de la fila ${no}`}
                            aria-haspopup="menu"
                            onClick={(e) => setRowMenu((m) => (m?.id === r.id ? null : { id: r.id, el: e.currentTarget }))}
                            className="rounded-sm p-0.5 opacity-0 hover:bg-surface hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  {block.columns.map((c, ci) => {
                    const isActive = active?.r === ri && active.c === ci;
                    const key = `${r.id}:${ci}`;
                    const tone = r.tones[ci];
                    const shown = r.ghost ? draft?.[c.key] : pending[key];
                    const isEditing = isActive && editing && !compact;
                    const inSel = inRange(ri, ci) && !isActive;
                    const inFill = fillTo !== null && rect && ri > rect.r1 && ri <= fillTo && ci >= rect.c0 && ci <= rect.c1;
                    const showHandle = Boolean(
                      fillBox && !r.ghost && !r.fresh && ri === fillBox.r1 && ci === fillBox.c1 && editableCol(c) && !c.readonly,
                    );
                    const editable = editableCol(c) && !r.fresh;
                    const cellText = shown !== undefined ? displayPending(c, shown) : r.cells[ci];
                    const isSelect = c.type === 'select';
                    return (
                      <td
                        key={c.key}
                        role="gridcell"
                        data-cell={`${ri}:${ci}`}
                        aria-selected={isActive || inSel}
                        aria-readonly={!editable || undefined}
                        onMouseDown={(e) => {
                          if (e.button !== 0) return;
                          if (e.shiftKey && active) {
                            setRangeEnd({ r: ri, c: ci });
                            return;
                          }
                          dragging.current = !compact;
                          setActive({ r: ri, c: ci });
                          setRangeEnd(null);
                        }}
                        onMouseEnter={() => {
                          if (dragging.current && active) setRangeEnd({ r: ri, c: ci });
                        }}
                        onClick={() => {
                          if (compact && editable) startEdit(undefined, { r: ri, c: ci });
                        }}
                        onDoubleClick={() => {
                          if (!compact) startEdit(undefined, { r: ri, c: ci });
                        }}
                        className={clsx(
                          'relative border-b border-border/70',
                          cellBase,
                          ci < frozen && 'sticky z-10',
                          ci < frozen && band,
                          ci === frozen - 1 && 'border-r border-border',
                          c.kind === 'number' ? 'tabular text-right font-mono' : '',
                          ci === 0 ? 'font-semibold text-ink' : 'text-ink-muted',
                          c.kind === 'number' && 'text-ink',
                          tone && TONE_SOFT[tone],
                          inSel && '!bg-primary-soft',
                          inFill && 'sheet-fill-preview',
                          isActive && 'z-[15] outline outline-2 -outline-offset-2 outline-primary',
                          editable && !isActive && 'cursor-cell',
                        )}
                        style={ci < frozen ? { left: leftOf(ci) } : undefined}
                      >
                        {isEditing && isRelationCol(c) && target ? (
                          <RelationCombo
                            target={target}
                            blockId={block.id}
                            field={c.key}
                            label={c.label}
                            current={r.ghost ? (draft?.[c.key] ?? '') : rawText(pending[key] ?? r.sort[ci])}
                            required={c.edit?.required}
                            initialQuery={editing.draft}
                            onPick={(o) => {
                              if (cancelled.current) return;
                              void commit(r, ci, o ? relationValue(o) : '');
                              rootRef.current?.focus();
                            }}
                            onCancel={() => {
                              cancelled.current = true;
                              setEditing(null);
                              rootRef.current?.focus();
                            }}
                          />
                        ) : isEditing && c.edit?.type === 'select' ? (
                          <>
                            <span className="block truncate">
                              {cellText ? <StatusChip value={cellText} tone={toneOfStatus(cellText)} /> : null}
                            </span>
                            <StatusPicker
                              anchor={cellAnchor()}
                              options={c.edit.options}
                              current={r.ghost ? (draft?.[c.key] ?? '') : rawText(pending[key] ?? r.sort[ci])}
                              required={c.edit.required}
                              toneOf={toneOfStatus}
                              label={`Elegir ${c.label}`}
                              onPick={(v) => {
                                void commit(r, ci, v);
                                rootRef.current?.focus();
                              }}
                              onCancel={() => {
                                setEditing(null);
                                rootRef.current?.focus();
                              }}
                            />
                          </>
                        ) : isEditing ? (
                          <CellEditor
                            col={c}
                            draft={editing.draft}
                            onDraft={(d) => setEditing({ draft: d })}
                            onCommit={(v, move) => {
                              if (cancelled.current) return;
                              void commit(r, ci, v, move);
                            }}
                            onCancel={() => {
                              cancelled.current = true;
                              setEditing(null);
                              rootRef.current?.focus();
                            }}
                          />
                        ) : isSelect && cellText ? (
                          <button
                            type="button"
                            tabIndex={-1}
                            disabled={!editable}
                            onClick={(e) => {
                              if (compact || !editable) return;
                              e.stopPropagation();
                              setActive({ r: ri, c: ci });
                              startEdit(undefined, { r: ri, c: ci });
                            }}
                            aria-label={editable ? `${c.label}: ${cellText}. Cambiar` : undefined}
                            className={clsx('block max-w-full truncate text-left', editable && !compact && 'cursor-pointer')}
                          >
                            <StatusChip value={cellText} tone={toneOfStatus(cellText)} />
                          </button>
                        ) : r.ghost && !cellText ? (
                          <span className="block truncate text-ink-faint/70">
                            {ci === Math.max(0, firstEditable) && draftCount === 0
                              ? 'Escribe para agregar una fila…'
                              : ''}
                          </span>
                        ) : (
                          <span className={clsx('block truncate', (shown !== undefined || r.fresh) && 'italic')}>
                            {cellText}
                          </span>
                        )}
                        {showHandle && (
                          <span
                            data-fill-handle
                            role="presentation"
                            title="Arrastra hacia abajo para rellenar"
                            onPointerDown={startFill}
                            className="absolute -bottom-[4px] -right-[4px] z-20 h-2.5 w-2.5 cursor-crosshair rounded-[3px] border-2 border-surface bg-primary"
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {virtual && span.to < lines.length && (
              <tr aria-hidden style={{ height: (offsets[lines.length] ?? 0) - (offsets[span.to] ?? 0) }}>
                <td colSpan={1 + block.columns.length} className="p-0" />
              </tr>
            )}
            {lines.length === 0 && (
              <tr>
                <td colSpan={block.columns.length + 1} className="px-4 py-10 text-center text-sm text-ink-faint">
                  {filtered ? 'Ningún renglón cumple los filtros.' : 'La hoja está vacía.'}
                </td>
              </tr>
            )}
          </tbody>
          {block.totals.length > 0 && (
            <tfoot>
              <tr>
                <td className="sticky bottom-0 left-0 z-30 border-t border-r border-border bg-surface-2" />
                {block.columns.map((c, ci) => (
                  <td
                    key={c.key}
                    className={clsx(
                      'sticky bottom-0 border-t border-border bg-surface-2 px-2 text-xs font-semibold text-ink',
                      ci < frozen ? 'z-20' : 'z-10',
                      ci === frozen - 1 && 'border-r',
                      c.kind === 'number' ? 'tabular text-right font-mono' : '',
                    )}
                    style={{ ...(ci < frozen ? { left: leftOf(ci) } : {}), height: 38 }}
                  >
                    {ci === 0 && !totalOf(0) ? (
                      <span className="text-micro text-ink-faint">
                        {win && (win.more || win.search) ? 'Total del rango cargado' : 'Total'} · {visible.length}{' '}
                        {visible.length === 1 ? 'fila' : 'filas'}
                      </span>
                    ) : (
                      <BumpText text={totalOf(ci) ?? ''} />
                    )}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {win && winCtl && (
        <WindowFooter
          win={win}
          loading={winLoading}
          hasTotals={block.totals.length > 0}
          onMore={() => win.next && winCtl.more(block.id, win.next)}
        />
      )}

      {rangeInfo && (
        <div className="view-no-print mt-2">
          <SummaryStrip stats={rangeInfo.stats} col={rangeInfo.col} cells={rangeInfo.cells} />
        </div>
      )}

      {selectedIds.length > 0 && writer && (
        <BatchBar
          count={selectedIds.length}
          busy={batchBusy}
          actions={batchActions}
          canDuplicate={Boolean(block.write?.add && writer.paste)}
          canChange={batchFields.length > 0}
          canMove={canMove}
          onAction={(a) => void runBatchAction(a)}
          onDuplicate={() => void duplicateRows(selectedIds)}
          onChange={() => setBatchDialog({ title: 'Cambiar un campo en las filas elegidas' })}
          onMove={() => setBatchDialog({ key: groupField ?? undefined, title: 'Mover las filas elegidas de grupo' })}
          onClear={() => setSelRows(new Set())}
        />
      )}

      <div className={clsx('mt-2 flex min-h-5 flex-wrap items-center justify-between gap-x-4 gap-y-1', full && 'pl-12')}>
        <p role="status" className={clsx('text-micro', note ? (note.ok ? 'text-emerald' : 'text-rose') : 'text-ink-faint')}>
          {note
            ? note.text
            : fillTo !== null && rect && fillTo > rect.r1
              ? `Rellenar ${fillTo - rect.r1} ${fillTo - rect.r1 === 1 ? 'fila' : 'filas'} hacia abajo`
              : block.write
                ? compact
                  ? 'Toca una celda para editar'
                  : 'Flechas para moverte · Enter o escribir para editar · Arrastra la esquina para rellenar · Ctrl+Z deshace'
                : 'Sólo lectura'}
        </p>
        <SaveBadge save={save} onRetry={retryRef.current ? () => retryRef.current?.() : undefined} />
      </div>

      {block.actions.length > 0 && active && navRows[active.r] && !navRows[active.r]?.ghost && !navRows[active.r]?.fresh && (
        <div className="mt-2 border-t border-border/70 pt-2">
          <RowActions
            blockId={block.id}
            actions={block.actions}
            rowId={(navRows[active.r] as Row).id}
            rowLabel={(navRows[active.r] as Row).cells[0] ?? ''}
          />
        </div>
      )}

      {rowMenu && (
        <FloatingMenu anchor={rowMenu.el} onClose={() => setRowMenu(null)} label="Acciones de la fila" minWidth={208} align="left">
          {open && (
            <MenuItem
              icon={<PanelRightOpen className="h-3.5 w-3.5 text-ink-muted" aria-hidden />}
              onClick={() => {
                const id = rowMenu.id;
                setRowMenu(null);
                open(id);
              }}
            >
              Abrir la ficha
            </MenuItem>
          )}
          {block.write?.add && writer?.paste && (
            <MenuItem
              icon={<Copy className="h-3.5 w-3.5 text-ink-muted" aria-hidden />}
              hint="Ctrl+D"
              onClick={() => {
                const id = rowMenu.id;
                setRowMenu(null);
                void duplicateRows([id]);
              }}
            >
              Duplicar la fila
            </MenuItem>
          )}
          <MenuItem
            icon={<Check className="h-3.5 w-3.5 text-ink-muted" aria-hidden />}
            onClick={() => {
              const row = realRows.find((x) => x.id === rowMenu.id);
              setRowMenu(null);
              if (row) pickRow(row, { shiftKey: false });
            }}
          >
            {selRows.has(rowMenu.id) ? 'Quitar de la selección' : 'Elegir la fila'}
          </MenuItem>
        </FloatingMenu>
      )}

      {batchDialog && (
        <BatchFieldDialog
          fields={batchFields}
          initialKey={batchDialog.key}
          count={selectedIds.length}
          blockId={block.id}
          target={target}
          title={batchDialog.title}
          onClose={() => setBatchDialog(null)}
          onApply={applyBatchField}
        />
      )}

      {/* Teléfono: edición de una celda en una hoja desde abajo. */}
      {compact && editing && active && navRows[active.r] && block.columns[active.c] && (
        <CellSheet
          col={block.columns[active.c] as Col}
          draft={editing.draft}
          onDraft={(d) => setEditing({ draft: d })}
          onCancel={() => setEditing(null)}
          onSave={(v) => void commit(navRows[active.r] as Row, active.c, v ?? editing.draft)}
          relation={
            isRelationCol(block.columns[active.c]) && target
              ? {
                  target,
                  blockId: block.id,
                  current: rawText(
                    (navRows[active.r] as Row).ghost
                      ? ghostDraft[(navRows[active.r] as Row).id]?.[(block.columns[active.c] as Col).key]
                      : (pending[`${(navRows[active.r] as Row).id}:${active.c}`] ??
                          (navRows[active.r] as Row).sort[active.c]),
                  ),
                }
              : undefined
          }
        />
      )}

      {newRow && block.write && writer?.paste && (
        <NewRowDialog
          block={block}
          target={target}
          group={newRow.group}
          onClose={() => setNewRow(null)}
          onSave={async (values) => {
            const res = await writer.paste?.(block.id, [values], true);
            if (!res?.ok) return res?.error ?? 'No se pudo guardar.';
            const line = res.result.lines[0];
            if (line?.action === 'error') return line.error ?? 'No se pudo guardar.';
            setNewRow(null);
            say(true, line?.action === 'same' ? 'Esa fila ya estaba.' : 'Fila agregada.');
            return null;
          }}
        />
      )}

      {pasteState && (
        <PasteDialog
          state={pasteState}
          onClose={() => setPasteState(null)}
          onApply={() => void applyPaste()}
          onManual={(text) => {
            setPasteState(null);
            void startPaste(text);
          }}
        />
      )}
    </Card>
    </div>
    </div>
  );
}

function displayPending(c: Col, v: string): string {
  if (v === '') return '—';
  if (c.type === 'checkbox') return v === '1' ? 'Sí' : 'No';
  if (c.edit?.type === 'relation') return relationLabel(v) || v;
  return v;
}

// ---------------------------------------------------------------------------
// Filtro de columna
// ---------------------------------------------------------------------------

function ColumnFilter({
  label,
  open,
  onToggle,
  values,
  selected,
  onChange,
  align,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  values: string[];
  selected: Set<string> | undefined;
  onChange: (s: Set<string>) => void;
  align: 'left' | 'right';
}) {
  const [q, setQ] = useState('');
  const distinct = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es', { numeric: true }));
  }, [values]);
  const shown = distinct.filter(([v]) => v.toLowerCase().includes(q.toLowerCase())).slice(0, 80);
  const on = Boolean(selected?.size);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={onToggle}
        aria-label={`Filtrar ${label}`}
        aria-expanded={open}
        className={clsx('rounded-sm p-0.5 hover:text-ink', on ? 'text-primary' : 'text-ink-faint/70')}
      >
        <Filter className="h-3 w-3" aria-hidden />
      </button>
      {open && (
        <div
          className={clsx(
            'absolute top-full z-40 mt-1 w-56 rounded-sm border border-border bg-surface p-2 text-xs font-normal normal-case tracking-normal text-ink shadow-card',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar valor"
            className="mb-2 h-8 w-full rounded-sm border border-border bg-surface-2/60 px-2 text-xs outline-none focus:border-border-strong"
          />
          <ul className="scroll-slim max-h-48 space-y-0.5 overflow-auto">
            {shown.map(([v, n]) => (
              <li key={v}>
                <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={selected?.has(v) ?? false}
                    onChange={(e) => {
                      const next = new Set(selected ?? []);
                      if (e.target.checked) next.add(v);
                      else next.delete(v);
                      onChange(next);
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">{v}</span>
                  <span className="tabular font-mono text-micro text-ink-faint">{n}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex justify-between">
            <button type="button" onClick={() => onChange(new Set())} className="text-micro font-semibold text-ink-muted hover:text-ink">
              Quitar
            </button>
            <button type="button" onClick={onToggle} className="text-micro font-semibold text-primary">
              Listo
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Editor de celda
// ---------------------------------------------------------------------------

const INPUT =
  'h-full w-full rounded-none border-0 bg-surface px-2 text-xs text-ink outline-none ring-2 ring-inset ring-primary';

function CellEditor({
  col,
  draft,
  onDraft,
  onCommit,
  onCancel,
}: {
  col: Col;
  draft: string;
  onDraft: (d: string) => void;
  onCommit: (v: string, move?: 'down' | 'right' | 'left') => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
  useEffect(() => {
    ref.current?.focus();
    if (ref.current && 'select' in ref.current && col.type !== 'date') {
      const el = ref.current;
      const len = el.value.length;
      el.setSelectionRange?.(len, len);
    }
  }, [col.type]);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onCommit(draft, 'down');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onCommit(draft, e.shiftKey ? 'left' : 'right');
    }
  };
  if (col.edit?.type === 'select')
    return (
      <select
        ref={ref}
        value={draft}
        onChange={(e) => onCommit(e.target.value)}
        onBlur={() => onCancel()}
        onKeyDown={keys}
        className={INPUT}
      >
        {!col.edit.required && <option value="">—</option>}
        {col.edit.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  return (
    <input
      ref={ref}
      type={col.type === 'date' ? 'date' : 'text'}
      inputMode={col.type === 'number' || col.type === 'money' ? 'decimal' : undefined}
      value={draft}
      aria-label={`Editar ${col.label}`}
      onChange={(e) => onDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={keys}
      className={INPUT}
    />
  );
}

function CellSheet({
  col,
  draft,
  onDraft,
  onCancel,
  onSave,
  relation,
}: {
  col: Col;
  draft: string;
  onDraft: (d: string) => void;
  onCancel: () => void;
  onSave: (value?: string) => void;
  /** Relación: el mismo buscador en línea, no texto libre. */
  relation?: { target: SubmitTarget; blockId: string; current: string };
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[64] bg-ink/40" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-[65] max-h-[85vh] overflow-auto rounded-t-card border-t border-border bg-surface p-4 pb-6 shadow-card">
          <Dialog.Title className="mb-3 text-sm font-semibold text-ink">{col.label}</Dialog.Title>
          <Dialog.Description className="sr-only">Cambiar el valor de la celda</Dialog.Description>
          {relation ? (
            <RelationCombo
              inline
              target={relation.target}
              blockId={relation.blockId}
              field={col.key}
              label={col.label}
              current={relation.current}
              required={col.edit?.required}
              onPick={(o) => onSave(o ? relationValue(o) : '')}
              onCancel={() => undefined}
            />
          ) : col.edit?.type === 'select' || col.edit?.type === 'checkbox' ? (
            <select
              value={draft}
              onChange={(e) => onDraft(e.target.value)}
              className="h-12 w-full rounded-sm border border-border bg-surface px-3 text-base text-ink"
            >
              {!col.edit.required && <option value="">—</option>}
              {(col.edit.type === 'checkbox' ? ['1', '0'] : col.edit.options).map((o) => (
                <option key={o} value={o}>
                  {col.edit?.type === 'checkbox' ? (o === '1' ? 'Sí' : 'No') : o}
                </option>
              ))}
            </select>
          ) : (
            <input
              // biome-ignore lint/a11y/noAutofocus: se abre para escribir
              autoFocus
              type={col.type === 'date' ? 'date' : 'text'}
              inputMode={col.type === 'number' || col.type === 'money' ? 'decimal' : undefined}
              value={draft}
              onChange={(e) => onDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onSave()}
              className="h-12 w-full rounded-sm border border-border bg-surface px-3 text-base text-ink"
            />
          )}
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={onCancel} className="h-11 flex-1 rounded-pill border border-border text-sm font-semibold text-ink-muted">
              Cancelar
            </button>
            {!relation && (
              <button type="button" onClick={() => onSave()} className="h-11 flex-1 rounded-pill bg-primary text-sm font-semibold text-white">
                Guardar
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Fila nueva
// ---------------------------------------------------------------------------

function NewRowDialog({
  block,
  group,
  target,
  onClose,
  onSave,
}: {
  block: Sheet;
  target?: SubmitTarget;
  group?: string;
  onClose: () => void;
  onSave: (values: Record<string, string>) => Promise<string | null>;
}) {
  const fields = block.write?.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupField = block.write?.groupField;
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[64] bg-ink/40" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-[65] max-h-[85vh] overflow-auto rounded-t-card border-t border-border bg-surface p-4 pb-6 shadow-card sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[34rem] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card sm:border">
          <Dialog.Title className="mb-1 text-sm font-semibold text-ink">Nueva fila</Dialog.Title>
          <Dialog.Description className="mb-3 text-xs text-ink-muted">
            {group ? 'Se agrega a este grupo. ' : ''}Las relaciones se eligen de la lista.
          </Dialog.Description>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => {
              const norm = (v: string) => normalizePasteCell(f, v);
              if (f.type === 'relation' && target)
                return (
                  <div key={f.key} className="block text-micro font-semibold uppercase tracking-field text-ink-faint">
                    <span>{f.label}</span>
                    <RelationField
                      target={target}
                      blockId={block.id}
                      field={f.key}
                      label={f.label}
                      value={values[f.key] ?? ''}
                      onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))}
                    />
                  </div>
                );
              return (
                <label key={f.key} className="block text-micro font-semibold uppercase tracking-field text-ink-faint">
                  {f.label}
                  {f.type === 'select' || f.type === 'checkbox' ? (
                    <select
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      className="mt-1 h-10 w-full rounded-sm border border-border bg-surface px-2 text-sm font-normal normal-case tracking-normal text-ink"
                    >
                      <option value="">—</option>
                      {(f.type === 'checkbox' ? ['1', '0'] : f.options).map((o) => (
                        <option key={o} value={o}>
                          {f.type === 'checkbox' ? (o === '1' ? 'Sí' : 'No') : o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={f.type === 'date' ? 'date' : 'text'}
                      inputMode={f.type === 'number' || f.type === 'money' ? 'decimal' : undefined}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      onBlur={(e) => {
                        const out = norm(e.target.value);
                        if (out.ok && out.value !== e.target.value && f.type !== 'date')
                          setValues((v) => ({ ...v, [f.key]: out.value }));
                      }}
                      className="mt-1 h-10 w-full rounded-sm border border-border bg-surface px-2 text-sm font-normal normal-case tracking-normal text-ink"
                    />
                  )}
                </label>
              );
            })}
          </div>
          {error && <p className="mt-3 text-xs text-rose">{error}</p>}
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={onClose} className="h-11 flex-1 rounded-pill border border-border text-sm font-semibold text-ink-muted">
              Cancelar
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const out: Record<string, string> = {};
                for (const f of fields) {
                  const n = normalizePasteCell(f, values[f.key] ?? '');
                  if (!n.ok) {
                    setError(n.error);
                    setBusy(false);
                    return;
                  }
                  if (n.value !== '') out[f.key] = n.value;
                }
                if (group && groupField) out[groupField] = group;
                setError(await onSave(out));
                setBusy(false);
              }}
              className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-pill bg-primary text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Agregar
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Pegar: vista previa
// ---------------------------------------------------------------------------

interface PasteDraft {
  rows: ReturnType<typeof buildPasteRows>;
  header: boolean;
  targets: Array<PasteField | null>;
  busy: boolean;
  server: import('@cortex/agent-tools').SheetPasteResult | null;
  error: string | null;
  manual?: boolean;
}

function PasteDialog({
  state,
  onClose,
  onApply,
  onManual,
}: {
  state: PasteDraft;
  onClose: () => void;
  onApply: () => void;
  onManual: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const clientErrors = state.rows.flatMap((r) => r.errors.map((e) => `Fila ${r.line}: ${e}`));
  const s = state.server;
  const errorLines = s?.lines.filter((l) => l.action === 'error') ?? [];
  const canApply = !state.busy && !clientErrors.length && s !== null && s.errors === 0 && s.created + s.updated > 0;
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[64] bg-ink/40" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-[65] max-h-[85vh] overflow-auto rounded-t-card border-t border-border bg-surface p-4 pb-6 shadow-card sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[40rem] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card sm:border">
          <Dialog.Title className="mb-1 text-sm font-semibold text-ink">Pegar de Excel o Sheets</Dialog.Title>
          <Dialog.Description className="mb-3 text-xs text-ink-muted">
            Revisa qué pasaría con cada fila antes de guardar. Pegar dos veces lo mismo no duplica nada.
          </Dialog.Description>
          {state.manual ? (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                placeholder="Pega aquí las celdas copiadas (Ctrl+V)"
                className="w-full rounded-sm border border-border bg-surface-2/60 p-2 text-xs text-ink outline-none focus:border-border-strong"
              />
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={onClose} className="h-11 flex-1 rounded-pill border border-border text-sm font-semibold text-ink-muted">
                  Cancelar
                </button>
                <button type="button" disabled={!text.trim()} onClick={() => onManual(text)} className="h-11 flex-1 rounded-pill bg-primary text-sm font-semibold text-white disabled:opacity-50">
                  Revisar
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="mb-2 text-xs text-ink-muted">
                {state.rows.length} {state.rows.length === 1 ? 'fila' : 'filas'}
                {state.header ? ' · la primera fila eran los encabezados' : ''} · columnas:{' '}
                {state.targets.map((t) => t?.label ?? '(se omite)').join(', ')}
              </p>
              {state.busy && (
                <p className="flex items-center gap-2 text-xs text-ink-muted">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Revisando…
                </p>
              )}
              {s && (
                <div className="mb-2 flex flex-wrap gap-2 text-xs">
                  <span className="rounded-pill bg-emerald-soft px-2.5 py-0.5 font-semibold text-emerald">{s.created} nuevas</span>
                  <span className="rounded-pill bg-sky-soft px-2.5 py-0.5 font-semibold text-sky">{s.updated} se actualizan</span>
                  <span className="rounded-pill bg-surface-2 px-2.5 py-0.5 font-semibold text-ink-muted">{s.same} sin cambios</span>
                  {s.errors > 0 && <span className="rounded-pill bg-rose-soft px-2.5 py-0.5 font-semibold text-rose">{s.errors} con error</span>}
                </div>
              )}
              {(clientErrors.length > 0 || errorLines.length > 0) && (
                <ul className="mb-2 max-h-40 space-y-1 overflow-auto rounded-sm bg-rose-soft p-2 text-xs text-rose">
                  {clientErrors.slice(0, 20).map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                  {errorLines.slice(0, 20).map((l) => (
                    <li key={l.line}>Fila {l.line}: {l.error}</li>
                  ))}
                </ul>
              )}
              {state.error && <p className="mb-2 text-xs text-rose">{state.error}</p>}
              {s && (
                <ul className="mb-3 max-h-48 divide-y divide-border/60 overflow-auto rounded-sm border border-border text-xs">
                  {s.lines.slice(0, 60).map((l) => (
                    <li key={l.line} className="flex items-center gap-2 px-2 py-1.5">
                      <span className="tabular w-7 shrink-0 font-mono text-micro text-ink-faint">{l.line}</span>
                      <span className="min-w-0 flex-1 truncate text-ink">{l.label}</span>
                      <span className="shrink-0 text-micro font-semibold text-ink-muted">
                        {{ create: 'Nueva', update: `Cambia ${l.changed?.join(', ') ?? ''}`, same: 'Igual', error: 'Error' }[l.action]}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="h-11 flex-1 rounded-pill border border-border text-sm font-semibold text-ink-muted">
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={!canApply}
                  onClick={onApply}
                  className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-pill bg-primary text-sm font-semibold text-white disabled:opacity-50"
                >
                  {state.busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  {s ? `Guardar ${s.created + s.updated} filas` : 'Guardar'}
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
