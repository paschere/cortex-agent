'use client';

import {
  type ActivityRow,
  type SourceRow,
  buildActivityRows,
  buildSourceRows,
} from '@/lib/chat-turn';
import { riskOfTool } from '@/lib/risk';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { formatDuration } from '@/lib/tool-args';
import {
  AlertCircle,
  Brain,
  Check,
  ExternalLink,
  Globe,
  Loader2,
  Plug,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import type { TurnInsight } from './ChatArtifacts';

/**
 * «FUENTES» Y «ACTIVIDAD»: LAS DOS PESTAÑAS DEL PANEL QUE DICEN QUÉ HIZO EL TURNO.
 *
 * Las dos salen de lo que la pantalla ya sabe —las invocaciones del último
 * turno, las fuentes del cerebro y las filas de auditoría que llegan con las
 * cifras—, ordenado por funciones puras (lib/chat-turn.ts). Sin turno todavía,
 * dicen que no hay nada, no inventan.
 */

export function useTurnRows(turn: TurnInsight | null) {
  return useMemo(() => {
    const invocations = turn?.invocations ?? [];
    return {
      sources: buildSourceRows(invocations, turn?.brain ?? []),
      activity: buildActivityRows(invocations, turn?.metrics?.calls),
    };
  }, [turn]);
}

const Empty = ({ children }: { children: string }) => (
  <p className="rounded-card border border-dashed border-border px-4 py-6 text-sm text-ink-muted">
    {children}
  </p>
);

function hour(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Bogota',
  }).format(d);
}

export function SourcesTab({ rows }: { rows: SourceRow[] }) {
  if (rows.length === 0)
    return <Empty>Este turno no leyó documentos ni sistemas conectados.</Empty>;
  return (
    <ul className="flex flex-col divide-y divide-border">
      {rows.map((s) => {
        const body = (
          <>
            <span
              aria-hidden
              className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-sm bg-surface-2 text-ink-muted"
            >
              {s.kind === 'brain' ? (
                <Brain className="h-3.5 w-3.5" />
              ) : (
                <Plug className="h-3.5 w-3.5" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink">{s.title}</span>
              <span className="mt-0.5 block text-xs leading-snug text-ink-faint [overflow-wrap:anywhere]">
                {s.detail}
                {s.weak ? ' · coincidencia floja' : ''}
              </span>
            </span>
            {s.href && (
              <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
            )}
          </>
        );
        return (
          <li key={s.id}>
            {s.href ? (
              s.external ? (
                <a
                  href={s.href}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-start gap-3 py-3 hover:bg-surface-2/60"
                >
                  {body}
                </a>
              ) : (
                <Link href={s.href} className="flex items-start gap-3 py-3 hover:bg-surface-2/60">
                  {body}
                </Link>
              )
            ) : (
              <div className="flex items-start gap-3 py-3">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const STATUS: Record<ActivityRow['status'], { label: string; tone: StatusTone }> = {
  ok: { label: 'Listo', tone: 'emerald' },
  error: { label: 'Falló', tone: 'rose' },
  waiting: { label: 'Espera tu OK', tone: 'amber' },
  running: { label: 'En curso', tone: 'primary' },
};

export function ActivityTab({
  rows,
  toolIds,
  browserIds,
  onOpenStep,
}: {
  rows: ActivityRow[];
  toolIds: string[];
  /** Los pasos que tienen su momento en la pestaña «Navegador». */
  browserIds?: ReadonlySet<string>;
  onOpenStep?: (id: string) => void;
}) {
  if (rows.length === 0) return <Empty>Este turno no ejecutó herramientas.</Empty>;
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col divide-y divide-border">
        {rows.map((r, i) => {
          const st = STATUS[r.status];
          const risk = riskOfTool(toolIds[i]);
          const at = hour(r.approval?.at ?? null);
          return (
            <li key={r.id} className="flex items-start gap-3 py-3">
              <span aria-hidden className="mt-0.5 shrink-0 text-ink-faint">
                {r.status === 'ok' ? (
                  <Check className="h-4 w-4 text-emerald" />
                ) : r.status === 'error' ? (
                  <AlertCircle className="h-4 w-4 text-rose" />
                ) : r.status === 'running' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4 text-amber" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">{r.name}</p>
                {r.summary && (
                  <p className="mt-0.5 text-xs leading-snug text-ink-faint [overflow-wrap:anywhere]">
                    {r.summary}
                  </p>
                )}
                {onOpenStep && browserIds?.has(r.id) && (
                  <button
                    type="button"
                    onClick={() => onOpenStep(r.id)}
                    className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-primary-ink hover:underline"
                  >
                    <Globe className="h-3 w-3" aria-hidden />
                    Ver en el navegador
                  </button>
                )}
                {r.approval && (
                  <p className="mt-1 text-xs text-ink-muted">
                    {r.approval.kind === 'person'
                      ? `Aprobado por ti${at ? ` a las ${at}` : ''}`
                      : `Hecho solo, con un permiso tuyo${at ? ` a las ${at}` : ''}`}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className={chipClass(st.tone)}>{st.label}</span>
                {risk.level !== 'bajo' && r.status !== 'running' && (
                  <span className="text-micro text-ink-faint">{risk.label}</span>
                )}
                {formatDuration(r.ms) && (
                  <span className="tabular font-mono text-micro text-ink-faint">
                    {formatDuration(r.ms)}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <Link
        href="/actividad"
        className="self-start text-[0.8125rem] font-semibold text-primary-ink hover:underline"
      >
        Ver todo en Actividad
      </Link>
    </div>
  );
}
