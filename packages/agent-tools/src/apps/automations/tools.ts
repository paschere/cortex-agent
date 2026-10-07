import { ForbiddenError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCompanyManager } from '../../directory/store';
import { registerTool } from '../../index';
import { mustGetApp } from '../store';
import {
  ACTION_LABEL,
  TRIGGER_LABEL,
  automationActionSchema,
  automationConditionSchema,
  automationTriggerSchema,
} from './spec';
import {
  type AutomationRow,
  createAutomation,
  lastRuns,
  listAutomations,
  mustGetAutomation,
  setAutomationEnabled,
  updateAutomation,
} from './store';
import { AUTOMATION_TEMPLATES, templateById } from './templates';

/**
 * Las automatizaciones de una app desde el chat (migración 0210): listar,
 * crear (de una plantilla o con Cuando / Si / Entonces), cambiar y pausar.
 * Lo que cambia pide confirmación y sólo es de quien administra la empresa,
 * como el editor. Probar con una fila de ejemplo está en el editor.
 */

async function requireAppAdmin(ctx: { db: SupabaseClient; userId: string }): Promise<void> {
  if (!(await isCompanyManager(ctx.db, ctx.userId)))
    throw new ForbiddenError(
      'Sólo quien administra la empresa o es su dueño puede cambiar las automatizaciones.',
    );
}

/** Una línea legible: «Cuando … → entonces …». */
export function describeAutomation(
  a: Pick<AutomationRow, 'trigger' | 'actions' | 'conditions'>,
): string {
  const t = a.trigger;
  const when =
    t.type === 'schedule'
      ? `${t.cadence === 'daily' ? 'Todos los días' : `Cada semana (día ${t.weekday ?? 1})`} a las ${String(t.hour).padStart(2, '0')}:00`
      : t.type === 'button'
        ? `Cuando toquen «${t.label}» en ${t.screen}`
        : `${TRIGGER_LABEL[t.type]} en ${'tracker' in t ? t.tracker : ''}`;
  const ifs = a.conditions.length ? ` si se cumplen ${a.conditions.length} condición(es)` : '';
  return `${when}${ifs} → ${a.actions.map((x) => ACTION_LABEL[x.type].toLowerCase()).join(', ')}`;
}

const GRAMMAR = `Automation = {name, enabled?, trigger, conditions[], actions[]}.
trigger (Cuando): {type:"row_created",tracker} | {type:"row_updated",tracker,field?,to?} | {type:"row_flagged_duplicate",tracker} | {type:"form_submitted",tracker,screen?,block?} | {type:"approval_decided",tracker,decision:"approved"|"rejected"|"any"} | {type:"schedule",cadence:"daily"|"weekly",hour:0-23 (Bogota),weekday?:1-7} | {type:"button",screen,id,label}.
conditions (Si): view filters {field,op,value?} plus {type:"changed",field,from?,to?}. Only for triggers with a row.
actions (Entonces, max 8): {type:"set_field",field,value} | {type:"create_row",tracker,values:{field:value}} | {type:"notify_member",members?:[userId],roles?:[roleKey],admins?,title,body?} | {type:"notify_app_user",to:"creator"|{role},title,body?,screen?} (push, or email if the person has no active push) | {type:"email",to?:[addresses],roles?:[roleKey],subject,body} | {type:"webhook",url:https} (HMAC-signed POST) | {type:"ask_cortex",instruction} (anything it writes outside the row's table goes to approval).
Templates in text use {{field_key}}, {{antes.field_key}}, {{nombre}}, {{app}}, {{enlace}}, {{motivo}}. An automation never re-triggers itself (max depth 3). No WhatsApp: notices go by push and email only.`;

const summarySchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  description: z.string(),
  lastRunAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  lastError: z.string().nullable(),
});

