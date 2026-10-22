'use client';

import { Panel } from '@/components/ui/panel';
import { chipClass } from '@/lib/status-chip';
import clsx from 'clsx';
import { Loader2, Table2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import type {
  SourcePreviewData,
  SourcePreviewResult,
  SourceSaveResult,
} from '../accounting-sources-actions';

/**
 * FUENTES CONTABLES (0239): declarar una tabla (casi siempre una hoja conectada)
 * como fuente de ventas, compras, pagos, movimientos o presupuesto. Elegir la
 * tabla y el tipo trae el mapeo propuesto con desplegables por campo y una
 * vista previa de 5 filas ya normalizadas; nada se guarda hasta «Guardar».
 *
 * Cliente, sin importar el barril de agent-tools: todo lo que necesita llega
 * por props simples o por las acciones del servidor.
 */

export interface SourceListItem {
  id: string;
  origin: string;
  kindLabel: string;
  tableName: string;
  precedence: 'program' | 'sheet';
  enabled: boolean;
}

export interface TableOption {
  slug: string;
  name: string;
}

export interface KindOption {
  kind: string;
  label: string;
}

export interface AccountingSourcesActions {
  preview: (input: {
    table: string;
    kind: string;
    mapping?: Record<string, string>;
    currency?: string;
  }) => Promise<SourcePreviewResult>;
  save: (input: {
    table: string;
    kind: string;
    mapping: Record<string, string>;
    label?: string;
    precedence: 'program' | 'sheet';
    currency: string;
    sumRepeated: boolean;
  }) => Promise<SourceSaveResult>;
  remove: (input: { id: string }) => Promise<SourceSaveResult>;
}

const SELECT =
  'min-h-11 w-full rounded-pill border border-border bg-surface px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20';

export function AccountingSourcesPanel({
  sources,
  tables,
  kinds,
  actions,
}: {
  sources: SourceListItem[];
  tables: TableOption[];
  kinds: KindOption[];
  actions: AccountingSourcesActions;
}) {
  const [table, setTable] = useState('');
  const [kind, setKind] = useState(kinds[0]?.kind ?? 'ventas');
  const [preview, setPreview] = useState<SourcePreviewData | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [precedence, setPrecedence] = useState<'program' | 'sheet'>('program');
  const [currency, setCurrency] = useState('COP');
  const [sumRepeated, setSumRepeated] = useState(false);
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function load(nextTable: string, nextKind: string, nextMapping?: Record<string, string>) {
    if (!nextTable) {
      setPreview(null);
      return;
    }
    setMessage(null);
    start(async () => {
      const r = await actions.preview({
        table: nextTable,
        kind: nextKind,
        mapping: nextMapping,
        currency,
      });
      if (!r.ok) {
        setPreview(null);
        setMessage({ ok: false, text: r.error });
        return;
      }
      setPreview(r);
      setMapping(r.mapping);
      if (!label) setLabel(r.table.name);
    });
  }

  function change(field: string, column: string) {
    const next = { ...mapping };
    if (column) next[field] = column;
    else delete next[field];
    setMapping(next);
    load(table, kind, next);
  }

  function save() {
    if (!preview) return;
    start(async () => {
      const r = await actions.save({
        table,
        kind,
        mapping,
        label: label.trim() || undefined,
        precedence,
        currency,
        sumRepeated,
      });
      setMessage({ ok: r.ok, text: r.ok ? r.note : r.error });
      if (r.ok) {
        setPreview(null);
        setTable('');
      }
    });
  }

  function remove(id: string) {
    start(async () => {
      const r = await actions.remove({ id });
      setMessage({ ok: r.ok, text: r.ok ? r.note : r.error });
    });
  }

  return (
    <Panel className="space-y-4 p-4 sm:p-5" id="fuentes-contables">
      <div>
        <h3 className="flex items-center gap-2 text-base font-extrabold tracking-tight text-ink">
          <Table2 className="h-4 w-4 text-ink-faint" aria-hidden />
          Fuentes contables
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-ink-muted">
          Usa una hoja (o cualquier tabla) como fuente de ventas, compras, pagos, movimientos o
          presupuesto. Alimenta las mismas cifras que tu programa contable, sin contar dos veces una
          factura que está en los dos lados. También se lo puedes pedir a Cortex en el chat.
        </p>
      </div>

      {sources.length > 0 ? (
        <ul className="divide-y divide-border rounded-sm border border-border">
          {sources.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">{s.origin}</p>
                <p className="text-xs text-ink-muted">
                  {s.kindLabel} · tabla «{s.tableName}» · manda{' '}
                  {s.precedence === 'program' ? 'el programa contable' : 'la hoja'}
                </p>
              </div>
              <span className={chipClass(s.enabled ? 'emerald' : 'neutral')}>
                {s.enabled ? 'Activa' : 'En pausa'}
              </span>
              <button
                type="button"
                onClick={() => remove(s.id)}
                disabled={pending}
                className="inline-flex min-h-10 items-center rounded-pill border border-border px-3 text-xs font-semibold text-ink-muted hover:bg-surface-2 disabled:opacity-60"
              >
                Quitar
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-sm bg-surface-2 px-3 py-2.5 text-sm text-ink-muted">
          Ninguna tabla es fuente contable todavía.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs font-semibold text-ink">
          Tabla
          <select
            className={SELECT}
            value={table}
            onChange={(e) => {
              setTable(e.target.value);
              setLabel('');
              load(e.target.value, kind);
            }}
          >
            <option value="">Elige una tabla…</option>
            {tables.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs font-semibold text-ink">
          Es fuente de
          <select
            className={SELECT}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              load(table, e.target.value);
            }}
          >
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {pending && !preview ? (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Leyendo la tabla…
        </p>
      ) : null}

      {preview ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {preview.fields.map((f) => (
              <label key={f.field} className="space-y-1 text-xs font-semibold text-ink">
                {f.label}
                {f.required ? <span className="text-rose"> *</span> : null}
                <select
                  className={clsx(SELECT, f.required && !mapping[f.field] && 'border-rose')}
                  value={mapping[f.field] ?? ''}
                  onChange={(e) => change(f.field, e.target.value)}
                  disabled={pending}
                >
                  <option value="">{f.required ? 'Elige la columna…' : 'No la tengo'}</option>
                  {preview.columns.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {preview.problems.length > 0 ? (
            <ul className="space-y-1 rounded-sm bg-rose-soft px-3 py-2 text-xs text-ink">
              {preview.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          {preview.warnings.length > 0 ? (
            <ul className="space-y-1 rounded-sm bg-amber-soft px-3 py-2 text-xs text-ink">
              {preview.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}

          <div className="space-y-2">
            <p className="text-sm text-ink">
              De {preview.stats.rows} filas leídas{preview.sampled ? ' (la muestra)' : ''},{' '}
              <strong>{preview.stats.used} entran</strong>, {preview.stats.rejected} no entran
              {preview.stats.warnings ? `, ${preview.stats.warnings} entran con aviso` : ''}.
            </p>
            {preview.issues.length > 0 ? (
              <ul className="space-y-1 text-xs text-ink-muted">
                {preview.issues.map((i) => (
                  <li key={`${i.number}-${i.message}`}>
                    <span
                      className={clsx(
                        'font-semibold',
                        i.severity === 'rechazada' ? 'text-rose' : 'text-amber',
                      )}
                    >
                      {i.severity === 'rechazada' ? 'No entra' : 'Aviso'}
                    </span>
                    {i.number ? ` · ${i.number}` : ''} · {i.message}
                  </li>
                ))}
              </ul>
            ) : null}
            {preview.grid.rows.length > 0 ? (
              <div className="overflow-x-auto rounded-sm border border-border">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead className="bg-surface-2 text-ink-muted">
                    <tr>
                      {preview.grid.head.map((h) => (
                        <th key={h} className="px-3 py-2 font-semibold">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border text-ink">
                    {preview.grid.rows.map((r, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: filas de vista previa sin id propio
                      <tr key={i}>
                        {r.map((c, j) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: celdas de vista previa
                          <td key={j} className="tabular whitespace-nowrap px-3 py-1.5">
                            {c}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1 text-xs font-semibold text-ink lg:col-span-2">
              Nombre del origen
              <input
                className={SELECT}
                value={label}
                maxLength={80}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Ventas Medellín"
              />
              <span className="block text-micro font-normal text-ink-faint">
                Se verá como «Hoja: {label || 'Ventas Medellín'}».
              </span>
            </label>
            <label className="space-y-1 text-xs font-semibold text-ink">
              Si la factura está en los dos lados, manda
              <select
                className={SELECT}
                value={precedence}
                onChange={(e) => setPrecedence(e.target.value as 'program' | 'sheet')}
              >
                <option value="program">El programa contable</option>
                <option value="sheet">Esta hoja</option>
              </select>
            </label>
            <label className="space-y-1 text-xs font-semibold text-ink">
              Moneda por defecto
              <input
                className={SELECT}
                value={currency}
                maxLength={3}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </label>
          </div>
          <label className="flex items-start gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={sumRepeated}
              onChange={(e) => setSumRepeated(e.target.checked)}
            />
            Cada fila repetida con el mismo número es una línea de la factura: sumarlas.
          </label>

          <button
            type="button"
            onClick={save}
            disabled={pending || !preview.ready || currency.length !== 3}
            className="inline-flex min-h-11 items-center gap-2 rounded-pill bg-primary px-5 text-sm font-bold text-white transition-colors hover:bg-primary-strong disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Guardar como fuente
          </button>
        </div>
      ) : null}

      {message ? (
        <output
          className={clsx(
            'block',
            'rounded-sm px-3 py-2 text-sm',
            message.ok ? 'bg-emerald-soft text-emerald' : 'bg-rose-soft text-rose',
          )}
        >
          {message.text}
        </output>
      ) : null}
    </Panel>
  );
}
