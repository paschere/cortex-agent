'use client';

import { Panel } from '@/components/ui/panel';
import { GOAL_STATUS_TONE, type GoalStatus } from '@/lib/goals-shape';
import { chipClass } from '@/lib/status-chip';
import { Target } from 'lucide-react';
import Link from 'next/link';
import type { ResultViewProps } from './registry';

/**
 * LAS METAS, CON SU NÚMERO Y SU VEREDICTO.
 *
 * ===========================================================================
 * POR QUÉ ESTO MERECE VISTA PROPIA
 * ===========================================================================
 * Una meta es exactamente tres cosas juntas —una cifra, el objetivo contra el
 * que se juzgó y si lo cumplió— y las tres se leen de un vistazo o no se leen.
 * En una fila gris con el JSON detrás de un chevron, «45,2 d» y «no pasar de
 * 45» quedan a dos líneas de distancia y nadie hace la resta.
 *
 * ===========================================================================
 * LO QUE ESTA VISTA NO HACE, Y ES LA MITAD DEL PUNTO
 * ===========================================================================
 * No juzga. No formatea. No compara la cifra con el objetivo. Todo eso llegó
 * decidido del servidor —`judge` escribió el veredicto EN LA FILA CONGELADA, y
 * `display` viene formateado para Colombia desde que se escribió— porque un
 * componente de cliente que volviera a juzgar sería un segundo sitio donde se
 * juzga, y el día que los dos discrepen ganaría el que se ve, no el que está
 * guardado.
 *
 * Lo único que se decide aquí es el COLOR, y sale de `lib/goals-shape.ts`: este
 * árbol es `'use client'` y de `@cortex/agent-tools` sólo pueden llegar TIPOS
 * —un valor arrastra `node:dns` y rompe el build de producción, que es lo que
 * vigila `registry.test.ts`—, así que el mapa de tonos se copia y una prueba
 * compara las dos copias en Node.
 *
 * ===========================================================================
 * EL MÉTODO VA ENTERO
 * ===========================================================================
 * Como en `/goals`: la frase que dice cómo se hizo la cuenta se enseña sin
 * recortar. Una cifra sin ella es una afirmación, y una afirmación no se
 * audita: se cree o no se cree.
 */

interface GoalCard {
  id: string;
  label: string;
  cadenceLabel: string;
  targetLabel: string;
  createdBy: string;
  sourceSystem: string | null;
  latest: {
    periodLabel: string;
    display: string;
    statusLabel: string;
    status: GoalStatus;
    judgedAgainst: string;
    method: string;
    sampleSize: number;
    frozenAt: string;
  } | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Lo que llega cruzó un stream y, en una conversación reabierta, una fila de la
 * base. Una meta sin etiqueta no es una tarjeta a medio dibujar: no es tarjeta.
 */
function goalsOf(result: unknown): GoalCard[] | null {
  if (!result || typeof result !== 'object') return null;
  const list = (result as { goals?: unknown }).goals;
  if (!Array.isArray(list)) return null;

  return list.flatMap((raw): GoalCard[] => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    const id = text(row.id);
    const label = text(row.label);
    if (!id || !label) return [];

    const latest = row.latest as Record<string, unknown> | null | undefined;
    const status = latest ? text(latest.status) : null;

    return [
      {
        id,
        label,
        cadenceLabel: text(row.cadenceLabel) ?? '',
        targetLabel: text(row.targetLabel) ?? '',
        createdBy: text(row.createdBy) ?? 'alguien de este espacio',
        sourceSystem: text(row.sourceSystem),
        latest:
          latest && status && status in GOAL_STATUS_TONE
            ? {
                periodLabel: text(latest.periodLabel) ?? '',
                display: text(latest.display) ?? '—',
                statusLabel: text(latest.statusLabel) ?? '',
                status: status as GoalStatus,
                judgedAgainst: text(latest.judgedAgainst) ?? '',
                method: text(latest.method) ?? '',
                sampleSize: typeof latest.sampleSize === 'number' ? latest.sampleSize : 0,
                frozenAt: text(latest.frozenAt) ?? '',
              }
            : null,
      },
    ];
  });
}

export function GoalsSummary({ result }: ResultViewProps) {
  const goals = goalsOf(result);
  if (!goals) return null;

  if (goals.length === 0) {
    return (
      <div className="flex items-start gap-2 rounded-card border border-border bg-surface px-4 py-3 text-sm leading-relaxed text-ink-muted shadow-card">
        <Target className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>
          Esta empresa todavía no ha fijado ninguna meta. Una meta es una frase como «la cartera no
          debe pasar de 45 días»: un número que alguien decide y contra el que Cortex compara la
          realidad cada período.{' '}
          <Link href="/goals" className="font-semibold text-primary hover:text-primary-strong">
            Metas
          </Link>
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="field-label flex items-center gap-2 text-primary">
        <Target className="h-3.5 w-3.5" />
        Metas fijadas
        <span className="tabular rounded-pill border border-primary/20 bg-primary-soft px-1.5 text-micro font-semibold">
          {goals.length}
        </span>
      </div>
      {goals.map((goal) => (
        <GoalRow key={goal.id} goal={goal} />
      ))}
    </div>
  );
}

function GoalRow({ goal }: { goal: GoalCard }) {
  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-3">
        <span className="text-sm font-semibold text-ink">{goal.label}</span>
        <span className="text-xs text-ink-faint">
          {[goal.cadenceLabel, goal.targetLabel].filter(Boolean).join(' · ')}
        </span>
      </div>

      {goal.latest ? (
        <div className="px-4 pb-3 pt-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="stat-num tabular text-lg font-semibold text-ink">
              {goal.latest.display}
            </span>
            <span className={chipClass(GOAL_STATUS_TONE[goal.latest.status])}>
              {goal.latest.statusLabel}
            </span>
            <span className="text-xs text-ink-faint">
              {goal.latest.periodLabel} · objetivo de entonces: {goal.latest.judgedAgainst}
            </span>
          </div>
          {goal.latest.method ? (
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">{goal.latest.method}</p>
          ) : null}
        </div>
      ) : (
        <p className="px-4 pb-3 pt-2 text-xs leading-relaxed text-ink-muted">
          Todavía no tiene ningún período cerrado. La primera lectura se congela cuando cierre, y no
          se rellena hacia atrás: un número calculado hoy y presentado como el del mes pasado no
          sería historia. Para ver cómo va el período en curso, pídeme la medición en vivo.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 text-micro text-ink-faint">
        <span>Fijada por {goal.createdBy}</span>
        {goal.sourceSystem ? <span>Fuente: {goal.sourceSystem}</span> : null}
        {goal.latest?.frozenAt ? <span>Congelada el {goal.latest.frozenAt}</span> : null}
        <Link
          href="/goals"
          className="ml-auto font-semibold text-primary hover:text-primary-strong"
        >
          Ver el histórico
        </Link>
      </div>
    </Panel>
  );
}
