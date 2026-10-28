'use client';

import type { ComputedBlock } from '@cortex/agent-tools';
import { sheetCsv, sheetMatrix } from '@cortex/agent-tools/src/views/sheet-export';
import { sheetTotalDisplay } from '@cortex/agent-tools/src/views/sheet-math';
import {
  PASTE_MAX_ROWS,
  type PasteField,
  buildPasteRows,
  mapPasteColumns,
  normalizePasteCell,
  parseClipboard,
} from '@cortex/agent-tools/src/views/sheet-paste';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Download,
  Filter,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRightOpen,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubmitTarget } from '../ViewCanvas';
import { RowActions, checkCell, useViewWriter } from '../view-writes';
import { useFlashClass } from '../flash-context';
import { useRecordOpener } from './RecordDrawer';
import { RelationCombo, RelationField, relationLabel, relationValue } from './SheetRelation';
import { parseRelation } from './RelationPicker';
import { useVariant } from './design';
import { TONE_SOFT, Card } from './theme';

/**
 * LA HOJA: una tabla que se trabaja como una hoja de cálculo.
 *
 * Teclado: flechas mueven la celda activa; Enter o F2 (o escribir) la edita;
 * Enter guarda y baja, Tab guarda y avanza, Esc descarta; Ctrl/Cmd+V pega
 * varias filas y columnas desde Excel o Sheets (con vista previa); Espacio
 * cambia un sí/no. El servidor decide qué celdas se pueden escribir (el spec,
 * el rol y los campos con origen): aquí sólo se pide. Totales y subtotales se
 * calculan sobre las filas que el filtro deja ver, con las mismas funciones que
 * usa la exportación. Teléfono: la hoja se desplaza de lado con las columnas
 * fijas y tocar una celda editable abre una hoja de edición; el número de fila
 * abre la ficha.
 */

type Sheet = Extract<ComputedBlock, { type: 'sheet' }>;
type Row = Sheet['rows'][number];
type Col = Sheet['columns'][number];

const WIDTH_REM: Record<string, number> = { number: 7.5, date: 6.5, text: 10 };
const GUTTER_REM = 2.75;
const REM = 16;

