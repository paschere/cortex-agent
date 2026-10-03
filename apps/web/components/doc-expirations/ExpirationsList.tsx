'use client';

import DataGrid from '@/components/datagrid/DataGrid';
import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import { CHIP_INTERACTIVE, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  CalendarClock,
  ExternalLink,
  FileText,
  LoaderCircle,
  Quote,
  ScanSearch,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState, useTransition } from 'react';
import { RenewalUpload } from './RenewalUpload';
import type { ActionResult, ExpirationDetail, ExpirationHandlers } from './types';

/**
 * LA LISTA: la grilla compartida con las preguntas de todos los días como
 * botones («Vencidos y por vencer», «Vence este mes», «Vehículos») y, al abrir
 * una fila, la evidencia y el botón para subir la renovación.
 *
 * Todo llega armado del servidor (lib/doc-expirations/grid.ts); las acciones
 * llegan como funciones para que el escaparate pinte la misma pantalla.
 */

export interface ExpirationsListProps {
  columns: GridColumn[];
  rows: GridRow[];
  details: Record<string, ExpirationDetail>;
  presets: Array<{ id: string; label: string; view: Partial<GridView> }>;
  /** Filtro por sujeto que llega en la URL (`?sujeto=WGY482`). */
  initialSearch?: string;
  pending: number;
  reviewHref: string;
  handlers: ExpirationHandlers;
  createSlot?: ReactNode;
}

export function ExpirationsList(props: ExpirationsListProps) {
  const router = useRouter();
  const [preset, setPreset] = useState(props.presets[0]?.id ?? 'todos');
  const [note, setNote] = useState<ActionResult | null>(null);
  const [running, start] = useTransition();
  const current = props.presets.find((p) => p.id === preset) ?? props.presets[0];
  const view: Partial<GridView> = {
    ...current?.view,
    ...(props.initialSearch ? { search: props.initialSearch } : {}),
  };

  function backfill() {
    const run = props.handlers.backfill;
    if (!run) return;
    setNote(null);
    start(async () => {
      const r = await run();
      setNote(r);
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
          <legend className="sr-only">Vistas rápidas</legend>
          {props.presets.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={p.id === preset}
              onClick={() => setPreset(p.id)}
              className={clsx(
                chipClass(p.id === preset ? 'primary' : 'neutral'),
                CHIP_INTERACTIVE,
                'min-h-8 px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              )}
            >
              {p.label}
            </button>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          {props.pending > 0 && (
            <Link
              href={props.reviewHref}
              className={clsx(chipClass('amber'), CHIP_INTERACTIVE, 'min-h-8 px-3 text-xs')}
            >
              <CalendarClock className="h-3.5 w-3.5" aria-hidden />
              {props.pending} por revisar
            </Link>
          )}
          {props.handlers.backfill && (
            <button
              type="button"
              onClick={backfill}
              disabled={running}
              title="Lee por tandas los documentos que ya estaban en el Cerebro"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3.5 text-xs font-bold text-ink transition-colors duration-150 hover:bg-surface-2 disabled:opacity-50 motion-reduce:transition-none"
            >
              {running ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <ScanSearch className="h-3.5 w-3.5" aria-hidden />
              )}
              Buscar en lo que ya hay
            </button>
          )}
          {props.createSlot}
        </div>
      </div>

      {note && (
        <p
          aria-live="polite"
          className={clsx(
            'rounded-sm px-3 py-2 text-xs leading-snug',
            note.ok ? 'bg-emerald-soft text-emerald' : 'bg-rose-soft text-rose',
          )}
        >
          {note.ok ? note.note : note.error}
        </p>
      )}

      <DataGrid
        key={`${preset}:${props.initialSearch ?? ''}`}
        columns={props.columns}
        rows={props.rows}
        initialView={view}
        onEdit={props.handlers.edit}
        exportName="documentos-que-vencen"
        noun={{ one: 'documento', many: 'documentos' }}
        askCortexContext="los documentos que vencen de la empresa (SOAT, pólizas, licencias, permisos, contratos)"
        urlParam={false}
        emptyState={{
          title: 'Ningún documento vigilado todavía',
          body: 'Sube al Cerebro un SOAT, una póliza o una licencia (o conecta la carpeta de Drive donde están) y Cortex les lee la fecha. También puedes registrarlos a mano.',
          action: { label: 'Ir al Cerebro', href: '/kb' },
        }}
        renderRowExtra={(row) => {
          const d = props.details[row.id];
          return d ? <RowExtra detail={d} handlers={props.handlers} /> : null;
        }}
      />
    </div>
  );
}

function RowExtra({
  detail,
  handlers,
}: { detail: ExpirationDetail; handlers: ExpirationHandlers }) {
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div>
        <p className="text-xs font-bold text-ink-muted">De dónde salió la fecha</p>
        {detail.source === 'manual' ? (
          <p className="mt-1 text-sm text-ink">Registrado a mano.</p>
        ) : detail.evidenceHidden ? (
          <p className="mt-1 text-sm text-ink-muted">Está en un espacio del Cerebro que no ves.</p>
        ) : (
          <figure className="mt-1 rounded-sm border-l-2 border-primary/50 bg-surface-2 px-3 py-2">
            <Quote className="mb-1 h-3.5 w-3.5 text-ink-faint" aria-hidden />
            <blockquote className="text-sm leading-snug text-ink">
              {detail.evidence ? `«${detail.evidence}»` : 'Sin frase con la fecha.'}
            </blockquote>
          </figure>
        )}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {detail.documentHref && (
          <li>
            <Link
              href={detail.documentHref}
              className="inline-flex items-center gap-1 text-ink-muted hover:text-primary"
            >
              <FileText className="h-3 w-3" aria-hidden />
              {detail.documentTitle ?? 'El documento'}
            </Link>
          </li>
        )}
        {detail.clientHref && (
          <li>
            <Link
              href={detail.clientHref}
              className="inline-flex items-center gap-1 text-ink-muted hover:text-primary"
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
              {detail.clientName ?? 'El cliente'}
            </Link>
          </li>
        )}
        {detail.commitmentHref && (
          <li>
            <Link
              href={detail.commitmentHref}
              className="inline-flex items-center gap-1 text-ink-muted hover:text-primary"
            >
              <CalendarClock className="h-3 w-3" aria-hidden />
              El aviso en Vencimientos
            </Link>
          </li>
        )}
      </ul>
      {detail.status !== 'renovado' && (
        <RenewalUpload
          expirationId={detail.id}
          spaceId={detail.spaceId}
          onLink={handlers.linkRenewal}
        />
      )}
    </div>
  );
}
