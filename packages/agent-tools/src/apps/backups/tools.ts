import { ForbiddenError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCompanyManager } from '../../directory/store';
import { registerTool } from '../../index';
import { mustGetApp } from '../store';
import { BACKUP_KIND_LABEL } from './shape';
import {
  assertBackupAdmin,
  createBackup,
  diffAgainstToday,
  listBackups,
  previewTableRestore,
  restoreRow,
  restoreTable,
} from './store';

/**
 * Copias de una app desde el chat (migración 0247). Listar y hacer copias es
 * de owner/admin; restaurar además pide confirmación como las demás
 * herramientas que cambian datos, y SIEMPRE deja antes una copia «antes de
 * restaurar». Restaurar una configuración o el código es del editor (pestaña
 * «Copias»), donde se ve qué cambia.
 */

async function requireAdmin(ctx: { db: SupabaseClient; userId: string }): Promise<void> {
  if (!(await isCompanyManager(ctx.db, ctx.userId)))
    throw new ForbiddenError(
      'Sólo quien administra la empresa puede ver, hacer o restaurar copias de una aplicación.',
    );
}

const appRef = z.string().trim().min(1).max(80).describe('App id or slug.');

const summaryOut = z.object({
  id: z.string(),
  kind: z.string(),
  reason: z.string(),
  status: z.string(),
  createdAt: z.string(),
  sizeBytes: z.number(),
  tables: z.record(z.number()),
});

// ---------------------------------------------------------------------------
// apps.backups_list
// ---------------------------------------------------------------------------

export const appsBackupsList = registerTool({
  id: 'apps.backups_list',
  description:
    "List the backups of an application (daily at 2:00 a. m., before changes, manual), newest first, with rows per table. Pass `backup` (id) to also compare THAT backup against today's data: per table, rows created, deleted and changed since then (use it before restoring). Read-only; company owners/admins only.",
  inputSchema: z.object({
    app: appRef,
    backup: z.string().uuid().optional().describe('Backup id to compare against today.'),
  }),
  outputSchema: z.object({
    backups: z.array(summaryOut),
    compare: z
      .array(
        z.object({
          table: z.string(),
          created: z.number(),
          deleted: z.number(),
          changed: z.number(),
          unchanged: z.number(),
        }),
      )
      .nullable(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    await requireAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app, { includeArchived: true });
    const rows = await listBackups(ctx.db, app.id, 30);
    let compare: Array<{
      table: string;
      created: number;
      deleted: number;
      changed: number;
      unchanged: number;
    }> | null = null;
    if (input.backup) {
      const diff = await diffAgainstToday(ctx.db, app.id, input.backup);
      // «created»/«deleted» desde la mirada de hoy: lo que nació o se borró DESPUÉS de la copia.
      compare = diff.tables.map((t) => ({
        table: t.slug,
        created: t.added.length,
        deleted: t.removed.length,
        changed: t.changed.length,
        unchanged: t.unchanged,
      }));
    }
    const lines = rows.map(
      (b) =>
        `- ${b.createdAt.slice(0, 16).replace('T', ' ')} UTC · ${BACKUP_KIND_LABEL[b.kind]}${b.status === 'failed' ? ' (falló)' : ''}${b.reason ? ` — ${b.reason}` : ''} · id ${b.id}`,
    );
    return {
      backups: rows.map((b) => ({
        id: b.id,
        kind: b.kind,
        reason: b.reason,
        status: b.status,
        createdAt: b.createdAt,
        sizeBytes: b.sizeBytes,
        tables: b.tables,
      })),
      compare,
      markdown: rows.length
        ? `Copias de **${app.name}**:\n${lines.join('\n')}${compare ? `\n\nContra hoy:\n${compare.map((c) => `- ${c.table}: ${c.deleted} borradas, ${c.changed} cambiadas, ${c.created} nuevas`).join('\n')}` : ''}`
        : `**${app.name}** todavía no tiene copias. Hazla con apps.backup_create.`,
    };
  },
});

// ---------------------------------------------------------------------------
// apps.backup_create
// ---------------------------------------------------------------------------

export const appsBackupCreate = registerTool({
  id: 'apps.backup_create',
  description:
    "Make a backup of an application NOW: its configuration (screens, roles, rules), its code, and ALL rows of the tables it uses. Use kind 'antes_de_cambio' (and say why in `reason`) right before changing many rows, tables or rules in bulk on that app's data; 'manual' when the person asks. Company owners/admins only.",
  inputSchema: z.object({
    app: appRef,
    kind: z.enum(['manual', 'antes_de_cambio']).default('manual'),
    reason: z.string().trim().max(300).default(''),
  }),
  outputSchema: z.object({ id: z.string(), tables: z.record(z.number()), markdown: z.string() }),
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    await requireAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app, { includeArchived: true });
    const b = await createBackup(ctx.db, app.id, {
      kind: input.kind ?? 'manual',
      reason: input.reason ?? '',
      userId: ctx.userId,
    });
    const total = Object.values(b.tables).reduce((a, n) => a + n, 0);
    return {
      id: b.id,
      tables: b.tables,
      markdown: `Copia hecha de **${app.name}** (${Object.keys(b.tables).length} tablas, ${total} filas, ${(b.sizeBytes / 1024).toFixed(0)} KB). id ${b.id}.`,
    };
  },
});