function widthOf(c: Col, i: number, narrow: boolean): number {
  if (i === 0) return narrow ? 9 : 13;
  if (c.type === 'checkbox') return 5.5;
  if (c.type === 'select') return 8.5;
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
  const [collapsed, setCollapsed] = useState<Set<number>>(
    () => new Set((block.groups ?? []).flatMap((g, i) => (g.collapsed ? [i] : []))),
  );
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<{ draft: string } | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [newRow, setNewRow] = useState<{ group?: string } | null>(null);
  const [pasteState, setPasteState] = useState<PasteDraft | null>(null);
  const cancelled = useRef(false);
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
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // El servidor ya trajo lo nuevo: lo optimista sobra.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo cuando cambia el bloque
  useEffect(() => setPending({}), [block]);

  const say = (ok: boolean, text: string) => {
    setNote({ ok, text });
    setTimeout(() => setNote((n) => (n?.text === text ? null : n)), 5000);
  };

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

  const lines = useMemo(() => {
    const out: Array<{ kind: 'group'; gi: number; count: number } | { kind: 'row'; row: Row }> = [];
    if (!block.groups) {
      for (const row of visible) out.push({ kind: 'row', row });
      return out;
    }
    const seen = new Set<number>();
    for (const row of visible) {
      if (!seen.has(row.group)) {
        seen.add(row.group);
        out.push({
          kind: 'group',
          gi: row.group,
          count: visible.filter((r) => r.group === row.group).length,
        });
      }
      if (!collapsed.has(row.group)) out.push({ kind: 'row', row });
    }
    return out;
  }, [block.groups, visible, collapsed]);

  const navRows = useMemo(
    () => lines.flatMap((l) => (l.kind === 'row' ? [l.row] : [])),
    [lines],
  );

  // --- Anchos y columnas congeladas ---
  const widths = block.columns.map((c, i) => widthOf(c, i, compact) * REM);
  const gutter = GUTTER_REM * REM;
  // En el teléfono sólo la primera columna queda fija: dos se comen toda la pantalla.
  const frozen = compact ? Math.min(block.frozen, 1) : block.frozen;
  const leftOf = (i: number) => gutter + widths.slice(0, i).reduce((a, b) => a + b, 0);
  const tableWidth = gutter + widths.reduce((a, b) => a + b, 0);

  // --- Escribir una celda ---
  async function commit(r: Row, ci: number, next: string, move?: 'down' | 'right' | 'left') {
    const col = block.columns[ci];
    if (!col?.edit || !writer) return;
    setEditing(null);
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
    const before = rawText(r.sort[ci]);
    const isRel = col.edit.type === 'relation';
    if (isRel ? parseRelation(value)?.id === parseRelation(before)?.id : value === before)
      return advance(move);
    // Una relación la valida el servidor (la fila tiene que existir y el rol poder verla).
    const problem = isRel ? (value === '' && col.edit.required ? `«${col.label}» es obligatorio.` : null) : checkCell(col.edit, col.label, value);
    if (problem) return say(false, problem);
    setPending((p) => ({ ...p, [`${r.id}:${ci}`]: value }));
    advance(move);
    const res = await writer.edit(
      block.id,
      r.id,
      { [col.key]: value },
      { expect: { [col.key]: before }, label: `${col.label} → ${isRel ? relationLabel(value) || 'vacío' : value}` },
    );
    if (!res.ok) {
      setPending((p) => {
        const { [`${r.id}:${ci}`]: _gone, ...rest } = p;
        return rest;
      });
      say(false, res.error);
    } else say(true, res.message);
  }

  function advance(move?: 'down' | 'right' | 'left') {
    if (!move) return;
    setActive((a) => {
      if (!a) return a;
      if (move === 'down') return { r: Math.min(navRows.length - 1, a.r + 1), c: a.c };
      const dir = move === 'right' ? 1 : -1;
      return { r: a.r, c: Math.max(0, Math.min(block.columns.length - 1, a.c + dir)) };
    });
  }

  function startEdit(initial?: string) {
    if (!active) return;
    const col = block.columns[active.c];
    const row = navRows[active.r];
    if (!col || !row || !editableCol(col)) return;
    if (col.type === 'checkbox') {
      void commit(row, active.c, rawText(row.sort[active.c]) === '1' ? '0' : '1');
      return;
    }
    cancelled.current = false;
    // La relación arranca con el buscador vacío (o con lo que se escribió).
    if (isRelationCol(col)) return setEditing({ draft: initial ?? '' });
    setEditing({ draft: initial ?? rawText(pending[`${row.id}:${active.c}`] ?? row.sort[active.c]) });
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
      const v = navRows[active.r]?.cells[active.c];
      if (v !== undefined) void navigator.clipboard?.writeText(v);
      return;
    }
    if (meta) return;
    switch (e.key) {
      case 'ArrowDown':
        setActive({ r: Math.min(maxR, active.r + 1), c: active.c });
        break;
      case 'ArrowUp':
        setActive({ r: Math.max(0, active.r - 1), c: active.c });
        break;
      case 'ArrowRight':
        setActive({ r: active.r, c: Math.min(maxC, active.c + 1) });
        break;
      case 'ArrowLeft':
        setActive({ r: active.r, c: Math.max(0, active.c - 1) });
        break;
      case 'Tab':
        setActive({ r: active.r, c: Math.max(0, Math.min(maxC, active.c + (e.shiftKey ? -1 : 1))) });
        break;
      case 'Home':
        setActive({ r: active.r, c: 0 });
        break;
      case 'End':
        setActive({ r: active.r, c: maxC });
        break;
      case 'Enter':
      case 'F2':
        startEdit();
        break;
      case ' ': {
        const col = block.columns[active.c];
        if (col?.type === 'checkbox') startEdit();
        else return;
        break;
      }
      case 'Delete':
      case 'Backspace': {
        const col = block.columns[active.c];
        const row = navRows[active.r];
        if (col && row && editableCol(col) && !col.edit?.required) void commit(row, active.c, '');
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

  // Mantener la celda activa a la vista.
  useEffect(() => {
    if (!active) return;
    rootRef.current
      ?.querySelector(`[data-cell="${active.r}:${active.c}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  // --- Pegar ---
  const pasteFields: PasteField[] = block.write?.fields ?? [];
  async function startPaste(text: string) {
    if (!block.write?.paste || !writer?.paste) return;
    const matrix = parseClipboard(text);
    if (!matrix.length) return;
    const startCol = active
      ? Math.max(
          0,
          pasteFields.findIndex((f) => f.key === block.columns[active.c]?.key),
        )
      : 0;
    const mapped = mapPasteColumns(matrix, pasteFields, startCol);
    if (matrix.length === 1 && matrix[0]?.length === 1 && active) {
      // Una sola celda sobre una celda: es editar.
      const row = navRows[active.r];
      const col = block.columns[active.c];
      if (row && col?.edit) return void commit(row, active.c, matrix[0]?.[0] ?? '');
    }
    const rows = buildPasteRows(mapped.body, mapped.targets);
    if (rows.length === 0 || mapped.targets.every((t) => !t))
      return say(false, 'No encontré columnas que se puedan pegar aquí.');
    if (mapped.body.length > PASTE_MAX_ROWS) say(false, `Se pegan las primeras ${PASTE_MAX_ROWS} filas.`);
    setPasteState({ rows, header: mapped.header, targets: mapped.targets, busy: true, server: null, error: null });
    const clean = rows.filter((r) => !r.errors.length);
    if (clean.length === rows.length) {
      const res = await writer.paste(block.id, rows.map((r) => r.values), false);
      setPasteState((s) =>
        s ? { ...s, busy: false, server: res.ok ? res.result : null, error: res.ok ? null : res.error } : s,
      );
    } else setPasteState((s) => (s ? { ...s, busy: false } : s));
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

  const downloadCsv = () => {
    const m = sheetMatrix(block, new Set(visible.map((r) => r.id)));
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
  const cellBase = clsx('truncate px-2 text-xs', rowH);

  // Esc fuera de una edición sale de la pantalla completa; Tab no se escapa del velo.
  const onWrapKeyDown = (e: React.KeyboardEvent) => {
    if (!full) return;
    const wrap = wrapRef.current;
    if (!wrap || !(e.target instanceof Node) || !wrap.contains(e.target)) return;
    const busy = Boolean(editing) || newRow || pasteState || filterOpen !== null;
    if (e.key === 'Escape' && !busy && !e.defaultPrevented) {
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
      <div className="view-no-print mb-3 flex flex-wrap items-center gap-2">
        <label className="flex h-9 min-w-[10rem] flex-1 items-center gap-2 rounded-pill border border-border bg-surface-2/70 px-3 focus-within:border-border-strong focus-within:bg-surface sm:max-w-xs">
          <Search className="h-4 w-4 text-ink-faint" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar en la hoja"
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
          {block.groups && (
            <button
              type="button"
              onClick={() =>
                setCollapsed((c) =>
                  c.size ? new Set() : new Set((block.groups ?? []).map((_, i) => i)),
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
          <button
            type="button"
            onClick={downloadCsv}
            className="inline-flex h-9 items-center gap-1.5 rounded-pill border border-border px-3 text-xs font-semibold text-ink-muted hover:text-ink"
            title="Descargar lo que se ve como CSV, con grupos y totales"
          >
            <Download className="h-3.5 w-3.5" aria-hidden /> CSV
          </button>
        </div>
      </div>

      <div
        ref={rootRef}
        role="grid"
        aria-label={block.title}
        aria-rowcount={navRows.length}
        aria-colcount={block.columns.length}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: la rejilla es el control; las flechas mueven la celda activa.
        tabIndex={0}
        onKeyDown={onKeyDown}
        style={viewW ? ({ '--sheet-view': `${viewW}px` } as React.CSSProperties) : undefined}
        onPaste={(e) => {
          if (editing) return;
          const text = e.clipboardData.getData('text/plain');
          if (text) {
            e.preventDefault();
            void startPaste(text);
          }
        }}
        className={clsx(
          'view-table-scroll scroll-slim overflow-auto border-y border-border outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
          full ? 'min-h-0 flex-1 -mx-3 sm:-mx-4' : '-mx-4 max-h-[70vh] sm:-mx-6',
        )}
      >
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
                style={{ height: 32 }}
              >
                <span className="sr-only">Fila</span>
              </th>
              {block.columns.map((c, i) => (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={sort?.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
                  className={clsx(
                    'top-0 border-b border-border bg-surface-2 px-2 text-left text-micro font-semibold uppercase tracking-field text-ink-faint',
                    i < frozen ? 'sticky z-20' : 'sticky z-10',
                    i === frozen - 1 && 'border-r',
                    c.kind === 'number' && 'text-right',
                  )}
                  style={{ ...(i < frozen ? { left: leftOf(i) } : {}), height: 32 }}
                >
                  <div className={clsx('flex items-center gap-1', c.kind === 'number' && 'justify-end')}>
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
                      values={block.rows.map((r) => r.cells[i] ?? '')}
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
            {lines.map((line) => {
              if (line.kind === 'group') {
                const g = block.groups?.[line.gi];
                if (!g) return null;
                const isClosed = collapsed.has(line.gi);
                const members = visible.filter((r) => r.group === line.gi);
                return (
                  <tr key={`g${line.gi}`}>
                    <td
                      colSpan={1 + block.columns.length}
                      className="border-b border-border bg-primary-soft/60 p-0"
                    >
                      <div className="sticky left-0 flex w-[var(--sheet-view,72rem)] flex-wrap items-center gap-x-5 gap-y-1 px-2 py-1.5">
                        <button
                          type="button"
                          aria-expanded={!isClosed}
                          onClick={() =>
                            setCollapsed((c) => {
                              const n = new Set(c);
                              if (n.has(line.gi)) n.delete(line.gi);
                              else n.add(line.gi);
                              return n;
                            })
                          }
                          className="inline-flex items-center gap-1 text-sm font-semibold text-ink"
                        >
                          {isClosed ? (
                            <ChevronRight className="h-4 w-4" aria-hidden />
                          ) : (
                            <ChevronDown className="h-4 w-4" aria-hidden />
                          )}
                          {g.label}
                          <span className="tabular font-mono text-micro font-normal text-ink-faint">
                            {line.count}
                          </span>
                        </button>
                        {g.fields.map((f) => (
                          <span key={f.label} className="text-xs text-ink-muted">
                            <span className="text-micro uppercase tracking-field text-ink-faint">
                              {f.label}
                            </span>{' '}
                            <span className="font-semibold text-ink">{f.value}</span>
                          </span>
                        ))}
                        <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-0.5">
                          {g.subtotals.map((ci) => {
                            const c = block.columns[ci];
                            if (!c) return null;
                            const op = block.totals.find((t) => t.col === ci)?.op ?? 'sum';
                            return (
                              <span key={c.key} className="text-xs text-ink-muted">
                                <span className="text-micro uppercase tracking-field text-ink-faint">
                                  {c.label}
                                </span>{' '}
                                <span className="tabular font-mono font-semibold text-ink">
                                  {sheetTotalDisplay(
                                    members.map((r) => r.sort[ci]),
                                    op,
                                    c.fmt,
                                  )}
                                </span>
                              </span>
                            );
                          })}
                          {block.write?.add &&
                            block.write.groupField &&
                            writer?.paste &&
                            /^[0-9a-f-]{36}$/i.test(g.key) && (
                              <button
                                type="button"
                                onClick={() => setNewRow({ group: g.key })}
                                className="inline-flex items-center gap-1 text-micro font-semibold text-primary hover:underline"
                              >
                                <Plus className="h-3 w-3" aria-hidden /> Fila aquí
                              </button>
                            )}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              }
              const r = line.row;
              const ri = navRows.indexOf(r);
              return (
                <tr
                  key={r.id}
                  className={clsx(
                    flash(block.id, r.id),
                    'group/row',
                    r.rowTone ? TONE_SOFT[r.rowTone] : r.alert ? 'bg-rose-soft' : 'hover:bg-surface-2/60',
                  )}
                >
                  <td
                    className={clsx(
                      'sticky left-0 z-10 border-b border-r border-border bg-surface-2 text-center text-micro text-ink-faint',
                      rowH,
                    )}
                  >
                    {open && !full ? (
                      <button
                        type="button"
                        onClick={() => open(r.id)}
                        aria-label={`Abrir la ficha de ${r.cells[0]}`}
                        className="inline-flex h-full w-full items-center justify-center hover:text-primary"
                      >
                        <span className="tabular font-mono group-hover/row:hidden max-sm:hidden">{ri + 1}</span>
                        <PanelRightOpen className="hidden h-3.5 w-3.5 group-hover/row:block max-sm:block" aria-hidden />
                      </button>
                    ) : (
                      <span className="tabular font-mono">{ri + 1}</span>
                    )}
                  </td>
                  {block.columns.map((c, ci) => {
                    const isActive = active?.r === ri && active.c === ci;
                    const key = `${r.id}:${ci}`;
                    const tone = r.tones[ci];
                    const shown = pending[key];
                    const isEditing = isActive && editing && !compact;
                    return (
                      <td
                        key={c.key}
                        role="gridcell"
                        data-cell={`${ri}:${ci}`}
                        aria-selected={isActive}
                        onMouseDown={() => {
                          setActive({ r: ri, c: ci });
                        }}
                        onClick={() => {
                          if (compact && editableCol(c)) setActive({ r: ri, c: ci }), startEdit();
                        }}
                        onDoubleClick={() => {
                          if (!compact) startEdit();
                        }}
                        className={clsx(
                          'border-b border-border/70',
                          cellBase,
                          ci < frozen && 'sticky z-10',
                          ci < frozen && (r.rowTone ? '' : 'bg-surface'),
                          ci === frozen - 1 && 'border-r border-border',
                          c.kind === 'number' ? 'tabular text-right font-mono' : '',
                          ci === 0 ? 'font-semibold text-ink' : 'text-ink-muted',
                          c.kind === 'number' && 'text-ink',
                          tone && TONE_SOFT[tone],
                          isActive && 'outline outline-2 -outline-offset-2 outline-primary',
                          editableCol(c) && !isActive && 'cursor-cell',
                        )}
                        style={ci < frozen ? { left: leftOf(ci) } : undefined}
                      >
                        {isEditing && isRelationCol(c) && target ? (
                          <RelationCombo
                            target={target}
                            blockId={block.id}
                            field={c.key}
                            label={c.label}
                            current={rawText(pending[key] ?? r.sort[ci])}
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
                        ) : (
                          <span className={clsx('block truncate', shown !== undefined && 'italic')}>
                            {shown !== undefined ? displayPending(c, shown) : c.type === 'checkbox' ? r.cells[ci] : r.cells[ci]}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
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
                    style={{ ...(ci < frozen ? { left: leftOf(ci) } : {}), height: 36 }}
                  >
                    {ci === 0 && !totalOf(0) ? (
                      <span className="text-micro uppercase tracking-field text-ink-faint">
                        Total · {visible.length} {visible.length === 1 ? 'fila' : 'filas'}
                      </span>
                    ) : (
                      totalOf(ci)
                    )}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p
        role="status"
        className={clsx('mt-2 min-h-4 text-micro', full && 'pl-12', note ? (note.ok ? 'text-emerald' : 'text-rose') : 'text-ink-faint')}
      >
        {note
          ? note.text
          : block.write
            ? 'Flechas para moverte · Enter o escribir para editar · Ctrl+V pega desde Excel'
            : 'Sólo lectura'}
      </p>

      {block.actions.length > 0 && active && navRows[active.r] && (
        <div className="mt-2 border-t border-border/70 pt-2">
          <RowActions
            blockId={block.id}
            actions={block.actions}
            rowId={(navRows[active.r] as Row).id}
            rowLabel={(navRows[active.r] as Row).cells[0] ?? ''}
          />
        </div>
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
                    pending[`${(navRows[active.r] as Row).id}:${active.c}`] ??
                      (navRows[active.r] as Row).sort[active.c],
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
          onManual={(text) => void startPaste(text)}
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
