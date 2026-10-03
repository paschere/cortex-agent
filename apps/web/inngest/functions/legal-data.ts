import { pool } from '@/lib/auth';
import { sendEmail } from '@/lib/email';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { type DataExportResult, expireDataExport, runDataExport } from '@/lib/legal/export-run';
import { runOrganizationPurge } from '@/lib/legal/purge-run';
import { notify } from '@/lib/notifications/notify';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import { logger } from '@cortex/core';

/**
 * LOS TRABAJOS DE LOS DERECHOS DEL TITULAR (migración 0188).
 *
 *   legal/export.run           arma el ZIP de una exportación y avisa (campana
 *                              + correo) con el enlace, que vence en 7 días.
 *   legal/organization.purge   purga una empresa cuya gracia venció (o un
 *                              espacio personal de quien borró su usuario).
 *                              Con `dryRun: true` es un simulacro que cuenta y
 *                              hace ROLLBACK.
 *   legal/dispatch             cron diario: vence los ZIP viejos y reparte las
 *                              purgas que tocan.
 *
 * UNSCOPED SÓLO EN EL CRON, para dos SELECT de ids: «qué borrados vencieron» y
 * «qué exportaciones caducaron» abarcan todo el install y detrás de un cron no
 * hay sesión. Cada id viaja en su propio evento; la exportación y la purga
 * nombran la empresa en cada sentencia (ver lib/legal/export-run.ts y
 * purge-run.ts).
 *
 * Reintentos: 0 para la purga (borra; un segundo intento sobre un estado a
 * medias lo decide una persona mirando el acta) y 1 para la exportación (es
 * idempotente: retoma una «generando» de más de 30 minutos).
 */

/** 04:30 en Bogotá: nadie trabajando y lejos de los demás cron de la hora. */
const LEGAL_DISPATCH_CRON = '30 9 * * *';

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const legalExportRunJob: JobHandler = async ({ event, step }) => {
  const exportId = event.data.exportId as string | undefined;
  if (!exportId) return { skipped: 'no export on the event' };
  const outcome = await step.run('build', () => runDataExport(exportId));
  if ('skipped' in outcome) return outcome;
  const result: DataExportResult = outcome;

  await step.run('notify', async () => {
    const href = workspaceHref(result.organizationId, '/settings/privacidad');
    const until = result.expiresAt.slice(0, 10);
    if (result.requestedBy) {
      await notify(getOrgScopedClient(result.organizationId), {
        userId: result.requestedBy,
        kind: 'management_attention',
        tone: 'info',
        title:
          result.scope === 'empresa'
            ? 'La exportación de los datos de la empresa está lista'
            : 'La exportación de tus datos está lista',
        body: `${formatBytes(result.bytes)}, ${result.tables} tablas y ${result.files} archivos. Descárgala desde Ajustes › Privacidad y datos antes del ${until}.`,
        href,
        dedupeKey: `legal-export:${result.exportId}`,
      });
    }
    const { rows } = await pool.query<{ email: string }>(
      'select email from public.ba_user where id = $1',
      [result.requestedByAccount],
    );
    const to = rows[0]?.email;
    if (to) {
      const base = (process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL ?? '').replace(
        /\/$/,
        '',
      );
      await sendEmail({
        to,
        subject: 'Tu exportación de datos de Cortex está lista',
        text: `Tu exportación (${formatBytes(result.bytes)}) está lista. Por seguridad la descarga exige iniciar sesión, y el enlace funciona hasta el ${until}:\n\n${base}${href}\n\nEl archivo contiene datos personales: guárdalo en un lugar seguro.`,
      });
    }
  });
  return result;
};

export const legalExportRun = inngest.createFunction(
  { id: 'legal-export-run', concurrency: { limit: 1 } },
  { event: 'legal/export.run' },
  async (ctx) => legalExportRunJob(ctx as unknown as JobContext),
);

export const legalOrganizationPurgeJob: JobHandler = async ({ event, step }) => {
  const deletionId = event.data.deletionId as string | undefined;
  if (!deletionId) return { skipped: 'no deletion on the event' };
  const dryRun = event.data.dryRun === true;
  const result = await step.run('purge', () => runOrganizationPurge(deletionId, { dryRun }));
  if ('skipped' in result || result.dryRun) return result;

  await step.run('notify', async () => {
    const { rows } = await pool.query<{
      requested_by_email: string;
      organization_name: string;
      reason: string;
    }>(
      'select requested_by_email, organization_name, reason from public.organization_deletions where id = $1',
      [deletionId],
    );
    const row = rows[0];
    if (!row || row.reason !== 'empresa') return;
    const total = Object.values(result.deleted).reduce((n, v) => n + v, 0);
    await sendEmail({
      to: row.requested_by_email,
      subject: `Eliminamos los datos de ${row.organization_name} en Cortex`,
      text: `Terminamos de eliminar la empresa «${row.organization_name}»: ${total} registros en ${Object.keys(result.deleted).length} tablas, sus archivos y ${result.memberships} membresías. Las conexiones con Google se revocaron (${result.revoked?.googleRevoked ?? 0}); las de otros proveedores se borraron de nuestra base y puedes quitarles el permiso desde cada proveedor.\n\nGuardamos sólo un acta mínima del borrado (empresa, fecha y quién lo pidió) como prueba de que se atendió.`,
    });
  });
  return result;
};

export const legalOrganizationPurge = inngest.createFunction(
  { id: 'legal-organization-purge', concurrency: { limit: 1 } },
  { event: 'legal/organization.purge' },
  async (ctx) => legalOrganizationPurgeJob(ctx as unknown as JobContext),
);

export const legalDispatchJob: JobHandler = async ({ step }) => {
  const db = getSupabaseServiceClient();
  const expired = await step.run('expire-exports', async () => {
    const { data, error } = await db
      .from('data_exports')
      .select('id')
      .eq('status', 'lista')
      .lt('expires_at', new Date().toISOString())
      .limit(200);
    if (error) throw new Error(`data_exports: ${error.message}`);
    let n = 0;
    for (const row of (data ?? []) as { id: string }[]) {
      if (await expireDataExport(row.id)) n++;
    }
    return n;
  });

  const due = await step.run('due-deletions', async () => {
    const { data, error } = await db
      .from('organization_deletions')
      .select('id')
      .eq('status', 'programada')
      .lte('purge_after', new Date().toISOString())
      .order('purge_after', { ascending: true })
      .limit(20);
    if (error) throw new Error(`organization_deletions: ${error.message}`);
    return ((data ?? []) as { id: string }[]).map((r) => r.id);
  });

  if (due.length > 0) {
    await step.sendEvent(
      'legal-purges',
      due.map((deletionId) => ({ name: 'legal/organization.purge', data: { deletionId } })),
    );
  }
  logger.info('legal dispatch', { expired, purges: due.length });
  return { expired, purges: due.length };
};

export const legalDispatch = inngest.createFunction(
  { id: 'legal-dispatch' },
  { cron: LEGAL_DISPATCH_CRON },
  async (ctx) => legalDispatchJob(ctx as unknown as JobContext),
);
