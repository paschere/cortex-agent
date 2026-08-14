import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/panel';
import { requireSession } from '@/lib/session';
import type { StatusTone } from '@/lib/status-chip';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  CADENCE_LABEL,
  DIRECTION_LABEL,
  GOAL_STATUS_LABEL,
  GOAL_STATUS_TONE,
  GOAL_UNIT_LABEL,
  type GoalReadingRow,
  type GoalRow,
  bogotaToday,
  describeTarget,
  hydrateGoals,
  lastClosedPeriod,
  listGoals,
  listReadings,
  measureLive,
  metricByKey,
  offerMetrics,
  periodContaining,
} from '@cortex/agent-tools';
import { CalendarClock, CircleSlash, Target, TrendingDown } from 'lucide-react';
import { GoalsBoard } from './_components/GoalsBoard';
import type { GoalView, LiveView, MetricOptionView, ReadingView } from './_components/types';

/**
 * Metas.
 *
 * LA PANTALLA QUE CIERRA EL PRODUCTO. Hasta aquí Cortex sabía qué se vence, qué
 * se leyó, qué entró y qué se hizo — todos hechos sueltos, ninguno con nada
 * contra lo cual medirse. Esto es la cifra que alguien fijó, la lectura de cada
 * período y el aviso cuando las dos dejan de coincidir.
 *
 * TRES COSAS COMPARTEN LA PANTALLA, Y EL ORDEN ES EL ARGUMENTO:
 *
 *   ARRIBA, LAS METAS QUE HAY, con el último período CERRADO como cifra grande
 *   y el que está en curso al lado, marcado como tal. La distinción no es
 *   decorativa: el cerrado está congelado y el otro cambia cada mañana, y
 *   enseñarlos iguales sería enseñar a citar el segundo como si fuera el
 *   primero.
 *
 *   DENTRO DE CADA META, EL HISTÓRICO CON SU MÉTODO. Cada fila dice contra qué
 *   objetivo se juzgó ESE período y cómo se hizo la aritmética. Es lo que
 *   convierte un tablero en algo que se puede discutir.
 *
 *   ABAJO, EL SELECTOR QUE SE NIEGA A OFRECER LO QUE NO SABE MEDIR. Las
 *   métricas que este espacio no puede calcular salen apagadas y con su motivo
 *   —«para medir cartera necesito que conectes Siigo o que empieces a registrar
 *   pagos»— en vez de desaparecer. Esconderlas dejaría a alguien buscando una
 *   función que sí existe; ofrecerlas crearía la casilla vacía que resta más
 *   confianza de la que suma.
 *
 * Todas las lecturas pasan por el handle con alcance y comprueban su error.
 */

export const dynamic = 'force-dynamic';

