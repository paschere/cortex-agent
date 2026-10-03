import 'server-only';
import { pool } from '@/lib/auth';
import { logger } from '@cortex/core';
import type { PoolClient } from 'pg';
import { safeIdentifier } from './export-plan';
import { type RevokeReport, revokeIntegrations } from './oauth-revoke';
import { type ForeignKey, type PurgePlan, planPurge, purgeTables } from './purge-plan';

/**
 * LA PURGA: BORRAR UNA EMPRESA ENTERA, DE VERDAD.
 *
 * Corre cuando vence la gracia de `organization_deletions` (30 días) o, para el
 * espacio personal de quien borra su usuario, enseguida. En este orden:
 *
 *   1. Reclama la fila (programada → purgando), para que dos trabajos no
 *      purguen a la vez.
 *   2. Revoca en Google las conexiones de la empresa (lib/legal/oauth-revoke.ts).
 *      Fuera de la transacción: es una llamada de red, y si falla el dato se
 *      borra igual.
 *   3. En UNA transacción: borra tabla por tabla en el orden de purge-plan.ts
 *      (hijas antes que madres, según las llaves reales de la base), luego las
 *      invitaciones, las membresías (el trigger de la 0138 hace la salida segura
 *      de cada persona), suelta las sesiones que apuntaban aquí y, al final, la
 *      fila de la empresa.
 *   4. Escribe el acta (organization_deletions.report) con cuántas filas salieron
 *      de cada tabla. El acta no tiene llave foránea a la empresa: sobrevive.
 *
 * SIMULACRO (dryRun). Hace exactamente lo mismo y termina en ROLLBACK: cuenta
 * las filas reales y demuestra que el orden pasa las llaves foráneas de ESTA
 * base, sin borrar nada. No revoca tokens ni cambia el estado de la fila.
 *
 * Las cuentas de las personas (ba_user) NO se borran: son de cada quien, no de
 * la empresa. Pierden la membresía; cada persona puede borrar su usuario desde
 * Ajustes › Privacidad y datos.
 *
 * pg directo por la misma razón que export-run.ts: una transacción que abarca
 * decenas de tablas no existe en PostgREST. Cada sentencia nombra la empresa.
 */

interface DeletionRow {
  id: string;
  organization_id: string;
  organization_name: string;
  requested_by_email: string;
  status: string;
}

export interface PurgeResult {
  deletionId: string;
  organizationId: string;
  dryRun: boolean;
  deleted: Record<string, number>;
  order: string[];
  brokenCycles: string[][];
  revoked: RevokeReport | null;
  memberships: number;
}

async function loadForeignKeys(client: PoolClient): Promise<ForeignKey[]> {
  const { rows } = await client.query<{ child: string; parent: string; on_delete: string }>(
    `select c.relname as child, p.relname as parent, k.confdeltype as on_delete
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_class p on p.oid = k.confrelid
       join pg_namespace n on n.oid = c.relnamespace
      where k.contype = 'f' and n.nspname = 'public'`,
  );
  return rows.map((r) => ({
    child: r.child,
    parent: r.parent,
    onDelete: r.on_delete as ForeignKey['onDelete'],
  }));
}

async function tablesWithOrgColumn(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `select c.table_name from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'organization_id'
        and t.table_type = 'BASE TABLE'`,
  );
  return rows.map((r) => r.table_name);
}

async function existingTables(client: PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  return new Set(rows.map((r) => r.table_name));
}

/** El plan para una base concreta: lo que el registro dice más lo que la base revela. */
export async function buildPurgePlan(client: PoolClient): Promise<PurgePlan> {
  const [discovered, fks, present] = await Promise.all([
    tablesWithOrgColumn(client),
    loadForeignKeys(client),
    existingTables(client),
  ]);
  const steps = purgeTables(undefined, discovered).filter((s) => present.has(s.table));
  return planPurge(steps, fks);
}

