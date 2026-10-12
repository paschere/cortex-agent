'use client';

import { type PlanScope, planApprovalMessage, planApprovalModel } from '@/lib/plan-approval';
import type { PlanState } from '@/lib/plan-state';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { Check, ListChecks, Loader2, OctagonX, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useChatCompose } from './ChatCompose';

/**
 * «APROBAR EL PLAN»: una sola aprobación para un trabajo de varios pasos.
 *
 * Muestra el plan con las herramientas de cada paso en palabras, el riesgo de
 * cada una y cuáles SEGUIRÁN preguntando (envíos, pagos, borrados…). Aprobar
 * crea una concesión en el servidor (/api/chat/plan) cuyo alcance sale del plan
 * guardado, no de esta pantalla; dura unos minutos, tiene tope de llamadas y se
 * puede detener aquí mismo.
 */

interface GrantView {
  id: string;
  tools: string[];
  expiresAt: string;
  maxCalls: number;
}

export interface PlanApprovalCardProps {
  conversationId: string;
  plan: PlanState;
  onSay?: (text: string) => void;
  /** Cortex sigue en el turno: el plan sólo está guardado cuando termina. */
  waiting?: boolean;
  /** Para las fixtures de /v/chat-showcase: nada de red. */
  preset?: { scope: PlanScope | null; grant?: GrantView | null };
}

type Phase = 'ask' | 'working' | 'granted' | 'stepwise' | 'stopped';

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

