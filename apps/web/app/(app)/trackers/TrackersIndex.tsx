'use client';

import { Sheet } from '@/components/datagrid/dialogs';
import {
  ghostButton,
  inputClass,
  primaryButton,
  selectClass,
  toolbarButton,
} from '@/components/datagrid/primitives';
import { PageHeader } from '@/components/ui/page-header';
import { parseCsv } from '@/lib/datagrid/csv';
import { foldText, formatNumber } from '@/lib/datagrid/format';
import {
  MAX_TRACKER_FIELDS,
  TRACKER_FIELD_TYPES,
  TRACKER_TYPE_LABEL,
  type TrackerFieldLike,
  type TrackerFieldType,
  convertRows,
  fieldKeyFrom,
  optionsFrom,
  planImport,
} from '@/lib/datagrid/trackers';
import { DOT_TONE, type StatusTone, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  FileSpreadsheet,
  FolderSync,
  LoaderCircle,
  Plus,
  Ruler,
  Search,
  Sparkles,
  Table2,
  Trash2,
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useRef, useState } from 'react';
import { chatWith, timeAgo } from './[slug]/TrackerScreen';
import type { SyncBadge, TrackerCardData, TrackersIndexActions } from './types';

/**
 * La lista de tablas de la empresa y las tres maneras de empezar una:
 * armarla aquí, importar un CSV/Excel (con vista previa de columnas y tipos) o
 * contársela a Cortex en el chat.
 */

const SYNC_TONE: Record<SyncBadge['state'], StatusTone> = {
  ok: 'emerald',
  error: 'rose',
  paused: 'neutral',
  waiting: 'amber',
};

