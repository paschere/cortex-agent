'use client';

import DataGrid from '@/components/datagrid/DataGrid';
import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { Plus } from 'lucide-react';
import Link from 'next/link';

/**
 * LAS LISTAS DE /ventas: cotizaciones, pedidos y facturas en la grilla
 * compartida, una pestaña por clase. Todo llega armado del servidor
 * (lib/sales/view.ts); este componente no sabe sumar ni de dónde sale una
 * cifra. Las vistas guardadas usan el alcance `sales`.
 */

export interface SalesTab {
  id: string;
  label: string;
  href: string;
  count: number;
}

export function SalesList(props: {
  tabs: SalesTab[];
  active: string;
  kindNoun: { one: string; many: string; gender: 'm' | 'f' };
  columns: GridColumn[];
  rows: GridRow[];
  savedViews: GridView[];
  onSaveView?: (view: GridView) => Promise<GridView>;
  onDeleteView?: (id: string) => Promise<void>;
  newHref: string | null;
  summary: Array<{
    label: string;
    value: string;
    tone?: 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';
  }>;
  emptyBody: string;
  urlParam?: string | false;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border">
        <nav className="flex gap-1" aria-label="Clases de documento">
          {props.tabs.map((t) => (
            <Link
              key={t.id}
              href={t.href}
              aria-current={props.active === t.id ? 'page' : undefined}
              className={clsx(
                '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold transition-colors duration-150 motion-reduce:transition-none',
                props.active === t.id
                  ? 'border-primary text-ink'
                  : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              {t.label}
              {t.count > 0 && <span className={chipClass('neutral')}>{t.count}</span>}
            </Link>
          ))}
        </nav>
        {props.newHref && (
          <Link
            href={props.newHref}
            className="cortex-primary-button mb-2 inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-sm font-bold text-white hover:bg-primary-strong"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Nueva cotización
          </Link>
        )}
      </div>

      {props.summary.length > 0 && (
        <dl className="grid gap-3 sm:grid-cols-3">
          {props.summary.map((s) => (
            <div
              key={s.label}
              className="rounded-card border border-border bg-surface px-4 py-3 shadow-card"
            >
              <dt className="text-xs text-ink-muted">{s.label}</dt>
              <dd
                className={clsx(
                  'mt-0.5 text-lg font-extrabold tabular-nums',
                  s.tone === 'emerald'
                    ? 'text-emerald'
                    : s.tone === 'amber'
                      ? 'text-amber'
                      : s.tone === 'primary'
                        ? 'text-primary'
                        : 'text-ink',
                )}
              >
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <DataGrid
        columns={props.columns}
        rows={props.rows}
        savedViews={props.savedViews}
        onSaveView={props.onSaveView}
        onDeleteView={props.onDeleteView}
        initialView={{ sort: [{ key: 'fecha', dir: 'desc' }] }}
        noun={props.kindNoun}
        exportName={`ventas-${props.active}`}
        askCortexContext={`Mis ${props.kindNoun.many} en Ventas`}
        emptyState={{
          title: `Todavía no hay ${props.kindNoun.many}`,
          body: props.emptyBody,
          action: props.newHref ? { label: 'Nueva cotización', href: props.newHref } : undefined,
        }}
        height="calc(100vh - 340px)"
        urlParam={props.urlParam}
      />
    </div>
  );
}