export function PlanApprovalCard({
  conversationId,
  plan,
  onSay,
  waiting = false,
  preset,
}: PlanApprovalCardProps) {
  const compose = useChatCompose();
  const [scope, setScope] = useState<PlanScope | null>(preset?.scope ?? null);
  const [grant, setGrant] = useState<GrantView | null>(preset?.grant ?? null);
  const [phase, setPhase] = useState<Phase>(preset?.grant ? 'granted' : 'ask');
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (preset || waiting) return;
    let alive = true;
    fetch(`/api/chat/plan?conversationId=${encodeURIComponent(conversationId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data: {
            scope?: PlanScope | null;
            grant?: GrantView | null;
            planTitle?: string | null;
          } | null,
        ) => {
          if (!alive || !data) return;
          if (data.scope) setScope(data.scope);
          if (data.grant) {
            setGrant(data.grant);
            setPhase('granted');
            return;
          }
          // Un plan viejo o ya terminado no vuelve a pedir aprobación: sólo se
          // dibuja si es el plan vigente de la conversación y le faltan pasos.
          const pending = (data.scope?.grantable.length ?? 0) + (data.scope?.alwaysAsk.length ?? 0);
          if (!data.scope || pending === 0 || (data.planTitle && data.planTitle !== plan.title))
            setHidden(true);
        },
      )
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [conversationId, waiting, preset, plan.title]);

  const model = planApprovalModel(plan, scope);
  const say = onSay ?? compose?.ask;

  async function post(action: 'approve' | 'revoke') {
    const res = await fetch('/api/chat/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, action }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      grant?: GrantView | null;
      scope?: PlanScope;
      title?: string;
    };
    if (!res.ok) throw new Error(data.error ?? 'No se pudo completar.');
    return data;
  }

  async function approve() {
    setPhase('working');
    setError('');
    try {
      const data = await post('approve');
      setGrant(data.grant ?? null);
      if (data.scope) setScope(data.scope);
      setPhase('granted');
      // La continuación entra como mensaje de la persona (isControlHandoffMessage).
      if (say && data.scope) say(planApprovalMessage(data.title ?? plan.title, data.scope));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo aprobar el plan.');
      setPhase('ask');
    }
  }

  async function stop() {
    setPhase('working');
    try {
      await post('revoke');
      setGrant(null);
      setPhase('stopped');
      say?.('Detuve el plan: desde ahora vuelve a pedirme aprobación en cada paso.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo detener el plan.');
      setPhase('granted');
    }
  }

  const covered = phase === 'granted' && grant ? new Set(grant.tools) : null;
  if (hidden) return null;

  return (
    <section
      aria-label="Aprobar el plan"
      className="overflow-hidden rounded-card border border-primary/20 bg-surface shadow-card"
    >
      <header className="flex items-start gap-3 bg-primary-soft px-4 py-3.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-primary/10 text-primary">
          {phase === 'granted' ? (
            <ShieldCheck className="h-[18px] w-[18px]" aria-hidden />
          ) : (
            <ListChecks className="h-[18px] w-[18px]" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-micro font-semibold text-primary-ink">
              {phase === 'granted' ? 'Plan aprobado' : 'Aprobar el plan'}
            </span>
            {phase === 'granted' && grant && (
              <span className={chipClass('emerald')}>hasta las {hhmm(grant.expiresAt)}</span>
            )}
          </div>
          <p className="mt-1 text-sm font-semibold text-ink [overflow-wrap:anywhere]">
            {model.title}
          </p>
          <p className="mt-0.5 text-xs leading-snug text-ink-muted">
            {phase === 'granted'
              ? 'Cortex puede seguir con estos pasos sin preguntar uno por uno. Lo que sale a terceros, mueve plata o borra sigue pidiendo su tarjeta.'
              : 'Revisa los pasos. Si lo apruebas una vez, Cortex no te vuelve a preguntar por las herramientas marcadas, durante 30 minutos y con tope de llamadas.'}
          </p>
        </div>
      </header>

      <ol className="divide-y divide-border px-4">
        {model.steps.map((s) => (
          <li key={s.id} className="flex items-start gap-3 py-2.5">
            <span className="tabular mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink-muted">
              {s.index}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-snug text-ink [overflow-wrap:anywhere]">
                {s.label}
              </p>
              {s.what && (
                <p className="mt-0.5 text-xs leading-snug text-ink-muted [overflow-wrap:anywhere]">
                  {s.what}
                </p>
              )}
              {s.tools.length > 0 && (
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {s.tools.map((t) => {
                    const isCovered = covered ? covered.has(t.id) : t.covered;
                    return (
                      <li
                        key={t.id}
                        className={clsx(chipClass(isCovered === false ? 'amber' : t.risk.tone))}
                        title={`${t.risk.label}${isCovered === false ? ' · seguirá pidiendo tu aprobación' : ''}`}
                      >
                        {isCovered === true && <Check className="h-3 w-3" aria-hidden />}
                        {t.label}
                        <span className="font-normal opacity-80">
                          ·{' '}
                          {isCovered === false ? 'preguntará' : t.risk.label.replace('Riesgo ', '')}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>

      <footer className="border-t border-border px-4 py-3">
        {model.askingCount > 0 && phase !== 'granted' && (
          <p className="mb-2 text-xs text-amber">
            {model.askingCount === 1
              ? '1 herramienta seguirá preguntando'
              : `${model.askingCount} herramientas seguirán preguntando`}
            : esas tienen su tarjeta normal.
          </p>
        )}
        {error && (
          <p role="alert" className="mb-2 rounded-sm bg-rose-soft px-2.5 py-1.5 text-xs text-rose">
            {error}
          </p>
        )}
        {phase === 'stepwise' ? (
          <p className="text-xs text-ink-muted">
            Va paso a paso: cada acción pedirá su aprobación.{' '}
            <button
              type="button"
              className="font-semibold text-primary"
              onClick={() => setPhase('ask')}
            >
              Aprobar el plan
            </button>
          </p>
        ) : phase === 'stopped' ? (
          <p className="text-xs text-ink-muted">
            Plan detenido. Cada acción vuelve a pedir su aprobación.
          </p>
        ) : phase === 'granted' ? (
          <button
            type="button"
            onClick={() => void stop()}
            className="inline-flex items-center gap-1.5 rounded-pill border border-rose/30 px-3.5 py-1.5 text-sm font-semibold text-rose transition-colors hover:bg-rose-soft motion-reduce:transition-none"
          >
            <OctagonX className="h-3.5 w-3.5" aria-hidden /> Detener el plan
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void approve()}
              disabled={
                phase === 'working' || waiting || (scope !== null && scope.grantable.length === 0)
              }
              title={waiting ? 'Espera a que Cortex termine de escribir el plan' : undefined}
              className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-sm font-semibold text-white shadow-card transition-all hover:-translate-y-px hover:brightness-95 disabled:opacity-60 disabled:shadow-none motion-reduce:transform-none motion-reduce:transition-none"
            >
              {phase === 'working' ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Aprobando…
                </>
              ) : (
                <>
                  <Check className="h-3.5 w-3.5" aria-hidden /> Aprobar el plan
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => setPhase('stepwise')}
              disabled={phase === 'working'}
              className="rounded-pill bg-surface-2 px-4 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink disabled:opacity-60 motion-reduce:transition-none"
            >
              Aprobar paso a paso
            </button>
            {compose && (
              <button
                type="button"
                onClick={() =>
                  compose.compose(`Antes de empezar, cambia el plan «${model.title}» así: `)
                }
                disabled={phase === 'working'}
                className="rounded-pill px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-60 motion-reduce:transition-none"
              >
                Cambiar algo
              </button>
            )}
          </div>
        )}
      </footer>
    </section>
  );
}
