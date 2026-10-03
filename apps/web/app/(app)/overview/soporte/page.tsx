import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { isSupportOperator } from '@/lib/support/operator';
import { listAllTickets, operatorTicketMessages } from '@/lib/support/operator-store';
import {
  SUPPORT_STATUSES,
  SUPPORT_STATUS_LABEL,
  type SupportStatus,
  browserLabel,
  isSupportStatus,
} from '@/lib/support/shape';
import { clsx } from 'clsx';
import { ImageIcon, Inbox, MailWarning } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { TicketActions } from './TicketActions';

export const dynamic = 'force-dynamic';

const WHEN = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

const FILTERS: Array<{ id: SupportStatus | 'abiertos' | 'todos'; label: string }> = [
  { id: 'abiertos', label: 'Abiertos' },
  ...SUPPORT_STATUSES.map((s) => ({ id: s, label: SUPPORT_STATUS_LABEL[s] })),
  { id: 'todos', label: 'Todos' },
];

/**
 * LA BANDEJA DE SOPORTE DE LA PLATAFORMA: los tickets de todas las empresas.
 *
 * Global como el resto de /overview (no depende del espacio abierto), pero con
 * otra puerta: no la abre el fundador de una empresa sino quien opera Cortex
 * (`lib/support/operator.ts`). Quien no lo es va a /sin-acceso.
 */
export default async function SupportInboxPage({
  searchParams,
}: { searchParams: Promise<{ estado?: string }> }) {
  const { estado } = await searchParams;
  const user = await requireSession();
  if (!(await isSupportOperator(user.email))) redirect('/sin-acceso?area=soporte');

  const filter =
    estado === 'todos' ? undefined : isSupportStatus(estado) ? estado : ('abiertos' as const);
  const tickets = await listAllTickets(filter ? { status: filter } : {});
  const messages = await operatorTicketMessages(tickets.map((t) => t.id));
  const current = estado === 'todos' ? 'todos' : (filter ?? 'abiertos');

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Bandeja de soporte"
        subtitle="Lo que las empresas le escriben a soporte desde «Escribir a soporte», con la pantalla, el navegador y los errores que adjuntó la app."
        icon={<Inbox className="h-5 w-5" />}
      />
      <nav aria-label="Filtrar por estado" className="mb-5 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Link
            key={f.id}
            href={f.id === 'abiertos' ? '/overview/soporte' : `/overview/soporte?estado=${f.id}`}
            aria-current={current === f.id ? 'page' : undefined}
            className={clsx(
              'rounded-pill border px-3 py-1.5 text-sm font-semibold',
              current === f.id
                ? 'border-primary bg-primary-soft text-primary'
                : 'border-border bg-surface text-ink-muted hover:text-ink',
            )}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {tickets.length === 0 && (
        <p className="rounded-card border border-border bg-surface p-6 text-sm text-ink-muted shadow-card">
          No hay tickets en este estado.
        </p>
      )}
      <ul className="space-y-4">
        {tickets.map((t) => {
          const thread = messages.filter((m) => m.ticket_id === t.id);
          const errors = Array.isArray(t.context?.recentErrors)
            ? (t.context.recentErrors as unknown[]).filter(
                (e): e is string => typeof e === 'string',
              )
            : [];
          return (
            <li key={t.id} className="rounded-card border border-border bg-surface p-5 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-base font-bold text-ink">
                    #{t.number} · {t.subject}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {t.organization_name ?? t.organization_id} ·{' '}
                    {t.created_by_email ?? 'sin correo'} · {WHEN.format(new Date(t.created_at))}
                  </p>
                </div>
                <span className="rounded-pill bg-surface-2 px-2.5 py-0.5 text-micro font-bold text-ink-muted">
                  {isSupportStatus(t.status) ? SUPPORT_STATUS_LABEL[t.status] : t.status}
                </span>
              </div>
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-ink-muted sm:grid-cols-2">
                <div>
                  <dt className="inline font-semibold text-ink">Pantalla: </dt>
                  <dd className="inline">{t.route ?? 'sin dato'}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold text-ink">Navegador: </dt>
                  <dd className="inline">{browserLabel(t.user_agent)}</dd>
                </div>
              </dl>
              {errors.length > 0 && (
                <details className="mt-2 text-xs text-ink-muted">
                  <summary className="cursor-pointer font-semibold text-ink">
                    {errors.length} errores recientes del navegador
                  </summary>
                  <ul className="mt-1 list-disc pl-5 font-mono">
                    {errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </details>
              )}
              {t.email_error && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-amber">
                  <MailWarning className="h-4 w-4" /> El correo a soporte no salió: {t.email_error}
                </p>
              )}
              {t.screenshot_path && (
                <a
                  href={`/api/support/screenshot/${t.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                >
                  <ImageIcon className="h-4 w-4" /> Ver pantallazo
                </a>
              )}
              <div className="mt-3 space-y-2">
                {thread.map((m) => (
                  <div
                    key={m.id}
                    className={clsx(
                      'rounded-sm px-3 py-2',
                      m.author_kind === 'soporte' ? 'bg-primary-soft' : 'bg-surface-2',
                    )}
                  >
                    <p className="text-micro font-bold text-ink-faint">
                      {m.author_kind === 'soporte' ? 'Soporte' : 'Cliente'} · {m.author_email ?? ''}{' '}
                      · {WHEN.format(new Date(m.created_at))}
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink">{m.body}</p>
                  </div>
                ))}
              </div>
              <TicketActions id={t.id} status={isSupportStatus(t.status) ? t.status : 'abierto'} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
