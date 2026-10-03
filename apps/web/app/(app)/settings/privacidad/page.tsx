import { PageHeader } from '@/components/ui/page-header';
import { classifyMemberships, listMemberships } from '@/lib/legal/account-deletion';
import { currentAccount, listConsentDetails } from '@/lib/legal/consent-store';
import { bogotaDate, businessDaysLeft } from '@/lib/legal/deadlines';
import { canDeleteCompany, canExportCompany } from '@/lib/legal/permissions';
import { listLegalRequests } from '@/lib/legal/requests-store';
import { LEGAL_DOCUMENT_VERSIONS } from '@/lib/legal/versions';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';
import { ShieldCheck } from 'lucide-react';
import {
  type ConsentView,
  type DeletionView,
  type ExportView,
  PrivacyControls,
  type RequestView,
} from './PrivacyControls';

export const dynamic = 'force-dynamic';

/**
 * /settings/privacidad — «Privacidad y datos»: los derechos del titular en
 * autoservicio (Ley 1581 art. 8). Todo lo que se lee aquí se lee por el id de
 * la sesión o con el handle de su empresa; no hay ids en la URL.
 *
 * Cada lectura falla por separado: si una tabla no responde, esa sección dice
 * que no pudo cargar y las demás siguen — un derecho que no se puede ejercer
 * porque OTRO falló sería el peor resultado.
 */

async function settle<T>(label: string, p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    logger.error(`privacidad: no se pudo leer ${label}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export default async function PrivacySettingsPage() {
  const user = await requireSession();
  const account = await currentAccount();
  if (!account) throw new Error('Sesión sin cuenta');
  const db = getOrgScopedClient(user.organization.id);
  const role = user.organization.role;

  const [consents, requests, memberships, exportsRes, deletionRes] = await Promise.all([
    settle('autorizaciones', listConsentDetails(account.id)),
    settle('solicitudes', listLegalRequests(account.id)),
    settle('membresías', listMemberships(account.id)),
    settle(
      'exportaciones',
      (async () => {
        let q = db
          .from('data_exports')
          .select(
            'id, scope, status, size_bytes, created_at, expires_at, error, requested_by_account',
          )
          .order('created_at', { ascending: false })
          .limit(10);
        if (!canExportCompany(role)) q = q.eq('requested_by_account', account.id);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return (data ?? []) as Array<Record<string, unknown>>;
      })(),
    ),
    settle(
      'borrado',
      (async () => {
        const { data, error } = await db
          .from('organization_deletions')
          .select('id, status, requested_at, purge_after, requested_by_email')
          .in('status', ['programada', 'purgando'])
          .maybeSingle();
        if (error) throw new Error(error.message);
        return { row: data as Record<string, unknown> | null };
      })(),
    ),
  ]);

  const today = bogotaDate(new Date());
  const consentViews: ConsentView[] | null =
    consents?.map((c) => ({
      document: c.document,
      version: c.version,
      acceptedAt: new Date(c.accepted_at).toISOString(),
      source: c.source,
      revokedAt: c.revoked_at ? new Date(c.revoked_at).toISOString() : null,
      current:
        LEGAL_DOCUMENT_VERSIONS[c.document as keyof typeof LEGAL_DOCUMENT_VERSIONS] === c.version,
    })) ?? null;

  const requestViews: RequestView[] | null =
    requests?.map((r) => {
      const due = r.extended_due_on ?? r.due_on;
      return {
        id: r.id,
        kind: r.kind,
        right: r.right_invoked,
        message: r.message,
        status: r.status,
        receivedAt: new Date(r.received_at).toISOString(),
        dueOn: due,
        businessDaysLeft: businessDaysLeft(today, due),
        response: r.response,
      };
    }) ?? null;

  const exportViews: ExportView[] | null =
    exportsRes?.map((e) => ({
      id: e.id as string,
      scope: e.scope as 'empresa' | 'personal',
      status: e.status as string,
      sizeBytes: (e.size_bytes as number | null) ?? null,
      createdAt: e.created_at as string,
      expiresAt: (e.expires_at as string | null) ?? null,
      error: (e.error as string | null) ?? null,
      mine: e.requested_by_account === account.id,
    })) ?? null;

  const live = deletionRes?.row ?? null;
  const deletion: DeletionView | null = live
    ? {
        status: live.status as string,
        requestedAt: live.requested_at as string,
        purgeAfter: live.purge_after as string,
        requestedBy: live.requested_by_email as string,
      }
    : null;

  const classified = memberships ? classifyMemberships(memberships) : null;

  return (
    <>
      <PageHeader
        title="Privacidad y datos"
        subtitle="Descarga o borra tus datos, revisa tus autorizaciones y ejerce tus derechos (Ley 1581 de 2012)"
        icon={<ShieldCheck className="h-5 w-5" />}
      />
      <PrivacyControls
        email={account.email}
        organizationName={user.organization.name}
        canExportCompany={canExportCompany(role)}
        canDeleteCompany={canDeleteCompany(role)}
        consents={consentViews}
        requests={requestViews}
        exports={exportViews}
        deletion={deletion}
        deletionLoadFailed={deletionRes === null}
        accountPreview={
          classified
            ? {
                blockers: classified.blockers.map((b) => b.organizationName),
                solo: classified.solo.map((m) => m.organizationName),
                shared: classified.shared.map((m) => m.organizationName),
              }
            : null
        }
      />
    </>
  );
}
