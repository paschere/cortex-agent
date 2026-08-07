import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelHead } from '@/components/ui/panel';
import { Field } from '@/components/ui/provenance';
import {
  METER_LABEL,
  METER_STATE_LABEL,
  METER_STATE_TONE,
  type MeterId,
  SOURCE_LABEL,
  barFill,
  cop,
  count,
  percent,
  periodLabel,
  stamp,
} from '@/lib/plan-shape';
import { requireSession } from '@/lib/session';
import { chipClass } from '@/lib/status-chip';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type Entitlement,
  listPlans,
  listUsageEvents,
  meteringSince,
  readWorkspaceUsage,
} from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Check, Gauge, Receipt, Users } from 'lucide-react';
import Link from 'next/link';
import { PlanInterest } from './_components/PlanInterest';

export const dynamic = 'force-dynamic';

/**
 * /plan — what this workspace is on, what it has used, and the list the figure
 * comes from.
 *
 * THE POINT OF THE THIRD PANEL. Anyone can put a number on a screen. The reason
 * the ledger is shown, row by row, next to the total is that a figure somebody
 * is charged for should be checkable by the person paying it — the same promise
 * the rest of Cortex makes about every fact it asserts. "1.240 respuestas" is an
 * assertion; a list of 1.240 conversations you can open is evidence.
 *
 * It is deliberately NOT an internal invoicing screen. It shows one workspace
 * its own consumption, through the scoped handle, and there is no path from here
 * to anybody else's.
 */

const METER_ORDER: MeterId[] = ['answers', 'documents'];

