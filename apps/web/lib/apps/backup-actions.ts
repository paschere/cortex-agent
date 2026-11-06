'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type BackupSummary,
  createBackup,
  describeTableRestore,
  diffAgainstToday,
  listBackups,
  mustGetApp,
  planTableRestore,
  previewRowRestore,
  previewTableRestore,
  readBackup,
  restoreCode,
  restoreConfig,
  restoreRow,
  restoreTable,
  viewerFromSession,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { buildAuditDetail } from '@cortex/agent-tools/src/audit-detail';
import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * Acciones de la pestaña «Copias» del editor de una app (0247). Todas son de
 * quien administra la empresa y todo lo que restaura queda en /actividad (con
 * el mismo `tool_id` que las herramientas del chat, así se lee igual).
 */

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function describe(err: unknown, fallback: string): string {
  if (
    err instanceof ValidationError ||
    err instanceof NotFoundError ||
    err instanceof ForbiddenError
  )
    return err.message;
  return fallback;
}

async function admin() {
  const user = await requireSession();
  if (!viewerFromSession(user).companyAdmin)
    throw new ForbiddenError('Sólo quien administra la empresa puede ver y restaurar copias.');
  return { user, db: getOrgScopedClient(user.organization.id) };
}

async function audit(
  ctx: Awaited<ReturnType<typeof admin>>,
  toolId: string,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  started: number,
) {
  await writeAuditEvent({
    db: ctx.db,
    userId: ctx.user.id,
    toolId,
    input,
    status: 'ok',
    latencyMs: Date.now() - started,
    surface: 'web',
    decision: 'allowed',
    metadata: { detail: buildAuditDetail({ input, output }) },
  });
}

function touched(app: { id: string; slug: string }) {
  revalidatePath(`/apps/${app.id}/edit`);
  revalidatePath(`/apps/${app.slug}`);
}

export async function listBackupsAction(
  appId: string,
): Promise<Result<{ backups: BackupSummary[] }>> {
  try {
    const { db } = await admin();
    return { ok: true, backups: await listBackups(db, appId, 100) };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron leer las copias.') };
  }
}

export async function createBackupAction(
  appId: string,
  reason: string,
): Promise<Result<{ backup: BackupSummary }>> {
  try {
    const ctx = await admin();
    const started = Date.now();
    const app = await mustGetApp(ctx.db, appId);
    const backup = await createBackup(ctx.db, app.id, {
      kind: 'manual',
      reason: reason.trim().slice(0, 300),
      userId: ctx.user.id,
    });
    await audit(
      ctx,
      'apps.backup_create',
      { app: app.id, appName: app.name },
      { id: backup.id },
      started,
    );
    return { ok: true, backup };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo hacer la copia.') };
  }
}

export interface TableDiffView {
  slug: string;
  /** Filas que la copia tenía y hoy no existen. */
  removed: { count: number; sample: Array<{ id: string; label: string }> };
  /** Filas que cambiaron desde la copia. */
  changed: {
    count: number;
    sample: Array<{
      id: string;
      label: string;
      changes: Array<{ field: string; was: string; now: string }>;
    }>;
  };
  /** Filas nuevas desde la copia. */
  added: { count: number; sample: Array<{ id: string; label: string }> };
  unchanged: number;
  truncated: boolean;
  /** Frase de lo que haría restaurar la tabla entera. */
  restoreText: string;
}

export interface BackupDetailView {
  backup: BackupSummary;
  warnings: string[];
  tables: TableDiffView[];
  appDbTables: Array<{ name: string; rows: number; truncated: boolean }>;
  config: {
    screens: number;
    roles: number;
    automations: number;
    screensChanged: string[];
    rolesChanged: string[];
    automationsChanged: number;
  };
  code: {
    files: number;
    added: string[];
    removed: string[];
    changed: string[];
    secretNames: string[];
  } | null;
}

const SAMPLE = 25;
const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '(vacío)';
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
};

