import 'server-only';
import { pool } from '@/lib/auth';
import { type DeletionBlocker, type Membership, classifyMemberships } from './memberships';
import {
  type RevokeReport,
  mergeRevokeReports,
  revokeIntegrations,
  revokeLoginGrant,
} from './oauth-revoke';

export { classifyMemberships, type DeletionBlocker, type Membership } from './memberships';

/**
 * «ELIMINAR MI USUARIO», DEJANDO LOS DATOS DE LA EMPRESA.
 *
 * El derecho de supresión (Ley 1581 art. 8 e) aplicado a la cuenta de una
 * persona que trabaja en una o varias empresas. Lo que pasa, en orden:
 *
 *   ANTES DE NADA, LOS BLOQUEOS. Si es la única dueña de una empresa donde hay
 *   más gente, no se puede: la empresa quedaría sin quien la administre. Tiene
 *   que nombrar otra dueña o eliminar la empresa primero. Se le dice cuáles.
 *
 *   1. Revoca en Google sus conexiones (las de `integrations` en todos sus
 *      espacios y el permiso del inicio de sesión con Google).
 *   2. Los espacios donde es la ÚNICA persona (su espacio personal) se programan
 *      para purga inmediata (`organization_deletions`, motivo cuenta_personal):
 *      ahí todo era suyo.
 *   3. En una transacción:
 *      a. borra sus membresías — el trigger de la 0138 hace la salida segura en
 *         cada empresa (pausa sus rutinas, borra sus credenciales, sus tokens
 *         MCP, sus vínculos de Chat);
 *      b. borra lo que es sólo suyo en las empresas que siguen: sus memorias
 *         (`user_memories`) y sus preferencias (`user_preferences`);
 *      c. ANONIMIZA su fila del directorio en esas empresas: el nombre pasa a
 *         «Persona eliminada» y el correo a una dirección que no existe. Las
 *         conversaciones, informes y aprobaciones de la empresa siguen
 *         diciendo «lo hizo alguien» sin decir quién — la misma decisión de la
 *         0138 (el historial de la empresa no se rompe) llevada hasta el final
 *         que exige la supresión;
 *      d. deja constancia en `legal_requests` (supresión, respondida) con el
 *         correo, que es la prueba de que se atendió;
 *      e. borra la cuenta (ba_user): arrastra sesiones, accesos, 2FA y
 *         autorizaciones.
 *
 * QUÉ NO BORRA: el contenido que la persona creó DENTRO de una empresa
 * (documentos, mensajes en conversaciones compartidas, facturas). Es de la
 * empresa, que es responsable de esos datos; si la persona quiere que se
 * borre algo de eso, es un reclamo ante la empresa. Eso lo dice la pantalla.
 */

export async function listMemberships(accountId: string): Promise<Membership[]> {
  const { rows } = await pool.query<{
    organization_id: string;
    organization_name: string;
    role: string;
    members: string;
    owners: string;
  }>(
    `select m."organizationId" as organization_id, o.name as organization_name, m.role,
            (select count(*) from public.ba_member x where x."organizationId" = m."organizationId") as members,
            (select count(*) from public.ba_member x
              where x."organizationId" = m."organizationId" and x.role = 'owner') as owners
       from public.ba_member m
       join public.ba_organization o on o.id = m."organizationId"
      where m."userId" = $1`,
    [accountId],
  );
  return rows.map((r) => ({
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    role: r.role,
    members: Number(r.members),
    owners: Number(r.owners),
  }));
}

export type AccountDeletionResult =
  | {
      ok: true;
      revoked: RevokeReport;
      soloWorkspaces: string[];
      /** Purgas programadas sin gracia: quien llama las encola. */
      deletionIds: string[];
      anonymized: number;
    }
  | { ok: false; blockers: DeletionBlocker[] };

export async function deleteAccount(input: {
  accountId: string;
  email: string;
  name: string | null;
}): Promise<AccountDeletionResult> {
  const memberships = await listMemberships(input.accountId);
  const { blockers, solo } = classifyMemberships(memberships);
  if (blockers.length > 0) return { ok: false, blockers };

  const client = await pool.connect();
  try {
    // 1. Revocar afuera, antes de borrar las filas que tienen los tokens.
    const revoked = mergeRevokeReports(
      await revokeIntegrations(
        client,
        `i.user_id in (select d.id from public.users d
                         join public.ba_user b on lower(b.email) = lower(d.email)
                        where b.id = $1)`,
        [input.accountId],
      ),
      await revokeLoginGrant(client, input.accountId),
    );

    await client.query('begin');
    // 2. Su espacio personal (y cualquier otro donde esté sola): purga sin gracia.
    const deletionIds: string[] = [];
    for (const m of solo) {
      const scheduled = await client.query<{ id: string }>(
        `insert into public.organization_deletions
           (organization_id, organization_name, requested_by_account, requested_by_email,
            reason, purge_after)
         values ($1, $2, $3, $4, 'cuenta_personal', now())
         on conflict (organization_id) where status in ('programada', 'purgando') do nothing
         returning id`,
        [m.organizationId, m.organizationName, input.accountId, input.email],
      );
      for (const r of scheduled.rows) deletionIds.push(r.id);
    }
    // 3a. Salida segura en cada empresa (trigger de la 0138).
    await client.query('delete from public.ba_member where "userId" = $1', [input.accountId]);

    // 3b–c. Lo suyo fuera, y su nombre fuera del directorio de las que siguen.
    const soloIds = solo.map((m) => m.organizationId);
    const directory = await client.query<{ id: string }>(
      `select id from public.users
        where lower(email) = lower($1) and not (organization_id = any($2::text[]))`,
      [input.email, soloIds],
    );
    const ids = directory.rows.map((r) => r.id);
    if (ids.length > 0) {
      await client.query('delete from public.user_memories where user_id = any($1::uuid[])', [ids]);
      await client.query('delete from public.user_preferences where user_id = any($1::uuid[])', [
        ids,
      ]);
      await client.query(
        `update public.users
            set name = 'Persona eliminada',
                email = 'eliminado-' || id::text || '@cortex.invalid'
          where id = any($1::uuid[])`,
        [ids],
      );
    }

    // 3d. La constancia, que sobrevive a la cuenta (user_id → null).
    const today = new Date().toISOString().slice(0, 10);
    await client.query(
      `insert into public.legal_requests
         (user_id, requester_email, requester_name, kind, right_invoked, message, status,
          due_on, response, responded_at)
       values ($1, $2, $3, 'reclamo', 'suprimir',
               'Supresión de la cuenta solicitada por autoservicio en Ajustes › Privacidad y datos.',
               'respondida', $4,
               'Cuenta eliminada por autoservicio. Conexiones revocadas, directorio anonimizado y espacios personales programados para purga.',
               now())`,
      [input.accountId, input.email, input.name, today],
    );

    // 3e. La cuenta.
    await client.query('delete from public.ba_user where id = $1', [input.accountId]);
    await client.query('commit');
    return {
      ok: true,
      revoked,
      soloWorkspaces: soloIds,
      deletionIds,
      anonymized: ids.length,
    };
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