export function tableHref(base: string, slug: string): string {
  const url = new URL(base, 'https://cortex.invalid');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(slug)}`;
  return `${url.pathname}${url.search}`;
}

const DESCRIBE_PROMPT =
  'Quiero llevar una tabla nueva en Cortex. Te cuento qué quiero seguir y tú me propones las columnas (con su tipo) antes de crearla: ';

export function TrackersIndex({
  cards,
  actions,
  canCreate,
  links,
  hrefForTable,
}: {
  cards: TrackerCardData[];
  actions: TrackersIndexActions;
  canCreate: boolean;
  links: { base: string; chatBase: string };
  /** Solo la vitrina: a dónde lleva una tabla (por defecto `<base>/<slug>`). */
  hrefForTable?: (slug: string) => string;
}) {
  const href = hrefForTable ?? ((slug: string) => tableHref(links.base, slug));
  const [query, setQuery] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const shown = useMemo(() => {
    const q = foldText(query);
    return q ? cards.filter((c) => foldText(`${c.name} ${c.description}`).includes(q)) : cards;
  }, [cards, query]);
  const describeHref = chatWith(links.chatBase, DESCRIBE_PROMPT);

  return (
    <>
      <PageHeader
        title="Tablas"
        subtitle="Lo que tu empresa lleva en tablas: guías, remates, contenedores, lo que no cabe en otro lado. Ábrelas para filtrar, editar y exportar."
        icon={<Table2 className="h-5 w-5" />}
        actions={
          canCreate ? (
            <>
              <button type="button" onClick={() => setImportOpen(true)} className={toolbarButton}>
                <Upload className="h-4 w-4" aria-hidden />
                Importar CSV/Excel
              </button>
              <Link href={describeHref} className={toolbarButton}>
                <Sparkles className="h-4 w-4 text-primary" aria-hidden />
                Descríbela a Cortex
              </Link>
              <button type="button" onClick={() => setNewOpen(true)} className={primaryButton}>
                <Plus className="h-4 w-4" aria-hidden />
                Nueva tabla
              </button>
            </>
          ) : null
        }
      />

      {cards.length > 6 ? (
        <label className="relative mb-5 flex max-w-sm items-center">
          <Search
            className="pointer-events-none absolute left-3 h-4 w-4 text-ink-faint"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar tablas…"
            aria-label="Buscar tablas"
            className="h-10 w-full rounded-pill border border-border bg-surface pl-9 pr-3 text-xs text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </label>
      ) : null}

      {!cards.length ? (
        <div className="rounded-card border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
          <Table2 className="mx-auto h-8 w-8 text-primary" aria-hidden />
          <p className="mt-3 text-base font-bold text-ink">Todavía no hay tablas</p>
          <p className="mx-auto mt-2 max-w-lg text-sm text-ink-muted">
            Una tabla es para lo que tu empresa sigue y no tiene pantalla propia: guías de carga,
            remates, contenedores, placas. Créala aquí, impórtala de un Excel o cuéntale a Cortex
            qué quieres llevar.
          </p>
          {canCreate ? (
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={() => setNewOpen(true)} className={primaryButton}>
                <Plus className="h-4 w-4" aria-hidden />
                Nueva tabla
              </button>
              <button type="button" onClick={() => setImportOpen(true)} className={toolbarButton}>
                <Upload className="h-4 w-4" aria-hidden />
                Importar CSV/Excel
              </button>
              <Link href={describeHref} className={toolbarButton}>
                <Sparkles className="h-4 w-4 text-primary" aria-hidden />
                Descríbela a Cortex
              </Link>
            </div>
          ) : null}
        </div>
      ) : !shown.length ? (
        <p className="rounded-card border border-dashed border-border px-6 py-10 text-center text-sm text-ink-muted">
          Ninguna tabla se llama así.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((c) => (
            <li key={c.id}>
              <TrackerCard card={c} href={href(c.slug)} />
            </li>
          ))}
        </ul>
      )}

      <NewTableDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        actions={actions}
        href={href}
        describeHref={describeHref}
      />
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        actions={actions}
        cards={cards}
        href={href}
      />
    </>
  );
}

function TrackerCard({ card, href }: { card: TrackerCardData; href: string }) {
  const failing = card.syncs.some((s) => s.state === 'error');
  return (
    <Link
      href={href}
      className={clsx(
        'group flex h-full flex-col rounded-card border bg-surface p-5 shadow-card transition-all duration-150 hover:-translate-y-px hover:border-border-strong motion-reduce:transform-none',
        failing ? 'border-rose/30' : 'border-border',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
          <Table2 className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold text-ink group-hover:text-primary">
            {card.name}
          </h2>
          <p className="tabular text-micro text-ink-faint">{card.slug}</p>
        </div>
      </div>
      {card.description ? (
        <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-ink-muted">
          {card.description}
        </p>
      ) : null}
      <dl className="mt-4 grid grid-cols-3 gap-2">
        <div>
          <dt className="text-micro text-ink-faint">Filas</dt>
          <dd className="stat-num text-lg text-ink">{formatNumber(card.rowCount, 0)}</dd>
        </div>
        <div>
          <dt className="text-micro text-ink-faint">Columnas</dt>
          <dd className="stat-num text-lg text-ink">{card.fieldCount}</dd>
        </div>
        <div>
          <dt className="text-micro text-ink-faint">Cambió</dt>
          <dd className="tabular pt-1 text-xs font-semibold text-ink" suppressHydrationWarning>
            {timeAgo(card.updatedAt)}
          </dd>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap gap-1.5 border-t border-border pt-3">
        {card.syncs.map((s) => (
          <span
            key={s.id}
            className={chipClass(SYNC_TONE[s.state])}
            title={s.lastError ?? undefined}
          >
            <FolderSync className="h-3 w-3" aria-hidden />
            <span className="max-w-[180px] truncate">{s.source}</span>
            {s.state === 'error' ? '· falló' : s.state === 'paused' ? '· en pausa' : ''}
          </span>
        ))}
        {card.workType ? (
          <span className={chipClass('primary')}>
            <Ruler className="h-3 w-3" aria-hidden />
            Se mide como trabajo · {card.workType}
          </span>
        ) : null}
        {!card.syncs.length ? (
          <span className={chipClass('neutral')}>
            <span className={clsx('h-1.5 w-1.5 rounded-full', DOT_TONE.neutral)} aria-hidden />
            {card.createdBy ? `La lleva el equipo · creó ${card.createdBy}` : 'La lleva el equipo'}
          </span>
        ) : null}
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Nueva tabla
// ---------------------------------------------------------------------------

type DraftField = {
  id: number;
  label: string;
  type: TrackerFieldType;
  required: boolean;
  options: string;
};

function NewTableDialog({
  open,
  onOpenChange,
  actions,
  href,
  describeHref,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: TrackersIndexActions;
  href: (slug: string) => string;
  describeHref: string;
}) {
  const router = useRouter();
  const seq = useRef(3);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<DraftField[]>([
    { id: 1, label: 'Nombre', type: 'text', required: true, options: '' },
    {
      id: 2,
      label: 'Estado',
      type: 'select',
      required: false,
      options: 'Pendiente, En curso, Hecho',
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const descId = useId();

  const patch = (id: number, p: Partial<DraftField>) =>
    setFields((fs) => fs.map((f) => (f.id === id ? { ...f, ...p } : f)));

  const submit = async () => {
    if (!name.trim()) return setError('Ponle un nombre a la tabla.');
    const list = fields.filter((f) => f.label.trim());
    if (!list.length) return setError('Agrega al menos una columna.');
    const bad = list.find(
      (f) => f.type === 'select' && !f.options.split(',').some((o) => o.trim()),
    );
    if (bad) return setError(`«${bad.label}» necesita al menos una opción.`);
    setBusy(true);
    setError(null);
    const r = await actions.createTracker({
      name: name.trim(),
      description: description.trim(),
      fields: list.map((f) => ({
        label: f.label.trim(),
        type: f.type,
        required: f.required,
        ...(f.type === 'select'
          ? {
              options: f.options
                .split(',')
                .map((o) => o.trim())
                .filter(Boolean),
            }
          : {}),
      })),
    });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onOpenChange(false);
    router.push(href(r.slug));
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="center"
      title="Nueva tabla"
      description="El nombre y las columnas. Después puedes agregar más columnas desde la tabla."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div>
          <label htmlFor={nameId} className="field-label mb-1 block">
            Nombre
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="Ej.: Guías de carga"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={descId} className="field-label mb-1 block">
            Qué va aquí (opcional)
          </label>
          <input
            id={descId}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            placeholder="Una línea para que nadie cree otra igual"
            className={inputClass}
          />
        </div>
        <fieldset>
          <legend className="field-label mb-2">Columnas</legend>
          <ol className="flex flex-col gap-2">
            {fields.map((f, i) => (
              <li key={f.id} className="rounded-sm border border-border bg-surface-2/50 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="tabular w-5 text-micro text-ink-faint">{i + 1}.</span>
                  <input
                    value={f.label}
                    onChange={(e) => patch(f.id, { label: e.target.value })}
                    aria-label={`Nombre de la columna ${i + 1}`}
                    maxLength={60}
                    className={clsx(inputClass, 'flex-1')}
                  />
                  <select
                    value={f.type}
                    onChange={(e) => patch(f.id, { type: e.target.value as TrackerFieldType })}
                    aria-label={`Tipo de la columna ${i + 1}`}
                    className={selectClass}
                  >
                    {TRACKER_FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TRACKER_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setFields((fs) => fs.filter((x) => x.id !== f.id))}
                    disabled={fields.length === 1}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface hover:text-rose disabled:opacity-30"
                    aria-label={`Quitar ${f.label || 'columna'}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
                {f.type === 'select' ? (
                  <input
                    value={f.options}
                    onChange={(e) => patch(f.id, { options: e.target.value })}
                    aria-label={`Opciones de ${f.label}`}
                    placeholder="Opciones separadas por coma"
                    className={clsx(inputClass, 'mt-2')}
                  />
                ) : null}
                <label className="mt-2 flex items-center gap-2 pl-7 text-micro text-ink-muted">
                  <input
                    type="checkbox"
                    checked={f.required}
                    onChange={(e) => patch(f.id, { required: e.target.checked })}
                  />
                  Obligatoria
                </label>
              </li>
            ))}
          </ol>
          {fields.length < MAX_TRACKER_FIELDS ? (
            <button
              type="button"
              onClick={() => {
                seq.current += 1;
                setFields((fs) => [
                  ...fs,
                  { id: seq.current, label: '', type: 'text', required: false, options: '' },
                ]);
              }}
              className={clsx(ghostButton, 'mt-2')}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Agregar columna
            </button>
          ) : null}
        </fieldset>
        {error ? (
          <p role="alert" className="text-micro font-semibold text-rose">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <Link
            href={describeHref}
            className="text-micro font-semibold text-primary hover:underline"
          >
            ¿Prefieres contárselo a Cortex?
          </Link>
          <div className="flex gap-2">
            <button type="button" onClick={() => onOpenChange(false)} className={ghostButton}>
              Cancelar
            </button>
            <button type="submit" disabled={busy} className={primaryButton}>
              {busy ? 'Creando…' : 'Crear tabla'}
            </button>
          </div>
        </div>
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Importar CSV / Excel
// ---------------------------------------------------------------------------

type PlanField = TrackerFieldLike & { source: number };

function ImportDialog({
  open,
  onOpenChange,
  actions,
  cards,
  href,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: TrackersIndexActions;
  cards: TrackerCardData[];
  href: (slug: string) => string;
}) {
  const router = useRouter();
  const [file, setFile] = useState<{ name: string; header: string[]; body: string[][] } | null>(
    null,
  );
  const [target, setTarget] = useState<string>('new');
  const [name, setName] = useState('');
  const [fields, setFields] = useState<PlanField[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    inserted: number;
    errors: Array<{ row: number; message: string }>;
    slug: string;
  } | null>(null);
  const fileId = useId();

  const reset = () => {
    setFile(null);
    setTarget('new');
    setName('');
    setFields([]);
    setNotes([]);
    setProgress(null);
    setError(null);
    setResult(null);
  };

  const plan = (header: string[], body: string[][], to: string) => {
    const existing = to === 'new' ? undefined : cards.find((c) => c.id === to)?.fields;
    const p = planImport(header, body, existing);
    setFields(p.fields);
    setNotes(p.notes);
  };

  const read = async (f: File) => {
    setError(null);
    setResult(null);
    let rows: string[][];
    if (f.name.toLowerCase().endsWith('.csv') || f.type === 'text/csv') {
      rows = parseCsv(await f.text());
    } else {
      const form = new FormData();
      form.set('file', f);
      setBusy(true);
      const r = await actions.readSpreadsheet(form);
      setBusy(false);
      if (!r.ok) return setError(r.error);
      rows = r.rows;
    }
    const [header, ...body] = rows;
    if (!header || !body.length)
      return setError('El archivo necesita una fila de encabezados y al menos una fila de datos.');
    if (body.length > 5000) setNotes(['Se importan las primeras 5.000 filas.']);
    const trimmed = body.slice(0, 5000);
    setFile({ name: f.name, header, body: trimmed });
    setName(
      f.name
        .replace(/\.(csv|xlsx)$/i, '')
        .replace(/[_-]+/g, ' ')
        .trim()
        .slice(0, 80),
    );
    plan(header, trimmed, target);
  };

  const converted = useMemo(() => (file ? convertRows(fields, file.body) : null), [file, fields]);

  const run = async () => {
    if (!file || !converted) return;
    setBusy(true);
    setError(null);
    let trackerId = target;
    let slug = cards.find((c) => c.id === target)?.slug ?? '';
    let rows = converted.rows;
    if (target === 'new') {
      if (!name.trim()) {
        setBusy(false);
        return setError('Ponle un nombre a la tabla nueva.');
      }
      const created = await actions.createTracker({
        name: name.trim(),
        description: `Importada de ${file.name}.`,
        fields: fields.map((f) => ({
          label: f.label,
          type: f.type,
          required: false,
          ...(f.options ? { options: f.options } : {}),
        })),
      });
      if (!created.ok) {
        setBusy(false);
        return setError(created.error);
      }
      trackerId = created.id;
      slug = created.slug;
      // Las claves las decide el servidor; se reescriben por posición.
      const rename = new Map(fields.map((f, i) => [f.key, created.keys[i] ?? f.key]));
      rows = rows.map((r) =>
        Object.fromEntries(Object.entries(r).map(([k, v]) => [rename.get(k) ?? k, v])),
      );
    }
    let inserted = 0;
    const errors: Array<{ row: number; message: string }> = [];
    setProgress({ done: 0, total: rows.length });
    for (let i = 0; i < rows.length; i += 500) {
      const r = await actions.importRows(trackerId, rows.slice(i, i + 500));
      if (!r.ok) {
        errors.push({ row: i + 1, message: r.error });
        break;
      }
      inserted += r.inserted;
      errors.push(...r.errors.map((e) => ({ row: e.row + i, message: e.message })));
      setProgress({ done: Math.min(rows.length, i + 500), total: rows.length });
    }
    setBusy(false);
    setResult({ inserted, errors: errors.slice(0, 20), slug });
    router.refresh();
  };

  const preview = converted?.rows.slice(0, 5) ?? [];

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) reset();
        if (!busy) onOpenChange(o);
      }}
      side="center"
      title="Importar CSV o Excel"
      description="La primera fila son los nombres de las columnas. Revisas los tipos antes de importar."
    >
      {result ? (
        <div className="flex flex-col gap-3">
          <p className="text-base font-bold text-ink">
            Importado: <span className="tabular">{formatNumber(result.inserted, 0)}</span> filas.
          </p>
          {result.errors.length ? (
            <div className="rounded-sm bg-amber-soft p-3 text-micro text-amber">
              <p className="mb-1 font-semibold">No entraron {result.errors.length} filas:</p>
              <ul className="list-disc pl-4">
                {result.errors.slice(0, 8).map((e) => (
                  <li key={`${e.row}-${e.message}`}>
                    Fila <span className="tabular">{e.row}</span>: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={reset} className={ghostButton}>
              Importar otro
            </button>
            <Link
              href={href(result.slug)}
              className={primaryButton}
              onClick={() => onOpenChange(false)}
            >
              Abrir la tabla
            </Link>
          </div>
        </div>
      ) : !file ? (
        <div className="flex flex-col gap-3">
          <label
            htmlFor={fileId}
            className="flex cursor-pointer flex-col items-center gap-2 rounded-card border-2 border-dashed border-border-strong px-6 py-10 text-center hover:border-primary hover:bg-primary-soft/40"
          >
            {busy ? (
              <LoaderCircle className="h-7 w-7 animate-spin text-primary" aria-hidden />
            ) : (
              <FileSpreadsheet className="h-7 w-7 text-primary" aria-hidden />
            )}
            <span className="text-sm font-bold text-ink">
              {busy ? 'Leyendo…' : 'Elige un archivo .csv o .xlsx'}
            </span>
            <span className="text-micro text-ink-muted">Hasta 5.000 filas y 20 columnas.</span>
          </label>
          <input
            id={fileId}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void read(f);
              e.target.value = '';
            }}
          />
          {error ? (
            <p role="alert" className="text-micro font-semibold text-rose">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-ink-muted">
            <span className="font-semibold text-ink">{file.name}</span> ·{' '}
            <span className="tabular">{formatNumber(file.body.length, 0)}</span> filas
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="field-label">Importar a</span>
              <select
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value);
                  plan(file.header, file.body, e.target.value);
                }}
                className={clsx(selectClass, 'w-full')}
              >
                <option value="new">Una tabla nueva</option>
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {target === 'new' ? (
              <label className="flex flex-col gap-1">
                <span className="field-label">Nombre de la tabla</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  className={inputClass}
                />
              </label>
            ) : null}
          </div>

          <div>
            <p className="field-label mb-2">Columnas</p>
            <ul className="flex flex-col gap-1.5">
              {fields.map((f, i) => (
                <li key={f.key} className="flex items-center gap-2">
                  <span
                    className="min-w-0 flex-1 truncate text-xs text-ink-muted"
                    title={file.header[f.source]}
                  >
                    {file.header[f.source] || `Columna ${f.source + 1}`}
                  </span>
                  <span className="text-ink-faint" aria-hidden>
                    →
                  </span>
                  {target === 'new' ? (
                    <>
                      <input
                        value={f.label}
                        onChange={(e) =>
                          setFields((fs) =>
                            fs.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    label: e.target.value.slice(0, 60),
                                    key: fieldKeyFrom(
                                      e.target.value || x.label,
                                      fs.filter((_, k) => k !== j).map((y) => y.key),
                                    ),
                                  }
                                : x,
                            ),
                          )
                        }
                        aria-label={`Nombre de ${file.header[f.source]}`}
                        className={clsx(inputClass, 'h-8 w-36')}
                      />
                      <select
                        value={f.type}
                        onChange={(e) => {
                          const type = e.target.value as TrackerFieldType;
                          setFields((fs) =>
                            fs.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    type,
                                    ...(type === 'select'
                                      ? { options: optionsFrom(file.body, x.source) }
                                      : { options: undefined }),
                                  }
                                : x,
                            ),
                          );
                        }}
                        aria-label={`Tipo de ${file.header[f.source]}`}
                        className={clsx(selectClass, 'h-8')}
                      >
                        {TRACKER_FIELD_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {TRACKER_TYPE_LABEL[t]}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}
                        disabled={fields.length === 1}
                        className="grid h-7 w-7 place-items-center rounded-pill text-ink-faint hover:text-rose disabled:opacity-30"
                        aria-label={`No importar ${file.header[f.source]}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </>
                  ) : (
                    <span className="text-xs font-semibold text-ink">
                      {f.label}{' '}
                      <span className="font-normal text-ink-faint">
                        ({TRACKER_TYPE_LABEL[f.type]})
                      </span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {preview.length ? (
            <div className="overflow-x-auto rounded-sm border border-border">
              <table className="w-full text-left text-micro">
                <thead className="bg-surface-2">
                  <tr>
                    {fields.map((f) => (
                      <th
                        key={f.key}
                        className="whitespace-nowrap px-2 py-1.5 font-semibold text-ink-muted"
                      >
                        {f.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: vista previa estática.
                    <tr key={i} className="border-t border-border">
                      {fields.map((f) => (
                        <td key={f.key} className="tabular whitespace-nowrap px-2 py-1.5 text-ink">
                          {r[f.key] === undefined ? (
                            <span className="text-ink-faint">—</span>
                          ) : (
                            String(r[f.key])
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {[
            ...notes,
            ...(converted?.dropped
              ? [`${converted.dropped} celdas no encajan con su tipo y quedan vacías.`]
              : []),
          ].map((n) => (
            <p key={n} className="text-micro text-amber">
              {n}
            </p>
          ))}
          {error ? (
            <p role="alert" className="text-micro font-semibold text-rose">
              {error}
            </p>
          ) : null}
          {progress ? (
            <div aria-live="polite">
              <div className="h-1.5 overflow-hidden rounded-pill bg-surface-2">
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{
                    width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`,
                  }}
                />
              </div>
              <p className="tabular mt-1 text-micro text-ink-muted">
                {formatNumber(progress.done, 0)} de {formatNumber(progress.total, 0)}
              </p>
            </div>
          ) : null}
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <button type="button" onClick={reset} disabled={busy} className={ghostButton}>
              Otro archivo
            </button>
            <button
              type="button"
              onClick={() => void run()}
              disabled={busy || !converted?.rows.length || !fields.length}
              className={primaryButton}
            >
              <Upload className="h-4 w-4" aria-hidden />
              {busy
                ? 'Importando…'
                : `Importar ${formatNumber(converted?.rows.length ?? 0, 0)} filas`}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