// ---------------------------------------------------------------------------
// apps.backup_restore_row
// ---------------------------------------------------------------------------

export const appsBackupRestoreRow = registerTool({
  id: 'apps.backup_restore_row',
  description:
    'Restore ONE row of a table of the application to the values it had in a backup; if the row was deleted it is created again with the same id. Makes a «before restoring» backup first, and only touches that row. Find the row id with apps.backups_list (backup compare) or in the backup. Requires confirmation; company owners/admins only.',
  inputSchema: z.object({
    app: appRef,
    backup: z.string().uuid(),
    table: z.string().trim().min(1).max(80).describe('Table slug.'),
    rowId: z.string().uuid(),
  }),
  outputSchema: z.object({
    action: z.enum(['recreated', 'updated', 'unchanged']),
    safetyBackupId: z.string(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await assertBackupAdmin(ctx.db, ctx.userId);
    const app = await mustGetApp(ctx.db, input.app, { includeArchived: true });
    const out = await restoreRow(ctx.db, app.id, input.backup, input.table, input.rowId, {
      userId: ctx.userId,
    });
    return {
      action: out.action,
      safetyBackupId: out.safetyBackupId,
      markdown: `${out.done.join(' ')} Antes dejé una copia (id ${out.safetyBackupId}).`,
    };
  },
});

// ---------------------------------------------------------------------------
// apps.backup_restore_table
// ---------------------------------------------------------------------------

export const appsBackupRestoreTable = registerTool({
  id: 'apps.backup_restore_table',
  description:
    'Restore a WHOLE table of the application to what it had in a backup: rows deleted since are created again (same id), changed rows go back to their old values, and rows created after the backup are DELETED. Makes a «before restoring» backup first. Call with `dryRun: true` first to see how many rows would be created/changed/deleted and tell the person. Requires confirmation; company owners/admins only.',
  inputSchema: z.object({
    app: appRef,
    backup: z.string().uuid(),
    table: z.string().trim().min(1).max(80).describe('Table slug.'),
    dryRun: z.boolean().default(false).describe('Only count what would change.'),
  }),
  outputSchema: z.object({
    create: z.number(),
    update: z.number(),
    remove: z.number(),
    applied: z.boolean(),
    safetyBackupId: z.string().nullable(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await assertBackupAdmin(ctx.db, ctx.userId);
    const app = await mustGetApp(ctx.db, input.app, { includeArchived: true });
    if (input.dryRun) {
      const { plan, text } = await previewTableRestore(ctx.db, app.id, input.backup, input.table);
      return {
        ...plan,
        applied: false,
        safetyBackupId: null,
        markdown: `${text} (Solo la cuenta: no cambié nada.)`,
      };
    }
    const out = await restoreTable(ctx.db, app.id, input.backup, input.table, {
      userId: ctx.userId,
    });
    return {
      ...out.plan,
      applied: true,
      safetyBackupId: out.safetyBackupId,
      markdown: `${out.done.join(' ')} Antes dejé una copia (id ${out.safetyBackupId}).${out.skipped.length ? ` ${out.skipped.join(' ')}` : ''}`,
    };
  },
});