export const appsAutomationsList = registerTool({
  id: 'apps.automations.list',
  description:
    'List the automations (Cuando / Si / Entonces rules) of an application, with their state and last run, plus the ready-made templates. Read-only.',
  inputSchema: z.object({ app: z.string().trim().min(1).max(80).describe('App id or slug.') }),
  outputSchema: z.object({
    automations: z.array(summarySchema),
    templates: z.array(z.object({ id: z.string(), name: z.string(), needs: z.array(z.string()) })),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const [rows, runs] = await Promise.all([
      listAutomations(ctx.db, app.id),
      lastRuns(ctx.db, app.id),
    ]);
    const automations = rows.map((a) => ({
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      description: describeAutomation(a),
      lastRunAt: a.last_run_at,
      lastStatus: a.last_status,
      lastError: runs.get(a.id)?.error ?? null,
    }));
    const markdown = automations.length
      ? automations
          .map(
            (a) =>
              `- ${a.enabled ? '' : '(en pausa) '}**${a.name}** \`${a.id}\` — ${a.description}${a.lastStatus ? `. Última corrida: ${a.lastStatus}${a.lastError ? ` (${a.lastError})` : ''}` : ''}`,
          )
          .join('\n')
      : `**${app.name}** todavía no tiene automatizaciones. Puedo armar una desde una plantilla (${AUTOMATION_TEMPLATES.map((t) => `«${t.name}»`).join(', ')}) o con Cuando / Si / Entonces.`;
    return {
      automations,
      templates: AUTOMATION_TEMPLATES.map((t) => ({ id: t.id, name: t.name, needs: t.needs })),
      markdown,
    };
  },
});

export const appsAutomationsCreate = registerTool({
  id: 'apps.automations.create',
  description: `Create an automation for an application: from a ready-made template (duplicate_to_supervisor, rejected_to_operator, daily_summary, approved_to_dispatched) with its few parameters, or a custom Cuando / Si / Entonces rule. Tables, fields, screens and roles are validated against the real app before saving. Notices go only by push and email (no WhatsApp). Requires confirmation; company owners/admins only.
${GRAMMAR}`,
  inputSchema: z
    .object({
      app: z.string().trim().min(1).max(80).describe('App id or slug.'),
      template: z
        .object({
          id: z.enum(AUTOMATION_TEMPLATES.map((t) => t.id) as [string, ...string[]]),
          tracker: z.string().trim().max(60).optional(),
          role: z.string().trim().max(40).optional(),
          field: z.string().trim().max(32).optional(),
          value: z.string().trim().max(120).optional(),
          emails: z.array(z.string().trim().max(200)).max(10).optional(),
          hour: z.number().int().min(0).max(23).optional(),
        })
        .optional(),
      name: z.string().trim().min(1).max(120).optional(),
      trigger: automationTriggerSchema.optional(),
      conditions: z.array(automationConditionSchema).max(8).default([]),
      actions: z.array(automationActionSchema).max(8).optional(),
    })
    .refine((v) => Boolean(v.template) !== Boolean(v.trigger && v.actions?.length), {
      message: 'Da una plantilla, o un disparador con sus acciones (no las dos cosas).',
    }),
  outputSchema: z.object({ id: z.string(), name: z.string(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    let draft: unknown;
    if (input.template) {
      const t = templateById(input.template.id);
      if (!t) throw new ValidationError('Esa plantilla no existe.');
      try {
        draft = t.build(input.template);
      } catch (err) {
        throw new ValidationError(
          err instanceof Error ? err.message : 'Faltan datos de la plantilla.',
        );
      }
      if (input.name) (draft as { name: string }).name = input.name;
    } else {
      draft = {
        name: input.name ?? 'Automatización',
        enabled: true,
        trigger: input.trigger,
        conditions: input.conditions ?? [],
        actions: input.actions,
      };
    }
    const created = await createAutomation(ctx.db, app.id, draft, ctx.userId);
    return {
      id: created.id,
      name: created.name,
      markdown: `Listo: **${created.name}** en **${app.name}**. ${describeAutomation(created)}. La app tiene que estar publicada para que corra; puedes probarla con una fila de ejemplo y ver su historial en /apps/${app.slug}/edit.`,
    };
  },
});

export const appsAutomationsUpdate = registerTool({
  id: 'apps.automations.update',
  description: `Change an automation of an application (name, trigger, conditions or actions; send only what changes — conditions and actions replace the whole list). Validated against the real app. Requires confirmation; company owners/admins only.
${GRAMMAR}`,
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80),
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120).optional(),
    trigger: automationTriggerSchema.optional(),
    conditions: z.array(automationConditionSchema).max(8).optional(),
    actions: z.array(automationActionSchema).min(1).max(8).optional(),
  }),
  outputSchema: z.object({ id: z.string(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const current = await mustGetAutomation(ctx.db, app.id, input.id);
    const updated = await updateAutomation(ctx.db, app.id, current.id, {
      name: input.name ?? current.name,
      enabled: current.enabled,
      trigger: input.trigger ?? current.trigger,
      conditions: input.conditions ?? current.conditions,
      actions: input.actions ?? current.actions,
    });
    return {
      id: updated.id,
      markdown: `Listo: **${updated.name}**. ${describeAutomation(updated)}.`,
    };
  },
});

export const appsAutomationsPause = registerTool({
  id: 'apps.automations.pause',
  description:
    'Pause or resume an automation of an application. A paused automation keeps its history and stops reacting; runs already queued are skipped. Requires confirmation; company owners/admins only.',
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80),
    id: z.string().uuid(),
    paused: z.boolean().default(true).describe('true = pause, false = resume.'),
  }),
  outputSchema: z.object({ id: z.string(), enabled: z.boolean(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const row = await setAutomationEnabled(ctx.db, app.id, input.id, !(input.paused ?? true));
    return {
      id: row.id,
      enabled: row.enabled,
      markdown: `**${row.name}** quedó ${row.enabled ? 'activa' : 'en pausa'}.`,
    };
  },
});
