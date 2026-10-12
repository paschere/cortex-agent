import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { createAutomation, listAutomations, updateAutomation } from '../apps/automations/store';
import { registerTool } from '../index';
import {
  type FlowRequirement,
  type FlowTransition,
  describeFlow,
  flowAutomationDrafts,
  flowNotifySchema,
  flowOf,
  flowRequirementSchema,
  flowTransitionSchema,
  linearTransitions,
  normalizeFlow,
} from './flow';
import { trackerFieldsSchema, trackerSlugSchema } from './schema';
import { defineTracker, getTrackerBySlug } from './store';

/**
 * trackers.set_flow: darle (o quitarle) un flujo por estados a una tabla, hablando.
 *
 * «recibido → en bodega → despachado → entregado; sólo el supervisor despacha;
 * foto obligatoria al entregar» se vuelve: states en orden, un salto con roles
 * y un requisito de foto. Los saltos que no se listan son los «uno tras otro»
 * (recibido → en bodega → …); si se listan, valen EXACTAMENTE esos. Las
 * opciones que falten en el campo se agregan solas. El avance y los botones
 * salen en el detalle y las tarjetas; el servidor rechaza cualquier otro salto.
 */

const requirementInput = flowRequirementSchema.extend({
  /** Estado al que se entra con este requisito. */
  state: z.string().trim().min(1).max(80),
});