async function purgeInside(
  client: PoolClient,
  organizationId: string,
): Promise<{
  deleted: Record<string, number>;
  order: string[];
  brokenCycles: string[][];
  memberships: number;
}> {
  const plan = await buildPurgePlan(client);
  const deleted: Record<string, number> = {};
  for (const step of plan.order) {
    const table = safeIdentifier(step.table);
    let sql: string;
    if (step.kind === 'derived' && step.parent && step.parentKey) {
      sql = `delete from public.${table} where ${safeIdentifier(step.parentKey)} in (select id from public.${safeIdentifier(step.parent)} where organization_id = $1)`;
    } else {
      sql = `delete from public.${table} where organization_id = $1`;
    }
    const res = await client.query(sql, [organizationId]);
    if ((res.rowCount ?? 0) > 0) deleted[step.table] = res.rowCount ?? 0;
  }
  await client.query('delete from public.ba_invitation where "organizationId" = $1', [
    organizationId,
  ]);
  const members = await client.query('delete from public.ba_member where "organizationId" = $1', [
    organizationId,
  ]);
  await client.query(
    'update public.ba_session set "activeOrganizationId" = null where "activeOrganizationId" = $1',
    [organizationId],
  );
  await client.query('delete from public.ba_organization where id = $1', [organizationId]);
  return {
    deleted,
    order: plan.order.map((s) => s.table),
    brokenCycles: plan.brokenCycles,
    memberships: members.rowCount ?? 0,
  };
}

/**
 * Purga (o simula) el borrado nombrado. Sólo purga si está programado y venció
 * la gracia; el simulacro corre en cualquier estado no terminal.
 */
export async function runOrganizationPurge(
  deletionId: string,
  options: { dryRun?: boolean } = {},
): Promise<PurgeResult | { skipped: string }> {
  const dryRun = options.dryRun === true;

  let row: DeletionRow | undefined;
  if (dryRun) {
    const r = await pool.query<DeletionRow>(
      `select id, organization_id, organization_name, requested_by_email, status
         from public.organization_deletions where id = $1 and status in ('programada', 'fallida')`,
      [deletionId],
    );
    row = r.rows[0];
  } else {
    const r = await pool.query<DeletionRow>(
      `update public.organization_deletions
          set status = 'purgando', purge_started_at = now(), error = null
        where id = $1
          and (status = 'programada' or status = 'fallida')
          and purge_after <= now()
        returning id, organization_id, organization_name, requested_by_email, status`,
      [deletionId],
    );
    row = r.rows[0];
  }
  if (!row) return { skipped: 'no está programado o no ha vencido la gracia' };

  const client = await pool.connect();
  try {
    let revoked: RevokeReport | null = null;
    if (!dryRun) {
      revoked = await revokeIntegrations(client, 'i.organization_id = $1', [row.organization_id]);
    }
    await client.query('begin');
    await client.query("set local statement_timeout = '10min'");
    const inside = await purgeInside(client, row.organization_id);
    if (dryRun) await client.query('rollback');
    else await client.query('commit');

    const result: PurgeResult = {
      deletionId: row.id,
      organizationId: row.organization_id,
      dryRun,
      deleted: inside.deleted,
      order: inside.order,
      brokenCycles: inside.brokenCycles,
      revoked,
      memberships: inside.memberships,
    };
    if (!dryRun) {
      await pool.query(
        `update public.organization_deletions
            set status = 'purgada', purged_at = now(), report = $2
          where id = $1`,
        [
          row.id,
          JSON.stringify({
            deleted: result.deleted,
            memberships: result.memberships,
            revoked: result.revoked,
            brokenCycles: result.brokenCycles,
          }),
        ],
      );
    }
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    logger.error('legal: falló la purga de una empresa', { deletionId, dryRun, error: message });
    if (!dryRun) {
      await pool.query(
        `update public.organization_deletions set status = 'fallida', error = $2 where id = $1`,
        [deletionId, message.slice(0, 2000)],
      );
    }
    throw err;
  } finally {
    client.release();
  }
}
