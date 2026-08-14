import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { Field, Provenance } from '@/components/ui/provenance';
import { requireSession } from '@/lib/session';
import { chipClass } from '@/lib/status-chip';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  KIND_LABEL,
  RECURRENCE_LABEL,
  STATE_LABEL,
  adaptCommitment,
  bogotaToday,
  getCommitment,
  listNoticesFor,
  listSeries,
} from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { CalendarClock, CalendarOff, CalendarRange } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DetailActions } from '../_components/DetailActions';
import { cop, longDate, shortDate, stamp, whenPhrase } from '../_components/format';

/**
 * One vencimiento, with its whole story.
 *
 * THE PROVENANCE BLOCK IS THE POINT OF THIS PAGE. Everything else — the date,
 * the owner, the amount — is available on the card. What is only here is the
 * evidence: which registry said it and when, or which document and the exact
 * sentence, printed in the mono face because it is a quotation and not prose.
 * A person who doubts an alarm should be able to settle it here in ten seconds
 * without asking anybody.
 *
 * Underneath, the two ledgers that make the system auditable: what Cortex has
 * already said about this occurrence, and every previous occurrence of the same
 * standing obligation.
 */

export const dynamic = 'force-dynamic';

const STATE_CHIP = {
  in_force: 'emerald',
  due_soon: 'amber',
  overdue: 'rose',
  met: 'neutral',
  dropped: 'neutral',
} as const;

const NOTICE_LABEL: Record<string, string> = {
  ahead: 'Aviso anticipado',
  due_today: 'Vence hoy',
  overdue: 'Vencido',
  escalation: 'Escalado',
};

