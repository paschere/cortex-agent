'use client';

import { STATE_TONE } from '@/app/(app)/commitments/_components/CommitmentCard';
import { cop, shortDate, stamp, whenPhrase } from '@/app/(app)/commitments/_components/format';
import { Provenance } from '@/components/ui/provenance';
import { KIND_LABEL } from '@/lib/commitments-shape';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { CalendarClock, Car } from 'lucide-react';
import Link from 'next/link';
import { NextMove } from '../NextMove';
import { PinSurface } from '../PinSurface';
import type { ResultViewProps } from './registry';

/**
 * «¿QUÉ SE NOS VENCE?» — CON LA FUENTE DE CADA FECHA PEGADA A LA FECHA.
 *
 * ===========================================================================
 * EL SELLO NO ES ADORNO AQUÍ. ES LA VISTA
 * ===========================================================================
 * Cada renglón afirma una fecha que la persona no puso delante de sí misma. Una
 * fecha sin atribución en una ventana de chat es indistinguible de una
 * inventada, incluso para quien la lee — y la afirmación entera de este producto
 * es que esa diferencia se VE. Así que cada fila lleva su `Provenance`: el RUNT
 * y cuándo se leyó, el documento del que salió, o la persona que la escribió. Es
 * el mismo criterio que `CommitmentCard` defiende en la pantalla, y por eso el
 * mapa de colores se importa de allí en vez de copiarse.
 *
 * ===========================================================================
 * SOLO LO CONFIRMADO, Y EL ORDEN LO TRAE LA HERRAMIENTA
 * ===========================================================================
 * `commitments.due_soon` sólo devuelve compromisos que una persona confirmó; lo
 * extraído de un documento y no revisado está en `commitments.pending_review` y
 * en ningún otro sitio. Y llega ya ordenado peor-primero, así que esta vista no
 * reordena nada: hacerlo sería una segunda opinión sobre qué aprieta más, y la
 * primera se calculó contra el día de hoy en Bogotá.
 *
 * ===========================================================================
 * CUÁNTAS SE VEN
 * ===========================================================================
 * Ocho. Una lista de cincuenta vencimientos dentro de una conversación no es una
 * respuesta, es un volcado; lo que no cabe se cuenta y se pliega, nunca se
 * pierde en silencio.
 */

const OPEN = 8;

interface Source {
  label: string;
  readAt: string | null;
  quote: string | null;
  confirmed: boolean;
}

interface Row {
  id: string;
  title: string;
  kind: string;
  kindLabel: string;
  counterparty: string | null;
  amountCop: number | null;
  dueOn: string;
  daysLeft: number;
  state: keyof typeof STATE_TONE;
  stateLabel: string;
  owner: string | null;
  vehiclePlate: string | null;
  source: Source;
}

export function CommitmentsDue({ result, toolCallId }: ResultViewProps) {
  const view = dueOf(result);
  if (!view) return null;

  if (view.commitments.length === 0) {
    return (
      <div className="flex items-start gap-2 rounded-card border border-border bg-surface px-4 py-3 text-sm leading-relaxed text-ink-muted shadow-card">
        <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-emerald" aria-hidden />
        {view.guidance}
      </div>
    );
  }

  const shown = view.commitments.slice(0, OPEN);
  const rest = view.commitments.length - shown.length;

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <CalendarClock className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="field-label">Vencimientos</span>
        {view.overdue > 0 && <span className={chipClass('rose')}>{view.overdue} vencido</span>}
        {view.dueSoon > 0 && <span className={chipClass('amber')}>{view.dueSoon} por vencer</span>}
        <span className="ml-auto flex items-center gap-2">
          <span className="text-micro text-ink-faint">al {shortDate(view.today)}</span>
          <PinSurface surface="commitments" hidden={toolCallId.startsWith('panel:')} />
        </span>
      </div>

      <ul className="divide-y divide-border">
        {shown.map((c) => (
          <CommitmentRow key={c.id} commitment={c} />
        ))}
      </ul>

      {rest > 0 && (
        <p className="border-t border-border bg-surface-2 px-4 py-2 text-micro text-ink-faint">
          {rest === 1 ? 'Hay uno más' : `Hay ${rest} más`} dentro de la ventana, con más holgura.
        </p>
      )}
    </div>
  );
}