function MeterBlock({ entitlement }: { entitlement: Entitlement }) {
  const { meter, used, limit, state, grace, allowance } = entitlement;
  const label = METER_LABEL[meter];
  const tone = METER_STATE_TONE[state];
  const pct = percent(used, limit);

  return (
    <div className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="text-[13px] font-semibold text-ink">
          {label.many.charAt(0).toUpperCase() + label.many.slice(1)}
        </div>
        <span className={chipClass(limit === null ? 'neutral' : tone)}>
          {limit === null ? 'Sin límite' : METER_STATE_LABEL[state]}
        </span>
      </div>

      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="stat-num text-[30px] leading-none text-ink">{count(used)}</span>
        {limit !== null && (
          <span className="tabular text-[13px] text-ink-faint">de {count(limit)}</span>
        )}
        {pct && <span className="tabular ml-1 text-[12px] text-ink-faint">· {pct}</span>}
      </div>

      {limit !== null && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className={clsx(
              'h-full rounded-full transition-[width] duration-700 motion-reduce:transition-none',
              tone === 'rose' ? 'bg-rose' : tone === 'amber' ? 'bg-amber' : 'bg-emerald',
            )}
            style={{ width: `${Math.max(barFill(used, limit) * 100, used > 0 ? 4 : 0)}%` }}
          />
        </div>
      )}

      <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">{label.help}</p>

      {/* The margin is stated only once it is doing something. Explaining a
          courtesy nobody has needed yet is noise on every other screen. */}
      {state === 'grace' && allowance !== null && (
        <p className="mt-2 text-[12px] leading-relaxed text-amber">
          Te pasaste del plan y Cortex sigue trabajando: te quedan{' '}
          <span className="tabular font-semibold">{count(Math.max(0, allowance - used))}</span> de
          cortesía sobre las <span className="tabular">{count(grace)}</span> del margen. Nada se
          corta a mitad de una conversación; cuando se acabe el margen dejamos de empezar respuestas
          nuevas.
        </p>
      )}
      {state === 'blocked' && meter === 'answers' && (
        <p className="mt-2 text-[12px] leading-relaxed text-rose">
          Se acabó el margen. Cortex no empieza respuestas nuevas, pero todo lo que ya está adentro
          se sigue leyendo y buscando. Amplía el plan y vuelve a responder de inmediato.
        </p>
      )}
      {state === 'blocked' && meter === 'documents' && (
        <p className="mt-2 text-[12px] leading-relaxed text-amber">
          Los documentos nuevos se siguen guardando: quedan legibles y se buscan por palabra, pero
          todavía no entran en las respuestas. Al ampliar el plan se indexan solos, sin volverlos a
          subir.
        </p>
      )}
    </div>
  );
}

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{ meter?: string }>;
}) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const params = await searchParams;
  const openMeter: MeterId = params.meter === 'documents' ? 'documents' : 'answers';

  const usage = await readWorkspaceUsage(db, user.organization.id);
  const [plans, ledger, since] = await Promise.all([
    listPlans(db),
    listUsageEvents(db, { meter: openMeter, period: usage.period, limit: 60 }),
    meteringSince(db),
  ]);

  const { plan, seats } = usage;
  const unlimited = plan.limits.answers === null && plan.limits.documents === null;
  const others = plans.filter((p) => p.selfServe && p.code !== plan.code);
  const ledgerTotal = ledger.reduce((n, r) => n + r.quantity, 0);
  const meterTotal = usage.meters[openMeter].used;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Plan y consumo"
        subtitle="Qué incluye tu plan, cuánto llevas usado este mes y de dónde sale cada cifra."
        icon={<Gauge className="h-4 w-4" />}
        actions={
          <span className={chipClass(unlimited ? 'primary' : 'neutral')}>Plan {plan.name}</span>
        }
      />

      {/* ---------------------------------------------------------------- */}
      <Panel>
        <PanelHead
          title={`Plan ${plan.name}`}
          icon={<Receipt className="h-4 w-4" />}
          right={
            plan.priceCop > 0 ? (
              <span className="tabular text-ink">{cop(plan.priceCop)} / mes</span>
            ) : unlimited ? (
              'Acordado contigo'
            ) : (
              'Sin costo'
            )
          }
        />
        <div className="px-5 pb-5 pt-3">
          <p className="text-[13px] text-ink-muted">{plan.tagline}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Field label="Respuestas al mes">
              <span className="tabular">
                {plan.limits.answers === null ? 'Sin límite' : count(plan.limits.answers)}
              </span>
            </Field>
            <Field label="Documentos">
              <span className="tabular">
                {plan.limits.documents === null ? 'Sin límite' : count(plan.limits.documents)}
              </span>
            </Field>
            <Field label="Personas">
              <span className="tabular">
                {seats.limit === null ? 'Sin límite' : `${count(seats.used)} de ${count(seats.limit)}`}
              </span>
            </Field>
          </div>
          {unlimited && (
            <p className="mt-4 rounded-sm border border-primary/15 bg-primary-soft px-3 py-2.5 text-[12px] leading-relaxed text-primary-ink">
              Tu espacio no tiene topes. Seguimos midiendo el consumo para que puedas verlo, pero
              nada aquí te limita.
            </p>
          )}
        </div>
      </Panel>

      {/* ---------------------------------------------------------------- */}
      <Panel>
        <PanelHead
          title={`Consumo de ${periodLabel(usage.period)}`}
          icon={<Gauge className="h-4 w-4" />}
          right={
            since ? (
              <span className="tabular">Se mide desde el {stamp(since)}</span>
            ) : (
              'Todavía sin consumo'
            )
          }
        />
        <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          {METER_ORDER.map((meter) => (
            <MeterBlock key={meter} entitlement={usage.meters[meter]} />
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3.5">
          <div className="flex items-center gap-2 text-[12.5px] text-ink-muted">
            <Users className="h-3.5 w-3.5 text-ink-faint" />
            <span className="tabular text-ink">{count(seats.used)}</span> personas
            {seats.pending > 0 && (
              <span className="text-ink-faint">
                (<span className="tabular">{count(seats.pending)}</span> por aceptar la invitación)
              </span>
            )}
          </div>
          <Link href="/onboarding" className="text-[12.5px] font-semibold text-primary hover:underline">
            Invitar a alguien
          </Link>
        </div>
      </Panel>

      {/* ---------------------------------------------------------------- */}
      <Panel>
        <PanelHead
          title="De dónde sale la cifra"
          icon={<Receipt className="h-4 w-4" />}
          right={
            <div className="flex gap-1.5">
              {METER_ORDER.map((meter) => (
                <Link
                  key={meter}
                  href={`/plan?meter=${meter}`}
                  className={chipClass(meter === openMeter ? 'primary' : 'neutral')}
                >
                  {METER_LABEL[meter].many}
                </Link>
              ))}
            </div>
          }
        />
        <div className="px-5 pb-2 pt-3">
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            Cada fila es una unidad cobrada y nombra la conversación o el documento que la produjo.
            La cifra de arriba no es una afirmación: es el largo de esta lista.
          </p>
        </div>

        {ledger.length === 0 ? (
          <div className="px-5 pb-5 pt-2 text-[13px] text-ink-faint">
            Todavía no hay {METER_LABEL[openMeter].many} en {periodLabel(usage.period)}.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {ledger.map((row) => (
              <li key={row.id} className="flex items-center gap-3 px-5 py-2.5">
                <span className="tabular w-[92px] shrink-0 text-[12px] text-ink-faint">
                  {stamp(row.occurredAt)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {row.label ?? (
                    <span className="font-mono text-[12px] text-ink-faint">
                      {row.subjectId.slice(0, 8)}
                    </span>
                  )}
                </span>
                {row.source && (
                  <span className={chipClass('neutral')}>
                    {SOURCE_LABEL[row.source] ?? row.source}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* The honest footnote. A list capped at 60 rows next to a total of
            1.240 would otherwise read as a contradiction. */}
        <div className="border-t border-border px-5 py-3 text-[12px] text-ink-faint">
          {ledgerTotal < meterTotal ? (
            <>
              Se muestran las <span className="tabular">{count(ledgerTotal)}</span> más recientes de{' '}
              <span className="tabular">{count(meterTotal)}</span> en el mes.
            </>
          ) : (
            <>
              Estas <span className="tabular">{count(ledgerTotal)}</span> filas son exactamente la
              cifra de arriba.
            </>
          )}
        </div>
      </Panel>

      {/* ---------------------------------------------------------------- */}
      {others.length > 0 && (
        <Panel>
          <PanelHead title="Cambiar de plan" icon={<Check className="h-4 w-4" />} />
          <div className="px-5 pb-5 pt-3">
            {/* Said plainly rather than hidden behind a checkout that does not
                exist. See the billing note in agent-tools/src/billing/plans.ts. */}
            <p className="text-[12.5px] leading-relaxed text-ink-muted">
              Todavía no cobramos dentro del producto. Dinos cuál necesitas y lo activamos; queda
              anotado con tu nombre y la fecha.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {others.map((other) => (
                <div key={other.code} className="rounded-card border border-border bg-surface-2 p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-semibold text-ink">{other.name}</span>
                    <span className="tabular text-[13px] text-ink">
                      {other.priceCop > 0 ? `${cop(other.priceCop)}/mes` : 'Gratis'}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[12px] text-ink-muted">{other.tagline}</p>
                  <div className="tabular mt-3 text-[12px] text-ink-faint">
                    {other.limits.answers === null ? 'Sin límite' : count(other.limits.answers)}{' '}
                    respuestas ·{' '}
                    {other.limits.documents === null ? 'sin límite' : count(other.limits.documents)}{' '}
                    documentos ·{' '}
                    {other.seatsLimit === null ? 'sin límite' : count(other.seatsLimit)} personas
                  </div>
                  <PlanInterest planCode={other.code} planName={other.name} />
                </div>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {usage.status !== 'active' && (
        <p className="text-[12px] text-rose">
          Tu suscripción está marcada como{' '}
          {usage.status === 'past_due' ? 'pendiente de pago' : 'cancelada'}. Escríbenos antes de que
          afecte al equipo.
        </p>
      )}
    </div>
  );
}
