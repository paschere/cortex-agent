import { ForbiddenError } from '@cortex/core';
import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { isCompanyManager } from '../directory/store';
import { registerTool } from '../index';
import { planningDeps } from './engine';
import { planMarkdown, settingsMarkdown } from './format';
import { planToday } from './run';
import { settingsPatchSchema } from './settings';
import {
  listAutopilotRuns,
  listOpenAsks,
  readAutopilotSettings,
  saveAutopilotSettings,
} from './store';
import { DECISION_LABEL } from './types';

/**
 * EL PILOTO EN EL CHAT:
 *
 *   autopilot.plan       «¿qué vas a hacer hoy?» — el plan de hoy, sin hacer
 *                        nada (el mismo ensayo de «Probar sin hacer nada»).
 *   autopilot.status     «¿qué hiciste hoy?» — las últimas corridas y lo que
 *                        espera decisión.
 *   autopilot.configure  «hazte cargo de la cobranza» — encender, apagar y
 *                        ajustar niveles y topes. Sólo administradores o el
 *                        dueño; pide confirmación.
 */

const itemOut = z.object({
  area: z.string(),
  title: z.string(),
  why: z.string(),
  decision: z.enum(['do', 'ask', 'tell']),
  decisionLabel: z.string(),
  reason: z.string(),
  toolId: z.string().nullable(),
  amount: z.number().nullable(),
});

export const autopilotPlan = registerTool({
  id: 'autopilot.plan',
  description:
    "What Cortex's autopilot would do today for this company, without doing anything («¿qué vas a hacer hoy?», «¿qué harías solo hoy?»): overdue invoices to collect, bank payments to match, uncategorized ledger movements, failing syncs, deadlines to remind, overloaded people, cash alerts — each marked as do it alone, needs your decision, or just so you know, with the evidence and the reason. Read-only dry run; works even when the autopilot is off.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    day: z.string(),
    enabled: z.boolean(),
    counts: z.object({ do: z.number(), ask: z.number(), tell: z.number() }),
    items: z.array(itemOut),
    unreadable: z.array(z.string()),
    markdown: z.string(),
  }),
  handler: async (_input, ctx) => {
    const day = bogotaToday();
    const deps = planningDeps(ctx.db, { day });
    const settings = await deps.readSettings();
    const plan = await planToday(deps, { settings });
    return {
      day,
      enabled: settings.enabled,
      counts: plan.counts,
      items: plan.items.map((i) => ({
        area: i.area,
        title: i.title,
        why: i.why,
        decision: i.decision,
        decisionLabel: DECISION_LABEL[i.decision],
        reason: i.decisionReason,
        toolId: i.proposedAction?.toolId ?? null,
        amount: i.amount ?? null,
      })),
      unreadable: plan.sourceErrors.map((e) => e.source),
      markdown: planMarkdown(plan, settings, { dryRun: true }),
    };
  },
});

export const autopilotStatus = registerTool({
  id: 'autopilot.status',
  description:
    "«¿Qué hiciste hoy por tu cuenta?», «¿qué hiciste solo esta mañana?», «¿qué hizo el piloto automático esta semana?»: what Cortex did on its own in its daily autopilot runs — how many things it did alone, asked, reported or failed each day, what is still waiting for the owner's decision, and whether the autopilot is on and how it is configured. Read-only.",
  inputSchema: z.object({ days: z.number().int().min(1).max(30).optional() }),
  outputSchema: z.object({
    enabled: z.boolean(),
    runs: z.array(
      z.object({
        id: z.string(),
        day: z.string(),
        status: z.string(),
        done: z.number(),
        asked: z.number(),
        told: z.number(),
        failed: z.number(),
        summary: z.string().nullable(),
      }),
    ),
    waiting: z.number(),
    markdown: z.string(),
  }),
  handler: async (input, ctx) => {
    const [settings, runs, asks] = await Promise.all([
      readAutopilotSettings(ctx.db),
      listAutopilotRuns(ctx.db, { limit: input.days ?? 7 }),
      listOpenAsks(ctx.db, { limit: 50 }),
    ]);
    const lines = runs.map(
      (r) =>
        `- ${r.run_on}: ${r.summary ?? (r.status === 'running' ? 'en curso' : 'sin resumen')} → /piloto/${r.id}`,
    );
    const markdown = [
      settingsMarkdown(settings),
      runs.length
        ? `**Últimas corridas**\n${lines.join('\n')}`
        : 'El piloto todavía no ha corrido en esta empresa.',
      asks.length
        ? `**Esperan tu decisión (${asks.length})**\n${asks
            .slice(0, 8)
            .map((a) => `- ${a.title}`)
            .join('\n')}`
        : '',
      'El detalle de cada día, con lo que hice y cómo lo verifiqué, está en /piloto.',
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      enabled: settings.enabled,
      runs: runs.map((r) => ({
        id: r.id,
        day: r.run_on,
        status: r.status,
        done: r.done_count,
        asked: r.asked_count,
        told: r.told_count,
        failed: r.failed_count,
        summary: r.summary,
      })),
      waiting: asks.length,
      markdown,
    };
  },
});

export const autopilotConfigure = registerTool({
  id: 'autopilot.configure',
  description:
    '«Hazte cargo de la cobranza», «encárgate tú de cobrar la cartera», «enciende / apaga el piloto automático», «solo avísame de los pagos»: turn Cortex\'s autopilot on or off and set what it does alone each morning (admins or the company owner only; requires confirmation). Areas: cobro, pagos, conciliacion, equipo, procesos, vencimientos, gerencia, finanzas; levels: avisar (only tell), proponer (prepare it for approval), hacer (do the routine part alone) — «hazte cargo de X» = that area to "hacer". Also run hour (Bogotá), days, daily caps and quiet days. It never moves money on its own; emails to clients go out alone only under a mandate that also applies unattended, otherwise they wait for approval.',
  inputSchema: settingsPatchSchema,
  outputSchema: z.object({ enabled: z.boolean(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    if (!(await isCompanyManager(ctx.db, ctx.userId)))
      throw new ForbiddenError(
        'Sólo un administrador o el dueño de la empresa puede decidir qué hace el piloto automático.',
      );
    const saved = await saveAutopilotSettings(ctx.db, input, { userId: ctx.userId });
    const external =
      input.areaLevels?.cobro === 'hacer'
        ? '\n\nOjo: con «hacer», el cobro te queda redactado cada mañana y lo apruebas con un clic. Para que salga solo, hace falta además un mandato sobre el envío de correos que diga «también sin nadie mirando» (en /admin/mandates), y aun así respeto el tope de mensajes del día.'
        : '';
    return {
      enabled: saved.enabled,
      markdown: `Guardado.\n\n${settingsMarkdown(saved)}${external}\n\nLo ves y lo cambias en /piloto; «Probar sin hacer nada» te muestra lo que haría hoy.`,
    };
  },
});