export const trackersSetFlow = registerTool({
  id: 'trackers.set_flow',
  description: `Give a table a FLOW BY STATE (or change/remove it): the states in order, who may move each step, what must be filled to ENTER a state, and who gets notified on entering. Use it for "add a flow: received → in warehouse → shipped → delivered; only the supervisor ships; photo required on delivery". The flow lives on a select field of the table (field = its key; by default the first select field called estado/status, or the first select). Missing states are added to the field's options. transitions: if omitted, steps are linear (each state to the next) and anyone who can edit may move them; if given, ONLY those jumps exist, each with roles (app role keys; empty = anyone). requirements: [{state, kind: "field"|"photo"|"signature"|"comment", field}] — field is the table column where it is stored (photo/signature need a file column, comment a text column; create them first with trackers.define). notify: {"<state>": {roles:[…], message}} sends a bell notice to those app roles on entering — it needs appId (the app whose roles those are) and creates a visible automation; WhatsApp or email on entering are NOT part of the flow: arm them as a separate automation that asks for confirmation. The server enforces it everywhere: a disallowed jump is rejected even if the client sends it. remove:true removes the flow. Requires confirmation.`,
  inputSchema: z.object({
    slug: trackerSlugSchema.describe('The table.'),
    field: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .optional()
      .describe('Key of the select field that carries the state.'),
    states: z.array(z.string().trim().min(1).max(80)).min(2).max(12).optional(),
    transitions: z.array(flowTransitionSchema).max(80).optional(),
    /** Atajo: «sólo este rol hace este salto» sin repetir toda la lista. */
    onlyRoles: z
      .record(z.array(z.string().trim().min(1).max(31)).max(8))
      .optional()
      .describe(
        'Shortcut for linear flows: {"<target state>": ["supervisor"]} = only those roles may ENTER that state.',
      ),
    requirements: z.array(requirementInput).max(30).optional(),
    notify: z.record(flowNotifySchema).optional(),
    appId: z
      .string()
      .uuid()
      .optional()
      .describe('Only to create the bell-notification automations of `notify`.'),
    remove: z.boolean().optional(),
  }),
  outputSchema: z.object({
    slug: z.string(),
    field: z.string().nullable(),
    states: z.array(z.string()),
    legacyRows: z.number().int(),
    automations: z.array(z.string()),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const tracker = await getTrackerBySlug(ctx.db, input.slug);
    if (!tracker) throw new NotFoundError(`No existe la tabla «${input.slug}».`);
    const current = flowOf(tracker.fields);
    if (input.remove) {
      const fields = tracker.fields.map((f) => {
        const { flow: _drop, ...rest } = f;
        return rest;
      });
      await defineTracker(ctx.db, {
        slug: tracker.slug,
        name: tracker.name,
        description: tracker.description,
        fields: trackerFieldsSchema.parse(fields),
        userId: ctx.userId,
      });
      return {
        slug: tracker.slug,
        field: null,
        states: [],
        legacyRows: 0,
        automations: [],
        markdown: `Se quitó el flujo de **${tracker.name}**: el campo vuelve a cambiar libremente.`,
      };
    }
    const target =
      tracker.fields.find((f) => f.key === input.field) ??
      current?.field ??
      tracker.fields.find((f) => f.type === 'select' && /^(estado|status|etapa)$/.test(f.key)) ??
      tracker.fields.find((f) => f.type === 'select');
    if (!target || target.type !== 'select')
      throw new ValidationError(
        'El flujo necesita un campo de opciones (select) para el estado: créalo primero con trackers.define.',
      );
    const states = input.states ?? current?.flow.states;
    if (!states || states.length < 2)
      throw new ValidationError('Faltan los estados del flujo (mínimo 2).');
    let transitions: FlowTransition[] = input.transitions
      ? input.transitions.map((t) => ({ from: t.from, to: t.to, roles: t.roles ?? [] }))
      : input.states || !current
        ? linearTransitions(states)
        : current.flow.transitions;
    if (input.onlyRoles)
      transitions = transitions.map((t) =>
        input.onlyRoles?.[t.to] ? { ...t, roles: input.onlyRoles[t.to] as string[] } : t,
      );
    const requirements: Record<string, FlowRequirement[]> = input.requirements
      ? {}
      : { ...(current?.flow.requirements ?? {}) };
    for (const r of input.requirements ?? []) {
      const list = requirements[r.state] ?? [];
      list.push({ kind: r.kind, field: r.field });
      requirements[r.state] = list;
    }
    const flow = {
      states,
      transitions,
      requirements,
      notify: input.notify ?? current?.flow.notify ?? {},
    };
    const options = [...new Set([...(target.options ?? []), ...states])];
    const fields = trackerFieldsSchema.parse(
      tracker.fields.map((f) => {
        const { flow: _old, ...rest } = f;
        return f.key === target.key ? { ...rest, options, flow } : rest;
      }),
    );
    const saved = await defineTracker(ctx.db, {
      slug: tracker.slug,
      name: tracker.name,
      description: tracker.description,
      fields,
      userId: ctx.userId,
    });
    const savedField = saved.tracker.fields.find((f) => f.key === target.key);
    // Filas que ya tienen un estado fuera del flujo: siguen ahí y pueden entrar a cualquier estado.
    const { count } = await ctx.db
      .from('tracker_rows')
      .select('id', { count: 'exact', head: true })
      .eq('tracker_id', saved.tracker.id);
    const made: string[] = [];
    if (input.appId && savedField?.flow) {
      const existing = await listAutomations(ctx.db, input.appId);
      for (const draft of flowAutomationDrafts({
        tracker: tracker.slug,
        trackerName: tracker.name,
        field: savedField,
        flow: normalizeFlow(savedField.flow),
      })) {
        const prior = existing.find((a) => a.name === draft.name);
        if (prior) await updateAutomation(ctx.db, input.appId, prior.id, draft);
        else await createAutomation(ctx.db, input.appId, draft, ctx.userId);
        made.push(draft.name);
      }
    }
    const notifyNote =
      Object.keys(flow.notify).length && !input.appId
        ? ' Los avisos por rol quedaron guardados, pero para activarlos hace falta decir de qué app son los roles (appId).'
        : made.length
          ? ` Avisos por la campana armados como automatizaciones: ${made.join('; ')}.`
          : '';
    return {
      slug: tracker.slug,
      field: target.key,
      states,
      legacyRows: count ?? 0,
      automations: made,
      markdown: `${describeFlow(target, flow, fields)}${notifyNote} Cada fila nueva nace en «${states[0]}»; el servidor rechaza cualquier otro salto. En el detalle de cada registro aparece el avance y los botones.`,
    };
  },
});
