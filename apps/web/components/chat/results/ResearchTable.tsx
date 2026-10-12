'use client';

import type { GridColumn } from '@/lib/result-grid';
import { clsx } from 'clsx';
import { Layers } from 'lucide-react';
import { ResultGrid } from './ResultGrid';
import type { ResultViewProps } from './registry';

/**
 * LA TABLA DE `research.parallel`: una fila por elemento investigado.
 *
 * Las columnas las declaró quien pidió la investigación (los `fields`), así que
 * llegan en el propio resultado y no en una especificación fija: por eso esta
 * vista es propia y no una entrada de `TABLE`. Pinta con la MISMA rejilla que
 * las demás tablas (`ResultGrid`: ordenar, totales de dinero, pie con el
 * conteo). Lo que añade es lo que sólo esta herramienta sabe decir: cuántos
 * salieron completos, cuántos faltan por tiempo y cuánto costó en tokens.
 *
 * Mientras corre, el avance («Investigando: 12 de 30 listos…») lo pinta el
 * renglón de la herramienta (`tool-progress`); esta tarjeta aparece al final.
 */

interface Counts {
  requested?: number;
  processed?: number;
  complete?: number;
  partial?: number;
  noData?: number;
  error?: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function ResearchTable({ result }: ResultViewProps) {
  const r = isObj(result) ? result : {};
  const columns = (Array.isArray(r.columns) ? r.columns : []).filter(
    isObj,
  ) as unknown as GridColumn[];
  const rows = (Array.isArray(r.rows) ? r.rows : []).filter(isObj) as Record<string, unknown>[];
  const counts = (isObj(r.counts) ? r.counts : {}) as Counts;
  const usage = isObj(r.usage) ? r.usage : {};
  const remaining = num(r.remaining);
  const summary = typeof r.summary === 'string' ? r.summary : '';

  const chips: Array<{ text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }> = [
    { text: `${num(counts.complete)} completos`, tone: 'ok' },
  ];
  if (num(counts.partial)) chips.push({ text: `${num(counts.partial)} parciales`, tone: 'warn' });
  if (num(counts.noData)) chips.push({ text: `${num(counts.noData)} sin dato`, tone: 'muted' });
  if (num(counts.error)) chips.push({ text: `${num(counts.error)} con error`, tone: 'bad' });
  if (remaining) chips.push({ text: `faltan ${remaining}`, tone: 'warn' });

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Layers size={14} className="text-ink-muted" aria-hidden />
        <p className="text-xs font-medium text-ink">
          {typeof r.goal === 'string' && r.goal ? r.goal : 'Investigación en paralelo'}
        </p>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span
              key={c.text}
              className={clsx(
                'rounded-full px-2 py-0.5 text-[11px]',
                c.tone === 'ok' && 'bg-emerald-50 text-emerald-700',
                c.tone === 'warn' && 'bg-amber-50 text-amber-700',
                c.tone === 'bad' && 'bg-rose-50 text-rose-700',
                c.tone === 'muted' && 'bg-surface-2 text-ink-muted',
              )}
            >
              {c.text}
            </span>
          ))}
        </div>
      </div>
      {rows.length === 0 || columns.length === 0 ? (
        <p className="px-4 py-3 text-xs text-ink-muted">No se investigó ningún elemento.</p>
      ) : (
        <ResultGrid
          columns={columns}
          rows={rows}
          density="card"
          label="Investigación en paralelo"
        />
      )}
      <p className="border-t border-border px-4 py-2 text-[11px] leading-relaxed text-ink-muted">
        {summary}
        {num(usage.totalTokens) > 0 &&
          ` · ${num(usage.subRuns)} sub-ejecuciones, ${num(usage.totalTokens).toLocaleString('es-CO')} tokens`}
      </p>
    </div>
  );
}
