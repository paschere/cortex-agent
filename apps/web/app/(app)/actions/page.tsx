import { ProposedActionCard } from '@/components/actions/ProposedActionCard';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import type { ActionView } from '@/lib/actions-shape';
import { relativeTime } from '@/lib/relative-time';
import { requireSession } from '@/lib/session';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { adaptAction, hydrateOwners, listActions } from '@cortex/agent-tools';
import { CheckCheck, MailQuestion, Send, Sparkles } from 'lucide-react';

/**
 * The queue: everything Cortex has written and nobody has answered yet, plus
 * what came of the ones that went out.
 *
 * The second half is the part that is easy to leave out and shouldn't be. A
 * screen that only lists what is pending teaches people that sending is the
 * finish line, and it is not — the cobro exists so the client pays. "Enviada
 * hace 9 días, nadie ha contestado" is the most actionable line this product
 * can put in front of somebody, and it only exists because an executed action
 * keeps being watched instead of disappearing.
 */

export const dynamic = 'force-dynamic';

/** How far back the closed section reaches. Beyond this it is history, not work. */
const CLOSED_WINDOW_MS = 30 * 24 * 60 * 60_000;

function SectionLabel({
  icon,
  children,
  count,
  tone,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  count: number;
  tone: StatusTone;
}) {
  return (
    <div className="mb-3">
      <div className="field-label flex items-center gap-2 pb-2">
        {icon}
        {children}
        <span className={chipClass(tone)}>{count}</span>
      </div>
      <div className="rule-double" />
    </div>
  );
}

export default async function ActionsPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const now = new Date();

  const rows = await hydrateOwners(
    db,
    await listActions(db, { userId: user.id, limit: 200 }),
  );

  // Stale proposals are filtered out rather than shown greyed: a card offering
  // figures that stopped being true is not information, and leaving it on
  // screen with a disabled button invites somebody to wonder why.
  const waiting = rows.filter(
    (r) => r.state === 'proposed' && Date.parse(r.expires_at) > now.getTime(),
  );
  const awaiting = rows.filter((r) => r.outcome === 'awaiting');
  const closedSince = now.getTime() - CLOSED_WINDOW_MS;
  const closed = rows.filter(
    (r) =>
      r.outcome !== 'awaiting' &&
      r.state !== 'proposed' &&
      Date.parse(r.updated_at) > closedSince,
  );

  const nothing = waiting.length === 0 && awaiting.length === 0 && closed.length === 0;

  return (
    <>
      <PageHeader
        title="Acciones"
        subtitle="Lo que Cortex ya redactó y espera tu visto bueno"
        icon={<Send className="h-5 w-5" />}
      />

      {nothing ? (
        <Panel className="p-10 text-center text-sm text-ink-muted">
          <Sparkles className="mx-auto mb-3 h-7 w-7 text-primary" />
          <p className="mb-1 text-base font-bold text-ink">No hay nada por aprobar</p>
          <p className="mx-auto max-w-md leading-relaxed">
            Cuando encuentre una cartera vencida, un vencimiento sin dueño o un correo de un cliente
            sin responder, Cortex deja aquí el mensaje ya redactado. Pídeselo en el chat —
            «prepárame el cobro de Coltrans» — y aparece listo para revisar.
          </p>
        </Panel>
      ) : (
        <div className="space-y-8">
          {waiting.length > 0 && (
            <section>
              <SectionLabel
                icon={<Send className="h-3.5 w-3.5 text-primary" />}
                count={waiting.length}
                tone="primary"
              >
                Esperando tu aprobación
              </SectionLabel>
              <div className="space-y-3">
                {waiting.map((r) => (
                  <ProposedActionCard key={r.id} action={adaptAction(r) as ActionView} />
                ))}
              </div>
            </section>
          )}

          {awaiting.length > 0 && (
            <section>
              <SectionLabel
                icon={<MailQuestion className="h-3.5 w-3.5 text-amber" />}
                count={awaiting.length}
                tone="amber"
              >
                Enviadas, sin respuesta todavía
              </SectionLabel>
              <div className="space-y-2">
                {awaiting.map((r) => (
                  <Panel key={r.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-ink">{r.subject}</span>
                      <span className="tabular text-xs text-ink-muted">{r.recipient}</span>
                    </div>
                    <p className="tabular mt-1 text-micro text-ink-faint">
                      Enviada {r.executed_at ? relativeTime(r.executed_at) : ''}
                    </p>
                  </Panel>
                ))}
              </div>
            </section>
          )}

          {closed.length > 0 && (
            <section>
              <SectionLabel
                icon={<CheckCheck className="h-3.5 w-3.5 text-emerald" />}
                count={closed.length}
                tone="emerald"
              >
                Cerradas
              </SectionLabel>
              <div className="space-y-2">
                {closed.map((r) => (
                  <ProposedActionCard key={r.id} action={adaptAction(r) as ActionView} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </>
  );
}
