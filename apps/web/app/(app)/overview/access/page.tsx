import { FounderTabs } from '@/components/overview/FounderTabs';
import { PageHeader } from '@/components/ui/page-header';
import {
  ACCESS_REQUEST_STATUS_LABEL,
  type AccessRequestStatus,
} from '@/lib/billing/access-request-shape';
import { listAccessRequests } from '@/lib/billing/access-requests';
import { signupMode } from '@/lib/billing/config';
import { isPlatformOperator } from '@/lib/billing/operators';
import { requireFounderContext } from '@/lib/founder-guard';
import { stamp } from '@/lib/plan-shape';
import { chipClass } from '@/lib/status-chip';
import { Inbox } from 'lucide-react';
import { notFound } from 'next/navigation';
import { AccessRequestActions } from './AccessRequestActions';

export const dynamic = 'force-dynamic';

/**
 * /overview/access — las solicitudes de «Pide tu acceso».
 *
 * Vive junto a la consola del fundador porque es donde ya se administran
 * empresas, pero NO es del fundador: la ve sólo quien opera la plataforma
 * (`ba_user.role = 'admin'` o PLATFORM_OPERATOR_EMAILS; ver
 * lib/billing/operators.ts). A cualquier otra cuenta le responde 404, igual que
 * /admin a quien no administra.
 */

const TONE: Record<AccessRequestStatus, 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose'> = {
  pending: 'amber',
  approved: 'primary',
  rejected: 'neutral',
  signed_up: 'emerald',
};

export default async function AccessRequestsPage() {
  const context = await requireFounderContext();
  if (!(await isPlatformOperator(context.accountId))) notFound();
  const requests = await listAccessRequests();
  const pending = requests.filter((r) => r.status === 'pending').length;
  const mode = signupMode();

  return (
    <>
      <PageHeader
        title="Solicitudes de acceso"
        subtitle={
          pending > 0
            ? `${pending} por revisar. Al aprobar sale un código personal de un solo uso.`
            : 'Quién pidió entrar a Cortex y qué se decidió.'
        }
        icon={<Inbox className="h-5 w-5" />}
      />
      <FounderTabs current="access" showPeople={context.owned.length > 0} showAccess />
      {mode !== 'request' && (
        <p className="mb-4 rounded-sm border border-border bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-ink-muted">
          El registro está en modo «{mode === 'open' ? 'abierto' : 'por invitación'}»: el formulario
          público /acceso no recibe solicitudes nuevas. Se activa con SIGNUP_MODE=request.
        </p>
      )}
      {requests.length === 0 ? (
        <div className="rounded-card border border-dashed border-border px-6 py-12 text-center text-sm text-ink-muted">
          Todavía no hay solicitudes.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-surface">
          {requests.map((request) => (
            <li key={request.id} className="space-y-2 px-5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-sm font-semibold text-ink">{request.name}</span>
                  <span className="text-sm text-ink-muted"> · {request.company}</span>
                </div>
                <span className={chipClass(TONE[request.status])}>
                  {ACCESS_REQUEST_STATUS_LABEL[request.status]}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-muted">
                <span>{request.email}</span>
                {request.phone && <span>{request.phone}</span>}
                <span className="font-sans text-ink-faint">{stamp(request.createdAt)}</span>
              </div>
              {request.message && (
                <p className="whitespace-pre-line text-sm leading-relaxed text-ink">
                  {request.message}
                </p>
              )}
              {request.reviewedAt && (
                <p className="text-xs text-ink-faint">
                  Revisada el {stamp(request.reviewedAt)}
                  {request.reviewerEmail ? ` por ${request.reviewerEmail}` : ''}
                  {request.codeExpiresAt && request.status === 'approved'
                    ? ` · el código vence el ${stamp(request.codeExpiresAt)}`
                    : ''}
                  {request.reviewNote ? ` · ${request.reviewNote}` : ''}
                </p>
              )}
              {(request.status === 'pending' || request.status === 'approved') && (
                <AccessRequestActions id={request.id} approved={request.status === 'approved'} />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