function CommitmentRow({ commitment: c }: { commitment: Row }) {
  const overdue = c.state === 'overdue';
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={chipClass(STATE_TONE[c.state] ?? 'neutral')}>{c.stateLabel}</span>
            <span className="text-micro font-semibold uppercase tracking-field text-ink-faint">
              {c.kindLabel || KIND_LABEL[c.kind as keyof typeof KIND_LABEL] || 'Otro'}
            </span>
          </div>
          <p className="mt-1 truncate text-sm font-semibold text-ink">
            <Link
              href={`/commitments/${c.id}`}
              className="rounded-sm transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
            >
              {c.title}
            </Link>
          </p>
          {(c.state === 'overdue' || c.state === 'due_soon') && (
            <div className="mt-1">
              <NextMove
                text={`Déjame redactado un mensaje para ${c.counterparty || c.title} por ${c.title}.`}
                label={c.counterparty ? `¿Le escribo a ${c.counterparty}?` : '¿Le escribo?'}
              />
            </div>
          )}
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
            {c.vehiclePlate && (
              <span className="inline-flex items-center gap-1">
                <Car className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
                <span className="tabular">{c.vehiclePlate}</span>
              </span>
            )}
            {c.counterparty && <span className="truncate">{c.counterparty}</span>}
            {c.amountCop != null && <span className="tabular">{cop(c.amountCop)}</span>}
            {/* Un compromiso sin dueño no persigue a nadie, y eso se dice. */}
            <span className={c.owner ? undefined : 'text-amber'}>
              {c.owner ? `responde ${c.owner}` : 'sin responsable'}
            </span>
          </p>
        </div>

        <div className="shrink-0 text-right">
          <div
            className={clsx(
              'tabular text-sm font-semibold leading-none',
              overdue ? 'text-rose' : c.state === 'due_soon' ? 'text-amber' : 'text-ink',
            )}
          >
            {shortDate(c.dueOn)}
          </div>
          <div
            className={clsx(
              'mt-1 text-micro',
              overdue ? 'font-semibold text-rose' : 'text-ink-faint',
            )}
          >
            {whenPhrase(c.daysLeft)}
          </div>
        </div>
      </div>

      <div className="mt-1.5">
        <Provenance
          source={c.source.label}
          readAt={stamp(c.source.readAt) ?? undefined}
          detail={c.source.quote ? 'cita en el detalle' : undefined}
          tone={overdue ? 'seal' : 'stamp'}
        />
      </div>
    </li>
  );
}

/**
 * Lo que llega cruzó un stream y, en una conversación reabierta, una fila de la
 * base. UNA FILA SIN FUENTE NO SE DIBUJA: enseñar aquí una fecha sin decir de
 * dónde salió es exactamente lo que este módulo existe para no hacer.
 */
function dueOf(result: unknown): {
  today: string;
  commitments: Row[];
  overdue: number;
  dueSoon: number;
  guidance: string;
} | null {
  if (!result || typeof result !== 'object' || '__error' in result) return null;
  const r = result as Record<string, unknown>;
  if (typeof r.today !== 'string' || !Array.isArray(r.commitments)) return null;

  const commitments = r.commitments.filter((row): row is Row => {
    if (!row || typeof row !== 'object') return false;
    const c = row as Row;
    return (
      typeof c.id === 'string' &&
      typeof c.title === 'string' &&
      typeof c.dueOn === 'string' &&
      typeof c.daysLeft === 'number' &&
      !!c.source &&
      typeof c.source === 'object' &&
      typeof c.source.label === 'string'
    );
  });

  return {
    today: r.today,
    commitments,
    overdue: typeof r.overdue === 'number' ? r.overdue : 0,
    dueSoon: typeof r.dueSoon === 'number' ? r.dueSoon : 0,
    guidance:
      typeof r.guidance === 'string' && r.guidance.trim()
        ? r.guidance
        : 'No hay nada vencido ni por vencer en esa ventana.',
  };
}
