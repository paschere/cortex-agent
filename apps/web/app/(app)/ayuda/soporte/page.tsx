import { SupportForm } from '@/components/help/SupportForm';
import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  SUPPORT_STATUS_LABEL,
  SUPPORT_STATUS_TONE,
  isSupportStatus,
  supportChannel,
} from '@/lib/support/shape';
import { type TicketMessageRow, listMyTickets, listTicketMessages } from '@/lib/support/store';
import { clsx } from 'clsx';
import { ArrowLeft, LifeBuoy } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const WHEN = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

const TONE_CLASS = {
  primary: 'bg-primary-soft text-primary',
  amber: 'bg-amber-soft text-amber',
  emerald: 'bg-emerald-soft text-emerald',
  muted: 'bg-surface-2 text-ink-muted',
} as const;

/**
 * «Escribir a soporte» y lo que esta persona ya escribió, con las respuestas.
 * `?desde=/pagar` dice de qué pantalla viene (lo pone el panel «?»).
 */
export default async function SupportPage({
  searchParams,
}: { searchParams: Promise<{ desde?: string }> }) {
  const { desde } = await searchParams;
  const from = desde?.startsWith('/') && !desde.startsWith('//') ? desde.slice(0, 300) : null;
  const user = await requireSession();
  const enabled = supportChannel(process.env.SUPPORT_CHANNEL) !== 'off';
  const db = getOrgScopedClient(user.organization.id);

  let tickets: Awaited<ReturnType<typeof listMyTickets>> = [];
  let messages: TicketMessageRow[] = [];
  let readError = false;
  try {
    tickets = await listMyTickets(db, user.id);
    messages = await listTicketMessages(
      db,
      tickets.map((t) => t.id),
    );
  } catch {
    readError = true;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/ayuda"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" /> Ayuda
      </Link>
      <PageHeader
        title="Escribir a soporte"
        subtitle="Cuéntanos qué pasó. Te contestamos al correo de tu cuenta y la respuesta queda aquí."
        icon={<LifeBuoy className="h-5 w-5" />}
      />

      {enabled ? (
        <SupportForm from={from} organization={user.organization.name} />
      ) : (
        <p className="rounded-card border border-border bg-surface p-5 text-sm text-ink-muted shadow-card">
          El canal de soporte está apagado en esta instalación. Escríbele a quien administra Cortex
          en tu empresa.
        </p>
      )}

      <section className="mt-10" aria-label="Tus mensajes a soporte">
        <h2 className="mb-3 text-lg font-extrabold text-ink">Tus mensajes a soporte</h2>
        {readError && <p className="text-sm text-rose">No pude leer tus mensajes anteriores.</p>}
        {!readError && tickets.length === 0 && (
          <p className="text-sm text-ink-muted">Todavía no has escrito a soporte.</p>
        )}
        <ul className="space-y-3">
          {tickets.map((t) => {
            const status = isSupportStatus(t.status) ? t.status : 'abierto';
            const thread = messages.filter((m) => m.ticket_id === t.id);
            const replies = thread.filter((m) => m.author_kind === 'soporte');
            return (
              <li
                key={t.id}
                className="rounded-card border border-border bg-surface p-4 shadow-card"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold text-ink">
                    #{t.number} · {t.subject}
                  </p>
                  <span
                    className={clsx(
                      'rounded-pill px-2.5 py-0.5 text-micro font-bold',
                      TONE_CLASS[SUPPORT_STATUS_TONE[status]],
                    )}
                  >
                    {SUPPORT_STATUS_LABEL[status]}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-faint">
                  {WHEN.format(new Date(t.created_at))}
                  {t.route ? ` · desde ${t.route}` : ''}
                </p>
                {replies.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {replies.map((m) => (
                      <div key={m.id} className="rounded-sm bg-primary-soft px-3 py-2">
                        <p className="text-micro font-bold text-primary">
                          Soporte · {WHEN.format(new Date(m.created_at))}
                        </p>
                        <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink">{m.body}</p>
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
