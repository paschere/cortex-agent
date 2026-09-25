'use client';

import { submitViewFormAction } from '@/lib/views/actions';
import type { ComputedBlock, ComputedView, Tone } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Loader2,
  Search,
  Send,
} from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ViewChart } from './ViewChart';
import { EditableCell, RowActions, ViewWriterProvider, useViewWriter } from './view-writes';

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
 */

export type SubmitTarget =
  | { kind: 'app'; viewId: string }
  | { kind: 'public'; token: string }
  | { kind: 'preview' };

export type SubmitFn = (
  blockId: string,
  values: Record<string, string>,
) => Promise<{ ok: true; message: string } | { ok: false; error: string }>;

/** Adentro por server action (con sesión); afuera por la ruta pública (con token). */
function submitterFor(target: SubmitTarget): SubmitFn | undefined {
  if (target.kind === 'app')
    return (blockId, values) => submitViewFormAction(target.viewId, blockId, values);
  if (target.kind === 'public')
    return async (blockId, values) => {
      try {
        const res = await fetch('/api/views/public/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: target.token, blockId, values }),
        });
        const body = (await res.json().catch(() => null)) as {
          message?: string;
          error?: string;
        } | null;
        return res.ok && body?.message
          ? { ok: true, message: body.message }
          : { ok: false, error: body?.error ?? 'No se pudo enviar. Inténtalo otra vez.' };
      } catch {
        return { ok: false, error: 'Sin conexión. Inténtalo otra vez.' };
      }
    };
  return undefined;
}

const SPAN: Record<ComputedBlock['width'], string> = {
  full: 'md:col-span-6',
  half: 'md:col-span-3',
  third: 'md:col-span-3 xl:col-span-2',
};

const TONE_TEXT: Record<Tone, string> = {
  primary: 'text-primary',
  emerald: 'text-emerald',
  amber: 'text-amber',
  sky: 'text-sky',
  rose: 'text-rose',
};
const TONE_BAR: Record<Tone, string> = {
  primary: 'bg-primary',
  emerald: 'bg-emerald',
  amber: 'bg-amber',
  sky: 'bg-sky',
  rose: 'bg-rose',
};

export function ViewCanvas({
  view,
  target,
  onChanged,
}: {
  view: ComputedView;
  target: SubmitTarget;
  /** Después de una escritura: el refresco en vivo lo usa para recalcular. */
  onChanged?: () => void;
}) {
  const submit = submitterFor(target);
  return (
    <ViewWriterProvider target={view.writable ? target : { kind: 'preview' }} onChanged={onChanged}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
        {view.blocks.map((block) => (
          <section key={block.id} className={clsx('min-w-0', SPAN[block.width])}>
            <Block block={block} target={target} submit={submit} />
          </section>
        ))}
        {view.partial.length > 0 && (
          <p className="text-micro text-ink-faint md:col-span-6">
            Cifras calculadas sobre las 2.000 filas más recientes de {view.partial.join(', ')}.
          </p>
        )}
      </div>
    </ViewWriterProvider>
  );
}

