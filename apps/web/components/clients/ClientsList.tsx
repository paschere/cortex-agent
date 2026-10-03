'use client';

import DataGrid from '@/components/datagrid/DataGrid';
import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import type { ActionResult } from '@/lib/clients/types';
import { CHIP_INTERACTIVE, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { Link2, LoaderCircle, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState, useTransition } from 'react';

/**
 * LA LISTA DE CLIENTES: la grilla compartida (components/datagrid) con las
 * columnas de plata y contacto, las preguntas de todos los días como botones
 * («Con cartera vencida», «Sin contacto en 30 días») y las vistas propias del
 * equipo guardadas con scope `clients`.
 *
 * Todo llega armado del servidor (lib/clients/grid.ts): este componente no
 * sabe sumar ni de dónde salió una cifra. Las acciones llegan como funciones
 * para que el escaparate de desarrollo pueda pintar la misma pantalla sin
 * sesión.
 */

export interface ClientsListHandlers {
  onEdit?: (rowId: string, key: string, value: unknown) => Promise<void>;
  onBulkEdit?: (rowIds: string[], key: string, value: unknown) => Promise<void>;
  onCreate?: (values: Record<string, unknown>) => Promise<GridRow>;
  onSaveView?: (view: GridView) => Promise<GridView>;
  onDeleteView?: (id: string) => Promise<void>;
  onRunLinking?: () => Promise<ActionResult>;
}

export interface ClientsListProps extends ClientsListHandlers {
  columns: GridColumn[];
  rows: GridRow[];
  presets: Array<{ id: string; label: string; view: Partial<GridView> }>;
  savedViews: GridView[];
  /** Qué no se pudo leer («facturas del programa contable»…). */
  missing: string[];
  /** Cuántas cosas esperan en «Por confirmar». */
  pending: number;
  /** El botón de registrar con el formulario completo (NIT, dominios…). */
  createSlot?: ReactNode;
  askCortexContext: string;
  /** Href de la pestaña «Por confirmar». */
  reviewHref: string;
}

export function ClientsList(props: ClientsListProps) {
  const [preset, setPreset] = useState(props.presets[0]?.id ?? 'todos');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [running, startRun] = useTransition();
  const current = props.presets.find((p) => p.id === preset) ?? props.presets[0];

  function runLinking() {
    if (!props.onRunLinking) return;
    setNote(null);
    startRun(async () => {
      const result = await props.onRunLinking?.();
      if (result)
        setNote({
          ok: result.ok,
          text: result.ok ? (result.note ?? 'Listo.') : (result.error ?? 'No se pudo.'),
        });
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
              <Link2 className="h-3.5 w-3.5" aria-hidden />
              {props.pending} por confirmar
            </Link>
          )}
          {props.onRunLinking && (
            <button
              type="button"
              onClick={runLinking}
              disabled={running}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3.5 text-xs font-bold text-ink transition-colors duration-150 hover:bg-surface-2 disabled:opacity-50 motion-reduce:transition-none"
            >
              {running ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
              Buscar vínculos ahora
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
          {note.text}
        </p>
      )}

      {props.missing.length > 0 && (
        <p className="rounded-sm bg-amber-soft px-3 py-2 text-xs leading-snug text-amber">
          Sin dato por ahora: no pude leer {props.missing.join(', ')}. Esas columnas salen vacías,
          no en cero.
        </p>
      )}

      <DataGrid
        // Cambiar de vista rápida vuelve a montar la grilla con su vista.
        key={preset}
        columns={props.columns}
        rows={props.rows}
        initialView={current?.view}
        savedViews={props.savedViews}
        onSaveView={props.onSaveView}
        onDeleteView={props.onDeleteView}
        onEdit={props.onEdit}
        onBulkEdit={props.onBulkEdit}
        onCreate={props.onCreate}
        exportName="clientes"
        noun={{ one: 'cliente', many: 'clientes' }}
        askCortexContext={props.askCortexContext}
        emptyState={{
          title: 'Todavía no hay clientes',
          body: 'Regístralos a mano o conecta el programa contable: Cortex crea los que falten con su NIT y les cuelga facturas, pagos, correos y reuniones.',
          action: {
            label: 'Conectar el programa contable',
            href: '/integrations#programas-contables',
          },
        }}
      />
    </div>
  );
}
