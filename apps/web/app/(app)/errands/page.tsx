import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { spentFraction } from '@/lib/errands/budget';
import { ERRAND_KIND_LIST, ERRAND_KIND_SPECS } from '@/lib/errands/kinds';
import { listErrands } from '@/lib/errands/repository';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { Briefcase, MessageCircleQuestion } from 'lucide-react';
import Link from 'next/link';
import { CommissionForm } from './_components/CommissionForm';
import { ErrandStatusPill, relativeWhen } from './_components/status';

export const dynamic = 'force-dynamic';

/**
 * The errand desk: commission one, then see what became of the others.
 *
 * Errands waiting on an answer are hoisted to the top of the list and counted
 * in the meter strip, because they are the only rows on this screen that cost
 * something while nobody looks at them. Everything else is either working or
 * finished; a blocked errand is a stalled one, and the stall is ours to
 * surface rather than theirs to remember.
 */
export default async function ErrandsPage() {
  const user = await requireSession();
  const errands = await listErrands(getOrgScopedClient(user.organization.id), user.organization.id);

  const waiting = errands.filter((e) => e.state === 'blocked');
  const working = errands.filter((e) => e.state === 'working' || e.state === 'queued');
  const watching = errands.filter((e) => e.state === 'watching');
  const delivered = errands.filter((e) => e.state === 'delivered');

  // Blocked first — they are the ones that need a person — then everything
  // else newest first, which is the order the array already arrives in.
  const ordered = [...waiting, ...errands.filter((e) => e.state !== 'blocked')];

  const stats = [
    { label: 'Encargos', value: String(errands.length) },
    { label: 'Trabajando', value: String(working.length), live: working.length > 0 },
    { label: 'Esperan respuesta', value: String(waiting.length) },
    {
      label: watching.length > 0 ? 'Vigilando' : 'Entregados',
      value: String(watching.length > 0 ? watching.length : delivered.length),
    },
  ];

  return (
    <>
      <PageHeader
        title="Encargos"
        subtitle="Pídele algo que tome tiempo y cierra el navegador. Trabaja solo, te pregunta si se atasca y vuelve con el resultado y sus fuentes."
        icon={<Briefcase className="h-5 w-5" />}
      />

      <div className="mb-5">
        <CommissionForm kinds={ERRAND_KIND_LIST} />
      </div>

      {errands.length > 0 && (
        <Panel className="mb-5 overflow-hidden">
          <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
            {stats.map((s) => (
              <div key={s.label} className="bg-surface px-4 py-3">
                <div className="field-label flex items-center gap-1.5">
                  {s.live && (
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
                  )}
                  {s.label}
                </div>
                <div className="stat-num mt-1 truncate text-[20px] leading-none text-ink">
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {errands.length === 0 ? (
        <Panel className="px-6 py-12 text-center">
          <Briefcase className="mx-auto mb-3 h-7 w-7 text-primary" />
          <h2 className="text-[15px] font-bold text-ink">Todavía no le has encargado nada</h2>
          <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-ink-muted">
            Escoge un tipo arriba y descríbelo como se lo dirías a alguien del equipo. Cortex arma
            el plan, lo trabaja por su cuenta y te avisa cuando tenga algo — o cuando necesite que
            le aclares una cosa.
          </p>
        </Panel>
      ) : (
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="field-label">Encargos</div>
            <div className="tabular text-[11px] text-ink-faint">
              {errands.length} {errands.length === 1 ? 'encargo' : 'encargos'}
            </div>
          </div>
          <div className="rule-double" />
          <ul>
            {ordered.map((errand) => {
              const spent = Math.round(spentFraction(errand) * 100);
              return (
                <li key={errand.id} className="border-b border-border last:border-b-0">
                  <Link
                    href={`/errands/${errand.id}`}
                    className="flex flex-col gap-2 px-4 py-3.5 transition-colors hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-[13.5px] font-semibold leading-snug text-ink">
                        {errand.request}
                      </div>
                      <div className="tabular mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
                        <span>{ERRAND_KIND_SPECS[errand.kind].label}</span>
                        <span>{relativeWhen(errand.createdAt)}</span>
                        {errand.legsUsed > 0 && (
                          <span>
                            {errand.legsUsed}/{errand.legCeiling}{' '}
                            {errand.legCeiling === 1 ? 'vuelta' : 'vueltas'}
                          </span>
                        )}
                        {errand.tokensSpent > 0 && <span>{spent}% del tope</span>}
                        {errand.openQuestions > 0 && (
                          <span className="inline-flex items-center gap-1 font-semibold text-amber">
                            <MessageCircleQuestion className="h-3 w-3" />
                            te pregunta algo
                          </span>
                        )}
                      </div>
                    </div>
                    <ErrandStatusPill
                      state={errand.state}
                      className="shrink-0 self-start sm:self-auto"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
    </>
  );
}