function Card({
  title,
  source,
  children,
  className,
}: { title?: string; source?: string; children: React.ReactNode; className?: string }) {
  return (
    <div
      className={clsx(
        'h-full rounded-card border border-border bg-surface p-4 shadow-card sm:p-5',
        className,
      )}
    >
      {(title || source) && (
        <header className="mb-3 flex items-baseline justify-between gap-3">
          {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
          {source && <span className="shrink-0 text-micro text-ink-faint">{source}</span>}
        </header>
      )}
      {children}
    </div>
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
        <div className="prose prose-sm max-w-none px-1 text-ink prose-headings:font-bold prose-headings:text-ink prose-p:leading-relaxed prose-p:text-ink-muted prose-a:text-primary prose-strong:text-ink prose-li:text-ink-muted">
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
      return <Metric block={block} />;
    case 'table':
      return <Table block={block} />;
    case 'chart':
      return (
        <Card title={block.title} source={block.source}>
          <ViewChart block={block} />
          <p className="mt-3 text-micro text-ink-faint">
            Total: <span className="tabular font-mono text-ink-muted">{block.total}</span>
          </p>
        </Card>
      );
    case 'board':
      return <Board block={block} />;
    case 'form':
      return <Form block={block} target={target} submit={submit} />;
    case 'problem':
      return (
        <Card className="border-amber/40 bg-amber-soft/40">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
            <div>
              <p className="text-sm font-semibold text-ink">{block.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">{block.message}</p>
            </div>
          </div>
        </Card>
      );
  }
}

function Metric({ block }: { block: Extract<ComputedBlock, { type: 'metric' }> }) {
  const pct = block.goal ? Math.max(0, Math.min(block.goal.ratio, 1)) : 0;
  return (
    <Card>
      <p className="field-label">{block.title}</p>
      <p
        className={clsx(
          'tabular mt-2 font-mono text-display font-semibold leading-none tracking-tight',
          TONE_TEXT[block.tone],
        )}
      >
        {block.display}
      </p>
      {block.goal ? (
        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-pill bg-surface-2">
            <div
              className={clsx(
                'h-full rounded-pill transition-[width] duration-500 ease-out',
                TONE_BAR[block.tone],
              )}
              style={{ width: `${pct * 100}%` }}
            />
          </div>
          <p className="mt-1.5 text-micro text-ink-faint">
            {Math.round(block.goal.ratio * 100)}% de la meta ·{' '}
            <span className="tabular font-mono">{block.goal.display}</span>
          </p>
        </div>
      ) : (
        <p className="mt-3 text-micro text-ink-faint">
          {block.caption ??
            `${block.rows} ${block.rows === 1 ? 'fila' : 'filas'} · ${block.source}`}
        </p>
      )}
    </Card>
  );
}

function Table({ block }: { block: Extract<ComputedBlock, { type: 'table' }> }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
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

  return (
    <Card
      title={block.title}
      source={`${block.total} ${block.total === 1 ? 'fila' : 'filas'} · ${block.source}`}
    >
      {block.searchable && block.rows.length > 5 && (
        <label className="mb-3 flex items-center gap-2 rounded-pill border border-border bg-surface-2 px-3 py-1.5 focus-within:border-border-strong">
          <Search className="h-3.5 w-3.5 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar en la tabla"
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
        </label>
      )}
      <div className="scroll-slim -mx-4 overflow-x-auto sm:-mx-5">
        <table className="w-full min-w-[32rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              {block.columns.map((c, i) => (
                <th
                  key={c.key}
                  scope="col"
                  className={clsx(
                    'px-4 py-2 text-left text-micro font-semibold uppercase tracking-field text-ink-faint first:pl-4 sm:first:pl-5',
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
                    className="inline-flex items-center gap-1 hover:text-ink"
                  >
                    {c.label}
                    {sort?.col === i &&
                      (sort.dir === 1 ? (
                        <ArrowUp className="h-3 w-3" />
                      ) : (
                        <ArrowDown className="h-3 w-3" />
                      ))}
                  </button>
                </th>
              ))}
              {block.actions.length > 0 && (
                <th scope="col" className="px-4 py-2" aria-label="Acciones" />
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-b border-border/60 last:border-0 hover:bg-surface-2/60"
              >
                {r.cells.map((cell, i) => {
                  const column = block.columns[i];
                  const className = clsx(
                    'px-4 py-2.5 align-top first:pl-4 sm:first:pl-5',
                    i === 0 ? 'font-medium text-ink' : 'text-ink-muted',
                    column?.kind !== 'text' && 'tabular font-mono text-xs',
                    column?.kind === 'number' && 'text-right',
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
                      {cell}
                    </td>
                  );
                })}
                {block.actions.length > 0 && (
                  <td className="whitespace-nowrap px-4 py-2 text-right align-top">
                    <RowActions
                      blockId={block.id}
                      actions={block.actions}
                      rowId={r.id}
                      rowLabel={r.cells[0] ?? ''}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="px-5 py-8 text-center text-sm text-ink-faint">
            {query ? 'Nada coincide con esa búsqueda.' : 'Todavía no hay filas.'}
          </p>
        )}
      </div>
      {block.total > block.rows.length && (
        <p className="mt-2 text-micro text-ink-faint">
          Se muestran {block.rows.length} de {block.total}.
        </p>
      )}
    </Card>
  );
}

function Board({ block }: { block: Extract<ComputedBlock, { type: 'board' }> }) {
  const writer = useViewWriter();
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
      <div className="scroll-slim -mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
        {block.columns.map((col) => (
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
              'w-64 min-w-[15rem] flex-1 shrink-0 rounded-sm bg-surface-2 p-2.5 transition-colors',
              over === col.key && 'bg-primary-soft/60 ring-2 ring-primary/40',
            )}
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-xs font-semibold text-ink">{col.label}</span>
              <span className="tabular rounded-pill bg-surface px-2 py-0.5 font-mono text-micro text-ink-muted">
                {col.count}
              </span>
            </div>
            <ul className="space-y-2">
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
                    'rounded-sm border border-border bg-surface p-3 shadow-card',
                    canDrag && 'cursor-grab active:cursor-grabbing',
                    dragging === card.id && 'opacity-50',
                  )}
                >
                  <p className="text-sm font-medium text-ink">{card.label}</p>
                  {card.details.length > 0 && (
                    <dl className="mt-1.5 space-y-0.5">
                      {card.details.map((d) => (
                        <div key={d.label} className="flex justify-between gap-2 text-micro">
                          <dt className="text-ink-faint">{d.label}</dt>
                          <dd className="truncate text-ink-muted">{d.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {(block.actions.length > 0 || canDrag) && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
                <li className="px-1 text-micro text-ink-faint">
                  y {col.count - col.cards.length} más
                </li>
              )}
              {col.count === 0 && (
                <li className="px-1 py-3 text-center text-micro text-ink-faint">Vacío</li>
              )}
            </ul>
          </div>
        ))}
      </div>
      {moveError && <p className="mt-2 text-xs text-rose">{moveError}</p>}
    </Card>
  );
}

const INPUT =
  'w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30';

function Form({
  block,
  target,
  submit,
}: {
  block: Extract<ComputedBlock, { type: 'form' }>;
  target: SubmitTarget;
  submit?: SubmitFn;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const disabled = target.kind === 'preview' || !submit;

  if (done) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <CheckCircle2 className="h-8 w-8 text-emerald" />
          <p className="text-sm font-semibold text-ink">{done}</p>
          <button
            type="button"
            className="mt-2 text-xs font-semibold text-primary hover:underline"
            onClick={() => {
              setDone(null);
              setValues({});
            }}
          >
            Enviar otro
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card title={block.title}>
      {block.intro && (
        <p className="-mt-1 mb-4 text-sm leading-relaxed text-ink-muted">{block.intro}</p>
      )}
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (disabled || !submit) return;
          setError(null);
          start(async () => {
            const res = await submit(block.id, values);
            if (res.ok) setDone(res.message);
            else setError(res.error);
          });
        }}
      >
        {block.fields.map((f) => (
          // biome-ignore lint/a11y/noLabelWithoutControl: el control está dentro, en una rama del ternario.
          <label key={f.key} className={clsx('block', f.type === 'text' && 'sm:col-span-2')}>
            <span className="field-label mb-1 block">
              {f.label}
              {f.required && <span className="text-rose"> *</span>}
            </span>
            {f.type === 'select' ? (
              <select
                required={f.required}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className={INPUT}
              >
                <option value="">Elige…</option>
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                required={f.required}
                type={
                  f.type === 'date'
                    ? 'date'
                    : f.type === 'number' || f.type === 'money'
                      ? 'number'
                      : 'text'
                }
                inputMode={f.type === 'number' || f.type === 'money' ? 'decimal' : undefined}
                step="any"
                maxLength={400}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className={INPUT}
              />
            )}
          </label>
        ))}
        {error && (
          <p role="alert" className="text-xs text-rose sm:col-span-2">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3 sm:col-span-2">
          <button
            type="submit"
            disabled={disabled || pending}
            className="cortex-primary-button inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-sm font-semibold text-white transition-all duration-150 hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-45"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {block.submitLabel}
          </button>
          {target.kind === 'preview' && (
            <span className="text-micro text-ink-faint">
              Vista previa: guarda para recibir envíos.
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}