export async function backupDetailAction(
  appId: string,
  backupId: string,
): Promise<Result<{ detail: BackupDetailView }>> {
  try {
    const { db } = await admin();
    const { summary, content } = await readBackup(db, appId, backupId);
    const diff = await diffAgainstToday(db, appId, backupId);
    const tables = diff.tables.map<TableDiffView>((t) => ({
      slug: t.slug,
      removed: { count: t.removed.length, sample: t.removed.slice(0, SAMPLE) },
      changed: {
        count: t.changed.length,
        sample: t.changed.slice(0, SAMPLE).map((c) => ({
          id: c.id,
          label: c.label,
          changes: c.changes
            .slice(0, 6)
            .map((x) => ({ field: x.field, was: show(x.was), now: show(x.now) })),
        })),
      },
      added: { count: t.added.length, sample: t.added.slice(0, SAMPLE) },
      unchanged: t.unchanged,
      truncated: t.truncated,
      restoreText: describeTableRestore(t.slug, planTableRestore(t)),
    }));
    return {
      ok: true,
      detail: {
        backup: summary,
        warnings: content.warnings,
        tables,
        appDbTables: Object.entries(content.appDb?.tables ?? {}).map(([name, t]) => ({
          name,
          rows: t.total,
          truncated: t.truncated,
        })),
        config: {
          screens: content.config.snapshot.screens.length,
          roles: content.config.snapshot.roles.length,
          automations: content.config.automations.length,
          ...diff.config,
        },
        code: content.code
          ? {
              files: Object.keys(content.code.files).length,
              ...(diff.code ?? { added: [], removed: [], changed: [] }),
              secretNames: content.code.secretNames,
            }
          : null,
      },
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo abrir la copia.') };
  }
}

/** Qué cambiaría al restaurar una fila: el texto de la confirmación. */
export async function previewRowRestoreAction(
  appId: string,
  backupId: string,
  table: string,
  rowId: string,
): Promise<Result<{ text: string }>> {
  try {
    const { db } = await admin();
    return { ok: true, text: (await previewRowRestore(db, appId, backupId, table, rowId)).text };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo revisar la fila.') };
  }
}

export async function previewTableRestoreAction(
  appId: string,
  backupId: string,
  table: string,
): Promise<Result<{ text: string }>> {
  try {
    const { db } = await admin();
    return { ok: true, text: (await previewTableRestore(db, appId, backupId, table)).text };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo revisar la tabla.') };
  }
}

export async function restoreRowAction(
  appId: string,
  backupId: string,
  table: string,
  rowId: string,
): Promise<Result<{ message: string }>> {
  try {
    const ctx = await admin();
    const started = Date.now();
    const app = await mustGetApp(ctx.db, appId);
    const out = await restoreRow(ctx.db, app.id, backupId, table, rowId, { userId: ctx.user.id });
    await audit(
      ctx,
      'apps.backup_restore_row',
      { app: app.id, appName: app.name, backup: backupId, table, rowId },
      { action: out.action, safetyBackupId: out.safetyBackupId },
      started,
    );
    touched(app);
    return { ok: true, message: `${out.done.join(' ')} Antes dejé una copia.` };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo restaurar la fila.') };
  }
}

export async function restoreTableAction(
  appId: string,
  backupId: string,
  table: string,
): Promise<Result<{ message: string }>> {
  try {
    const ctx = await admin();
    const started = Date.now();
    const app = await mustGetApp(ctx.db, appId);
    const out = await restoreTable(ctx.db, app.id, backupId, table, { userId: ctx.user.id });
    await audit(
      ctx,
      'apps.backup_restore_table',
      { app: app.id, appName: app.name, backup: backupId, table },
      { ...out.plan, safetyBackupId: out.safetyBackupId },
      started,
    );
    touched(app);
    return {
      ok: true,
      message: `${[...out.done, ...out.skipped].join(' ')} Antes dejé una copia.`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo restaurar la tabla.') };
  }
}

export async function restoreConfigAction(
  appId: string,
  backupId: string,
): Promise<Result<{ message: string }>> {
  try {
    const ctx = await admin();
    const started = Date.now();
    const app = await mustGetApp(ctx.db, appId);
    const out = await restoreConfig(ctx.db, app.id, backupId, { userId: ctx.user.id });
    await audit(
      ctx,
      'apps.backup_restore_config',
      { app: app.id, appName: app.name, backup: backupId },
      { done: out.done.length, skipped: out.skipped.length, safetyBackupId: out.safetyBackupId },
      started,
    );
    touched(app);
    return {
      ok: true,
      message: `Configuración restaurada en el borrador: ${out.done.join(', ')}.${out.skipped.length ? ` No pude devolver: ${out.skipped.join(' · ')}` : ''} Publica para que la vean los usuarios.`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo restaurar la configuración.') };
  }
}

export async function restoreCodeAction(
  appId: string,
  backupId: string,
): Promise<Result<{ message: string }>> {
  try {
    const ctx = await admin();
    const started = Date.now();
    const app = await mustGetApp(ctx.db, appId);
    const out = await restoreCode(ctx.db, app.id, backupId, { userId: ctx.user.id });
    await audit(
      ctx,
      'apps.backup_restore_code',
      { app: app.id, appName: app.name, backup: backupId },
      { safetyBackupId: out.safetyBackupId },
      started,
    );
    touched(app);
    return { ok: true, message: `${out.done.join(', ')}. ${out.skipped.join(' ')}` };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo restaurar el código.') };
  }
}
