'use client';

/**
 * «Plan y uso»: lo de administración de Cortex, plegado.
 *
 * Plan, asientos, cupo de respuestas e integraciones siguen aquí porque un
 * fundador los necesita de vez en cuando — al contratar a alguien, al ver que
 * el cupo se acaba. No son lo que mira cada mañana, así que no compiten con
 * la plata en riesgo: van cerrados, con un renglón que dice si algo de esto
 * pide atención. Lo que sí no puede esperar (un cobro del plan pendiente, el
 * cupo agotado) sube solo a «Dónde actuar hoy».
 */

import {
  type ConsoleRow,
  answersPercent,
  founderTotals,
  seatsLabel,
} from '@/lib/founder-console-shape';
import { relativeTime } from '@/lib/relative-time';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { ArrowRight, ChevronDown, CreditCard } from 'lucide-react';
import Link from 'next/link';

function Meter({ row }: { row: ConsoleRow }) {
  const answers = row.health?.answers ?? null;
  const pct = answersPercent(answers);
  if (!answers) return <span className="text-ink-faint">—</span>;
  const bar =
    answers.state === 'blocked'
      ? 'bg-rose'
      : answers.state === 'grace' || answers.state === 'warning'
        ? 'bg-amber'
        : 'bg-primary';
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="tabular text-ink">{answers.used.toLocaleString('es-CO')}</span>
        <span className="tabular text-micro text-ink-faint">
          {answers.limit === null ? 'sin límite' : `de ${answers.limit.toLocaleString('es-CO')}`}
        </span>
      </div>
      {pct !== null && (
        <div
          className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={`Respuestas usadas: ${pct}%`}
        >
          <div
            className={clsx('h-full rounded-full', bar)}
            style={{ width: `${Math.max(pct, 3)}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function PlanAndUse({
  rows,
  ownedCount,
  ownedLimit,
}: {
  rows: ConsoleRow[];
  ownedCount: number;
  ownedLimit: number;
}) {
  const owned = rows.filter((row) => row.owned);
  if (owned.length === 0) return null;
  const admin = founderTotals(rows);
  const flagged = owned.filter(
    (row) => row.health?.health.tone === 'rose' || row.health?.health.tone === 'amber',
  ).length;

  return (
    <details className="group rounded-card border border-border bg-surface shadow-card">
      <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 text-sm font-bold text-ink">
          <CreditCard className="h-4 w-4 text-ink-faint" aria-hidden />
          Plan y uso
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap gap-x-3 text-xs text-ink-muted">
          <span>
            {ownedCount} de {ownedLimit} empresas
          </span>
          <span aria-hidden className="text-ink-faint">
            ·
          </span>
          <span>
            {admin.members} {admin.members === 1 ? 'persona' : 'personas'}
          </span>
          {admin.pendingInvitations > 0 && (
            <>
              <span aria-hidden className="text-ink-faint">
                ·
              </span>
              <span>{admin.pendingInvitations} por aceptar</span>
            </>
          )}
        </span>
        {flagged > 0 ? (
          <span className={chipClass('amber')}>
            {flagged} {flagged === 1 ? 'empresa' : 'empresas'} con algo del plan
          </span>
        ) : (
          <span className={chipClass('neutral')}>En orden</span>
        )}
        <ChevronDown
          className="h-4 w-4 text-ink-faint transition-transform group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden
        />
      </summary>

      <div className="border-t border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-xs">
            <thead className="text-left">
              <tr className="border-b border-border">
                <th className="field-label px-4 py-2">Empresa</th>
                <th className="field-label px-3 py-2">Plan</th>
                <th className="field-label px-3 py-2">Asientos</th>
                <th className="field-label w-44 px-3 py-2">Respuestas este mes</th>
                <th className="field-label px-3 py-2 text-right">Integraciones</th>
                <th className="field-label px-3 py-2">Última actividad</th>
                <th className="field-label px-3 py-2">Aviso</th>
              </tr>
            </thead>
            <tbody>
              {owned.map((row) => {
                const health = row.health;
                const tone = health?.health.tone ?? 'neutral';
                return (
                  <tr key={row.id} className="border-t border-border first:border-t-0">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/overview/companies/${encodeURIComponent(row.id)}`}
                        className="font-semibold text-ink hover:text-primary"
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-ink-muted">{health?.planName ?? '—'}</td>
                    <td className="tabular whitespace-nowrap px-3 py-2.5 text-ink">
                      {seatsLabel(health?.seats ?? null)}
                      {(health?.pendingInvitations ?? 0) > 0 && (
                        <span className="block text-micro text-ink-faint">
                          +{health?.pendingInvitations} por aceptar
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <Meter row={row} />
                    </td>
                    <td className="tabular px-3 py-2.5 text-right text-ink">
                      {health?.integrations ?? '—'}
                    </td>
                    <td className="tabular whitespace-nowrap px-3 py-2.5 text-ink-muted">
                      {health?.lastActivityAt ? (
                        <span suppressHydrationWarning>{relativeTime(health.lastActivityAt)}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {health ? (
                        <span className={chipClass(tone === 'neutral' ? 'neutral' : tone)}>
                          {health.health.label}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-micro text-ink-faint">
          <span>
            {ownedCount >= ownedLimit
              ? 'Llegaste al tope de empresas por cuenta.'
              : `Puedes crear ${ownedLimit - ownedCount} ${ownedLimit - ownedCount === 1 ? 'empresa más' : 'empresas más'}.`}
          </span>
          <Link
            href="/overview/people"
            className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
          >
            Personas de todas tus empresas <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        </div>
      </div>
    </details>
  );
}
