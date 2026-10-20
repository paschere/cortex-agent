import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { isCompanyManager } from '../../directory/store';
import { registerTool } from '../../index';
import { mustGetApp } from '../store';
import { type RoleNoticeSummary, summarizeRoleNotices } from './interest';
import {
  type NoticeConfig,
  type RoleNoticeConfig,
  parseNoticeConfig,
  roleNoticeSchema,
} from './shape';
import { loadNoticeAppModel, saveNoticeConfig } from './store';

/**
 * `apps.notices`: qué avisos automáticos recibe cada rol de una app (0231).
 *
 * Nadie crea reglas para esto: la app ya avisa sola cuando alguien registra o
 * cambia algo de lo que otro rol depende, cuando se asigna un registro, cuando
 * algo queda por aprobar y cuando cambia el estado de un registro propio. Esta
 * herramienta sólo ajusta qué tipos recibe cada rol («que a Supervisor le
 * llegue cada atención nueva y al operario sólo lo que se le asigna»).
 */

async function requireAppAdmin(ctx: { db: Parameters<typeof isCompanyManager>[0]; userId: string }) {
  if (!(await isCompanyManager(ctx.db, ctx.userId)))
    throw new ForbiddenError(
      'Sólo quien administra la empresa o es su dueño puede cambiar una aplicación.',
    );
}

const ONE = (on: boolean) => (on ? 'sí' : 'no');

export function describeNotices(name: string, rows: RoleNoticeSummary[]): string {
  if (!rows.length) return `**${name}** todavía no tiene roles, así que no hay a quién avisar.`;
  const lines = rows.map((r) => {
    const parts = [
      `nuevos: ${ONE(r.new)}${r.new && r.only?.length ? ` (sólo ${r.only.join(', ')})` : ''}`,
      `asignaciones: ${ONE(r.assigned)}`,
      `por aprobar: ${ONE(r.approval)}`,
      `cambios en lo suyo: ${ONE(r.changed)}`,
    ];
    const depends = r.depends.length
      ? ` — depende de ${r.depends.map((d) => d.tracker).join(', ')}`
      : ' — no depende de ninguna tabla';
    return `- **${r.roleName}** (${r.roleKey}): ${parts.join(' · ')}${r.custom ? ' · ajustado' : ' · por defecto'}${depends}`;
  });
  return `Avisos automáticos de **${name}** (cada persona puede además elegir «todo», «sólo lo mío» o «nada», y silenciar):\n\n${lines.join('\n')}`;
}

export const appsNotices = registerTool({
  id: 'apps.notices',
  description: `See or adjust which AUTOMATIC NOTICES each role of an application receives. Nobody creates rules for this: when a row is created or changed, the app itself tells the roles that depend on that table (they read it on a screen, approve it or have buttons on it), except the person who made the change and only if that person can see that row (read own / attribute scopes are respected). Four kinds: "new" («Nuevo en Atenciones»: someone registered something the role depends on; default ON for roles that see other people's rows and do not register them, and for supervisors; OFF for operators who only see their own), "assigned" («Se te asignó…»: a person field, assign button or map assignment points at them; default ON), "approval" («Pendiente de tu aprobación»: a row enters the pending state of a form with approval that the role approves; default ON for approvers) and "changed" (a status/select field changed on a record the person created; default ON). Bursts are grouped («5 nuevos en Atenciones») and idempotent. Channels: in-app inbox with counters per screen, toast, web push (only if the server has VAPID keys and the person accepted) and email as fallback for assignments and approvals; each person chooses «todo», «sólo lo mío y asignaciones» or «nada» and can mute. Use list:true (or no changes) to read the current state per role. set: [{role, new?, assigned?, approval?, changed?, only?: [table slugs the "new" notice is limited to] | null}] changes only what you name; reset: [role keys] goes back to the defaults. Example: «que a Supervisor le llegue cada atención nueva y al operario sólo lo que se le asigna» → set [{role:"supervisor", new:true},{role:"operario", new:false, assigned:true}]. Never invent role keys or table slugs: read them with apps.get. Requires confirmation; company owners/admins only.`,
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80).describe('App id or slug.'),
    list: z.boolean().optional().describe('true = only read the current state.'),
    set: z
      .array(
        roleNoticeSchema.extend({
          role: z.string().trim().min(1).max(40),
          only: z.array(z.string().trim().min(1).max(48)).max(30).nullable().optional(),
        }),
      )
      .max(8)
      .optional(),
    reset: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  }),
  outputSchema: z.object({
    roles: z.array(
      z.object({
        role: z.string(),
        new: z.boolean(),
        assigned: z.boolean(),
        approval: z.boolean(),
        changed: z.boolean(),
        only: z.array(z.string()).nullable(),
        dependsOn: z.array(z.string()),
        custom: z.boolean(),
      }),
    ),
    changes: z.array(z.string()),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const model = await loadNoticeAppModel(ctx.db, app, { live: true });
    const roleKeys = new Set(model.roles.map((r) => r.key));
    const trackerSlugs = new Set(
      model.screens.flatMap((s) =>
        s.spec.blocks.flatMap((b) => ('tracker' in b && typeof b.tracker === 'string' ? [b.tracker] : [])),
      ),
    );
    const changes: string[] = [];
    const next: NoticeConfig = parseNoticeConfig(model.config);
    for (const key of input.reset ?? []) {
      if (!roleKeys.has(key)) throw new NotFoundError(`No hay un rol «${key}» en esta app.`);
      delete next.roles[key];
      changes.push(`${key}: vuelve a los avisos por defecto`);
    }
    for (const patch of input.set ?? []) {
      const { role, ...rest } = patch;
      if (!roleKeys.has(role)) throw new NotFoundError(`No hay un rol «${role}» en esta app.`);
      for (const slug of rest.only ?? [])
        if (!trackerSlugs.has(slug))
          throw new ValidationError(`La tabla «${slug}» no está en las pantallas de esta app.`);
      const merged: RoleNoticeConfig = { ...(next.roles[role] ?? {}) };
      for (const kind of ['new', 'assigned', 'approval', 'changed'] as const)
        if (rest[kind] !== undefined) {
          merged[kind] = rest[kind];
          changes.push(`${role}: ${kind} → ${ONE(rest[kind] as boolean)}`);
        }
      if (rest.only !== undefined) {
        if (rest.only === null || rest.only.length === 0) merged.only = undefined;
        else merged.only = rest.only;
        changes.push(`${role}: nuevos ${rest.only?.length ? `sólo de ${rest.only.join(', ')}` : 'de todas sus tablas'}`);
      }
      next.roles[role] = Object.fromEntries(
        Object.entries(merged).filter(([, v]) => v !== undefined),
      ) as RoleNoticeConfig;
    }
    if (changes.length) await saveNoticeConfig(ctx.db, app.id, next, ctx.userId);
    const summary = summarizeRoleNotices({ ...model, config: next });
    return {
      roles: summary.map((r) => ({
        role: r.roleKey,
        new: r.new,
        assigned: r.assigned,
        approval: r.approval,
        changed: r.changed,
        only: r.only,
        dependsOn: r.depends.map((d) => d.tracker),
        custom: r.custom,
      })),
      changes,
      markdown: `${changes.length ? `Listo: ${changes.join('; ')}.\n\n` : ''}${describeNotices(app.name, summary)}`,
    };
  },
});