export default async function GoalsPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();

  const [goals, offers] = await Promise.all([
    hydrateGoals(db, await listGoals(db, { state: 'active', limit: 50 })),
    offerMetrics(db),
  ]);

  const views: GoalView[] = await Promise.all(goals.map((goal) => toView(db, goal, today)));

  const options: MetricOptionView[] = offers.map((offer) => ({
    key: offer.spec.key,
    label: offer.spec.label,
    blurb: offer.spec.blurb,
    unit: offer.spec.unit,
    unitLabel: GOAL_UNIT_LABEL[offer.spec.unit],
    direction: offer.spec.direction,
    directionLabel: DIRECTION_LABEL[offer.spec.direction],
    suggestedTarget: offer.spec.suggestedTarget,
    sourceSystem: offer.spec.source.system,
    available: offer.available,
    reason: offer.reason,
  }));

  const measurable = options.filter((o) => o.available).length;
  const breached = views.filter((v) => v.latest?.status === 'breached').length;
  const waiting = views.filter((v) => v.latest == null).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Metas"
        subtitle="La cifra que fijaste y lo que de verdad pasó, período a período. Cada lectura queda congelada con la cuenta que la produjo."
        icon={<Target className="h-5 w-5" aria-hidden />}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Metas fijadas"
          value={String(views.length)}
          sub={views.length === 0 ? 'todavía ninguna' : 'activas ahora mismo'}
          icon={<Target className="h-4 w-4" aria-hidden />}
          tone="primary"
        />
        <StatCard
          label="Fuera de meta"
          value={String(breached)}
          sub="en el último período cerrado"
          icon={<TrendingDown className="h-4 w-4" aria-hidden />}
          tone={breached > 0 ? 'rose' : 'emerald'}
          delay={60}
        />
        <StatCard
          label="Esperando su primer cierre"
          value={String(waiting)}
          sub="sin período congelado todavía"
          icon={<CalendarClock className="h-4 w-4" aria-hidden />}
          tone={waiting > 0 ? 'sky' : 'emerald'}
          delay={120}
        />
        <StatCard
          label="Métricas disponibles"
          value={`${measurable} de ${options.length}`}
          sub="lo que este espacio sabe medir hoy"
          icon={<CircleSlash className="h-4 w-4" aria-hidden />}
          tone={measurable > 0 ? 'emerald' : 'amber'}
          delay={180}
        />
      </div>

      <GoalsBoard goals={views} options={options} />
    </div>
  );
}

// ---------------------------------------------------------------------------

async function toView(
  db: ReturnType<typeof getOrgScopedClient>,
  goal: GoalRow,
  today: string,
): Promise<GoalView> {
  const spec = metricByKey(goal.metric_key);
  const history = await listReadings(db, goal.id, 12);
  const closed = lastClosedPeriod(goal.cadence, today);
  const latest = history.find((r) => r.period_start === closed.start) ?? history[0] ?? null;

  // EL PERÍODO EN CURSO, MEDIDO EN VIVO Y SIN GUARDARSE. Una meta mensual
  // fijada el día 2 no puede dejar a nadie tres semanas mirando una tabla
  // vacía. No es un pronóstico —es lo que va del período, con su método— y
  // sobre todo no es una fila: guardarlo lo convertiría en un marcador.
  let live: LiveView | null = null;
  if (spec) {
    const current = periodContaining(goal.cadence, today);
    const measured = await measureLive(db, goal, current, spec);
    live = {
      periodLabel: current.label,
      display: measured.display,
      status: measured.status,
      statusLabel: GOAL_STATUS_LABEL[measured.status],
      statusTone: GOAL_STATUS_TONE[measured.status] as StatusTone,
      method: measured.method,
      sampleSize: measured.sampleSize,
    };
  }

  return {
    id: goal.id,
    label: goal.label,
    metricKey: goal.metric_key,
    metricLabel: spec?.label ?? null,
    cadenceLabel: CADENCE_LABEL[goal.cadence],
    targetLabel: describeTarget(goal.direction, goal.target_value, goal.unit),
    createdByName: goal.created_by_name ?? 'alguien de este espacio',
    createdOn: goal.created_at.slice(0, 10),
    sourceSystem: spec?.source.system ?? null,
    latest: latest ? toReadingView(latest, goal) : null,
    live,
    history: history.map((r) => toReadingView(r, goal)),
  };
}

function toReadingView(row: GoalReadingRow, goal: GoalRow): ReadingView {
  return {
    id: row.id,
    periodLabel: periodContaining(goal.cadence, row.period_start).label,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    display: row.display,
    status: row.status,
    statusLabel: GOAL_STATUS_LABEL[row.status],
    statusTone: GOAL_STATUS_TONE[row.status] as StatusTone,
    method: row.method,
    sampleSize: row.sample_size,
    // EL OBJETIVO DE ESE PERÍODO, no el de hoy. Sale de la fila congelada, y es
    // por lo que subir la meta mañana no reescribe el veredicto de julio.
    judgedAgainst: describeTarget(row.direction, row.target_value, row.unit),
    frozenAt: row.computed_at.slice(0, 10),
  };
}