export default async function CommitmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();

  const row = await getCommitment(db, id);
  // A commitment from another workspace reads as missing, never as forbidden —
  // the two have to stay indistinguishable or the 404 becomes a way to confirm
  // that another company's row exists.
  if (!row) notFound();

  const c = adaptCommitment(row, today);
  const [notices, series] = await Promise.all([
    listNoticesFor(db, [row.id]),
    listSeries(db, row.series_id),
  ]);
  const history = series.filter((s) => s.id !== row.id);
  const thisOccurrence = notices.filter((n) => n.due_on === row.due_on);

  return (
    <>
      <PageHeader
        title={c.title}
        subtitle={`${c.kindLabel}${c.counterparty ? ` · ${c.counterparty}` : ''}`}
        icon={<CalendarClock className="h-5 w-5" />}
        actions={
          <Link
            href="/commitments"
            className="rounded-pill px-3 py-2 text-sm font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            Volver
          </Link>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          <Panel className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className={chipClass(STATE_CHIP[c.state])}>{STATE_LABEL[c.state]}</span>
              {!c.source.confirmed && (
                <span className={chipClass('amber')}>Sin confirmar · no se está vigilando</span>
              )}
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field label="Vence">
                <span
                  className={clsx(
                    c.state === 'overdue'
                      ? 'text-rose'
                      : c.state === 'due_soon'
                        ? 'text-amber'
                        : 'text-ink',
                  )}
                >
                  {longDate(c.dueOn)}
                </span>
                <div className="mt-0.5 text-micro font-normal text-ink-faint">
                  {whenPhrase(c.daysLeft)}
                </div>
              </Field>
              <Field label="Responde">{c.owner ?? 'Sin asignar'}</Field>
              <Field label="Aviso">{c.noticeDays} días antes</Field>
              {c.amountCop != null && <Field label="Valor">{cop(c.amountCop)}</Field>}
              {c.vehiclePlate && <Field label="Vehículo">{c.vehiclePlate}</Field>}
              <Field label="Repetición">{RECURRENCE_LABEL[c.recurrence]}</Field>
            </div>

            {c.detail && (
              <p className="mt-4 border-t border-border pt-4 text-sm leading-relaxed text-ink-muted">
                {c.detail}
              </p>
            )}
          </Panel>

          {/* The evidence. */}
          <Panel className="p-5">
            <h2 className="text-sm font-semibold text-ink">De dónde salió esta fecha</h2>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Provenance
                source={c.source.label}
                readAt={stamp(c.source.readAt) ?? undefined}
                detail={c.source.confirmed ? undefined : 'sin confirmar'}
                tone={c.state === 'overdue' ? 'seal' : 'stamp'}
              />
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-muted">
              {sourceExplanation(c.source.kind, c.source.label, c.source.confirmed)}
            </p>
            {c.source.quote && (
              <blockquote className="mt-3 rounded-sm border-l-2 border-primary/30 bg-primary-soft/40 px-3 py-2.5">
                <div className="field-label">Frase citada del documento</div>
                <p className="mt-1 font-mono text-xs leading-relaxed text-ink">
                  «{c.source.quote}»
                </p>
              </blockquote>
            )}
            {c.source.documentId && (
              <Link
                href={`/kb?document=${c.source.documentId}`}
                className="mt-3 inline-block text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Abrir el documento en Brain Knowledge
              </Link>
            )}
            {row.confirmed_by && (
              <p className="mt-3 text-micro text-ink-faint">
                Confirmado el {stamp(row.confirmed_at)} — la persona que confirmó queda registrada
                con la fecha.
              </p>
            )}
          </Panel>

          {/* What Cortex has already said. */}
          <Panel className="p-5">
            <h2 className="text-sm font-semibold text-ink">Avisos de este vencimiento</h2>
            <p className="mt-1 text-xs text-ink-muted">
              Cada aviso sale una sola vez. Si un envío falla, se reintenta al día siguiente sin
              repetir el mensaje.
            </p>
            {thisOccurrence.length === 0 ? (
              <p className="mt-3 text-sm text-ink-muted">
                Todavía no ha salido ningún aviso para esta fecha.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-border">
                {thisOccurrence.map((n) => (
                  <li key={n.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-ink">
                        {NOTICE_LABEL[n.notice_kind] ?? n.notice_kind}
                      </div>
                      <div className="truncate text-micro text-ink-faint">
                        {n.recipient_email ?? 'sin destinatario'}
                        {n.delivery_note ? ` · ${n.delivery_note}` : ''}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="tabular text-xs text-ink">{shortDate(n.sent_on)}</div>
                      <div
                        className={clsx('text-micro', n.delivered ? 'text-emerald' : 'text-amber')}
                      >
                        {n.delivered ? 'entregado' : 'no salió'}
                        {n.acknowledged_at ? ' · visto' : ''}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {history.length > 0 && (
            <Panel className="p-5">
              <div className="flex items-center gap-2">
                <CalendarRange className="h-4 w-4 text-ink-faint" aria-hidden />
                <h2 className="text-sm font-semibold text-ink">Historia</h2>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                Las veces anteriores de este mismo compromiso. Cumplir uno nunca borra el anterior.
              </p>
              <ul className="mt-3 divide-y divide-border">
                {history.map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-3 py-2.5">
                    <Link
                      href={`/commitments/${h.id}`}
                      className="truncate text-sm text-ink hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      {STATE_LABEL[h.state] ?? h.state}
                      {h.met_note ? ` — ${h.met_note}` : ''}
                    </Link>
                    <span className="tabular shrink-0 text-xs text-ink-faint">
                      {shortDate(h.due_on)}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <div className="space-y-5">
          <DetailActions
            id={row.id}
            dueOn={row.due_on}
            closed={c.state === 'met' || c.state === 'dropped'}
            pending={!c.source.confirmed}
            quote={c.source.quote}
          />

          <Panel className="p-5">
            <h2 className="text-sm font-semibold text-ink">Calendario</h2>
            {row.calendar_event_id ? (
              <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                Hay un evento en el calendario de {c.owner ?? 'quien responde'} para el{' '}
                <span className="tabular">{shortDate(row.calendar_synced_due_on ?? c.dueOn)}</span>.
                Si cambias la fecha aquí, el evento se mueve solo; si lo marcas cumplido, el evento
                desaparece.
              </p>
            ) : (
              <p className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-ink-muted">
                <CalendarOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
                <span>
                  {row.calendar_error
                    ? `No se pudo crear el evento: ${row.calendar_error}`
                    : 'Sin evento todavía. Se crea cuando quien responde tenga Google conectado.'}
                </span>
              </p>
            )}
            <p className="mt-3 text-micro leading-snug text-ink-faint">
              La sincronización va en un solo sentido, de Cortex al calendario. Mover el evento en
              Google no cambia la fecha aquí: esta fecha tiene una fuente y arrastrar un evento no
              es una fuente.
            </p>
          </Panel>

          <Panel className="p-5">
            <h2 className="text-sm font-semibold text-ink">Ficha</h2>
            <dl className="mt-3 space-y-2.5 text-xs">
              <Row label="Tipo" value={KIND_LABEL[c.kind]} />
              <Row label="Registrado" value={stamp(row.created_at) ?? '—'} />
              {row.met_at && <Row label="Cumplido" value={stamp(row.met_at) ?? '—'} />}
              {row.dropped_reason && <Row label="Descartado" value={row.dropped_reason} />}
              <Row label="Escala a los" value={`${row.escalate_after_days} días de vencido`} />
            </dl>
          </Panel>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="tabular truncate text-right text-ink">{value}</dd>
    </div>
  );
}

function sourceExplanation(kind: string, label: string, confirmed: boolean): string {
  if (kind === 'system') {
    return `Esta fecha la reporta ${label} y quedó guardada con el momento exacto de la consulta. Cortex no la dedujo ni la calculó: es lo que dijo el sistema.`;
  }
  if (kind === 'document') {
    return confirmed
      ? `Cortex leyó esta fecha en "${label}" y una persona la confirmó comparándola con la frase de abajo. Sólo se vigila desde que alguien la confirmó.`
      : `Cortex propone esta fecha a partir de "${label}". No se está vigilando: no manda avisos ni aparece en los conteos hasta que alguien la confirme contra la frase de abajo.`;
  }
  return `Esta fecha la registró ${label} a mano. La fuente es su palabra, y por eso queda su nombre.`;
}
