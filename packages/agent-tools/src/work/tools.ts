import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../index';
import { getTrackerBySlug, queryRows } from '../trackers/store';
import type { ToolContext } from '../types';
import { canSeeAssignee, scopeAssigneeIds, workScope } from './access';
import { type WorkDraft, proposeTrackerMapping } from './adapters';
import {
  RECORDABLE_SOURCES,
  type RecordableSource,
  SYNCED_SOURCES,
  TEAM_VISIBILITY,
  TEAM_VISIBILITY_LABEL,
  WORK_SOURCE_LABEL,
  WORK_STATUS_LABEL,
  type WorkDirectoryPerson,
  bogotaDayOf,
  dayToInstant,
  factsRef,
  foldText,
  isIsoDay,
  isMeasured,
  personLabelOf,
  resolvePerson,
  trackerMappingSchema,
  workTypeSchema,
} from './shape';
import {
  type WorkRecord,
  existingWorkByKeys,
  getWorkItemsByIds,
  isWorkAdmin,
  listWorkItems,
  readWorkSettings,
  reassignWorkItems,
  saveWorkSettings,
  updateWorkPerson,
  upsertWorkItems,
  workDirectory,
} from './store';
import { syncWork, workSyncIsStale } from './sync';
import type { WorkStatus } from './types';

/**
 * EL REGISTRO DE TRABAJO EN EL CHAT.
 *
 *   work.record         anotar trabajo de cualquier fuente («registra que Laura
 *                       despachó 12 guías hoy», un mensaje de operación de
 *                       WhatsApp, una fila de una hoja). Idempotente.
 *   work.preview_batch  mirar, sin escribir, cómo entrarían muchas filas…
 *   work.record_batch   …y anotarlas de una vez.
 *   work.assign         pasar trabajo a otra persona (en su fuente) y avisarle.
 *   work.suggest_mapping  proponer cómo una tabla inventada se vuelve trabajo.
 *   work.configure      qué se mide, qué tablas son trabajo, quién ve qué
 *                       (sólo administradores).
 *   work.update_person  equipo, cargo y días fuera de una persona.
 *   work.query          leer el trabajo: por persona, tipo, estado, vencido,
 *                       sin asignar. Con la regla de work/access.ts.
 *
 * Todo lo que escribe pide confirmación. Ninguna herramienta lee chats ni
 * correos para medir a nadie: el trabajo entra porque alguien lo dice, porque
 * una fuente de trabajo lo trae, o porque la empresa conectó una tabla.
 */

const dateSchema = z
  .string()
  .trim()
  .refine((v) => isIsoDay(v), 'Usa una fecha AAAA-MM-DD.');

const SELF_WORDS = new Set(['yo', 'mi', 'mí', 'mio', 'mío', 'me', 'mis', 'conmigo']);

interface ResolvedPerson {
  id: string | null;
  label: string | null;
}

/** «yo» o nada = quien pregunta; un nombre ambiguo se pregunta, no se adivina. */
function personOrSelf(
  people: readonly WorkDirectoryPerson[],
  raw: string | null | undefined,
  selfId: string,
  opts: { allowUnknown: boolean },
): ResolvedPerson {
  const text = raw?.trim() ?? '';
  if (!text || SELF_WORDS.has(foldText(text))) {
    const me = people.find((p) => p.id === selfId);
    return { id: selfId, label: me ? personLabelOf(me) : null };
  }
  const match = resolvePerson(people, text);
  if (match.kind === 'found') return { id: match.id, label: match.label };
  if (match.kind === 'ambiguous')
    throw new ValidationError(
      `«${match.label}» puede ser ${match.candidates.map((c) => c.label).join(' o ')}. ¿Cuál?`,
    );
  if (match.kind === 'unknown' && opts.allowUnknown) return { id: null, label: match.label };
  throw new NotFoundError(
    `No encuentro a «${text}» en el equipo. Dime su nombre completo o su correo.`,
  );
}

const itemOut = z.object({
  id: z.string(),
  title: z.string(),
  person: z.string(),
  workType: z.string(),
  status: z.enum(['open', 'done', 'cancelled']),
  overdue: z.boolean(),
  openedOn: z.string().nullable(),
  dueOn: z.string().nullable(),
  doneOn: z.string().nullable(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  source: z.string(),
});
type ItemOut = z.infer<typeof itemOut>;

const dayOf = (v: string | null | undefined) =>
  !v ? null : /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : bogotaDayOf(v);

function toOut(i: WorkRecord, names: ReadonlyMap<string, string>, today: string): ItemOut {
  const due = dayOf(i.dueAt);
  return {
    id: i.id,
    title: i.title,
    person: i.assigneeId
      ? (names.get(i.assigneeId) ?? 'Alguien que ya no está')
      : i.assigneeLabel
        ? `${i.assigneeLabel} (sin cuenta)`
        : 'Sin asignar',
    workType: i.workType,
    status: i.status,
    overdue: i.status === 'open' && due !== null && due < today,
    openedOn: dayOf(i.openedAt),
    dueOn: due,
    doneOn: dayOf(i.doneAt),
    quantity: i.quantity ?? null,
    unit: i.unit ?? null,
    source: WORK_SOURCE_LABEL[i.source.kind],
  };
}

function itemLine(i: ItemOut): string {
  const bits = [
    i.person,
    i.workType,
    i.status === 'done'
      ? `hecho${i.doneOn ? ` el ${i.doneOn}` : ''}`
      : i.status === 'cancelled'
        ? 'ya no aplica'
        : i.overdue
          ? `VENCIDO desde ${i.dueOn}`
          : i.dueOn
            ? `vence ${i.dueOn}`
            : 'por hacer',
    i.quantity !== null ? `${i.quantity}${i.unit ? ` ${i.unit}` : ''}` : null,
  ].filter(Boolean);
  return `- **${i.title}** — ${bits.join(' · ')}`;
}

async function requireAdmin(ctx: ToolContext, what: string): Promise<void> {
  if (!(await isWorkAdmin(ctx.db, ctx.userId)))
    throw new ForbiddenError(`Sólo quien administra la empresa o es su dueño puede ${what}.`);
}

// ---------------------------------------------------------------------------
// work.record
// ---------------------------------------------------------------------------

const recordSource = z
  .object({
    kind: z.enum(RECORDABLE_SOURCES).default('chat'),
    system: z
      .string()
      .trim()
      .max(80)
      .optional()
      .describe(
        'Process, sheet or group inside the source, e.g. "despachos" or the WhatsApp group name.',
      ),
    ref: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'The item id IN that source (sheet row id, message id). Re-recording the same ref updates instead of duplicating.',
      ),
  })
  .default({ kind: 'chat' });

const recordInput = z.object({
  person: z
    .string()
    .trim()
    .max(160)
    .optional()
    .describe('Who did it / owns it: a name, an email, or "yo". Omit for the person asking.'),
  workType: workTypeSchema.describe(
    'Kind of work, singular and lowercase: "despacho", "cobro", "visita", "pedido".',
  ),
  title: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe('What the work is, short: "Despacho de guías", "Visita a Ferretería El Tornillo".'),
  status: z.enum(['open', 'done', 'cancelled']).default('done'),
  quantity: z.number().nonnegative().optional().describe('Measurable result, e.g. 12 (guías).'),
  unit: z
    .string()
    .trim()
    .max(30)
    .optional()
    .describe('Unit of quantity: "guías", "COP", "pedidos".'),
  on: dateSchema
    .optional()
    .describe('Day it was done (or opened, if status=open). Default today (Bogotá).'),
  dueOn: dateSchema.optional(),
  team: z.string().trim().max(80).optional(),
  source: recordSource,
});

export const workRecord = registerTool({
  id: 'work.record',
  description:
    'Record a piece of team WORK in the work registry, from any source: «registra que Laura despachó 12 guías hoy», an operations message read from a WhatsApp group, a row of a sheet. It measures work (tasks and results), never the content of private chats or emails. Idempotent: the same facts (person, type, title, day, quantity) or the same source ref record once. Use work.record_batch for many rows. Requires confirmation.',
  inputSchema: recordInput,
  outputSchema: z.object({ item: itemOut, created: z.boolean(), markdown: z.string() }),
  requiresConfirmation: true,
  conversationGrace: 10 * 60_000,
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const settings = await readWorkSettings(ctx.db);
    if (!isMeasured(input.workType, settings.measuredTypes))
      throw new ValidationError(
        `«${input.workType}» no es un tipo de trabajo que esta empresa mida (se miden: ${settings.measuredTypes?.join(', ')}). Un administrador lo cambia con work.configure.`,
      );
    const people = await workDirectory(ctx.db);
    const who = personOrSelf(people, input.person, ctx.userId, { allowUnknown: true });
    const draft = recordDraft(input, who, today);
    const r = await upsertWorkItems(ctx.db, [draft], { recordedBy: ctx.userId });
    const [item] = await getWorkItemsByIds(ctx.db, [...r.ids.values()]);
    if (!item) throw new Error('El registro no quedó guardado.');
    const names = new Map(people.map((p) => [p.id, personLabelOf(p)]));
    const out = toOut(item, names, today);
    const created = r.inserted.length > 0;
    return {
      item: out,
      created,
      markdown: [
        created ? 'Anotado en el registro de trabajo:' : 'Eso ya estaba anotado (no lo dupliqué):',
        itemLine(out),
        !who.id
          ? `«${who.label}» no tiene cuenta en Cortex: quedó sin responsable con su nombre a la vista. Se le asigna con work.assign cuando tenga cuenta.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});

interface RecordFacts {
  workType: string;
  title: string;
  status?: WorkStatus;
  quantity?: number;
  unit?: string;
  on?: string;
  dueOn?: string;
  team?: string;
  source?: { kind?: RecordableSource; system?: string; ref?: string };
}

function recordDraft(input: RecordFacts, who: ResolvedPerson, today: string): WorkDraft {
  const day = input.on ?? today;
  const status = input.status ?? 'done';
  const source = { kind: input.source?.kind ?? ('chat' as const), ...input.source };
  const ref =
    source.ref ??
    factsRef({
      assignee: who.id ?? (who.label ? `label:${foldText(who.label)}` : null),
      workType: input.workType,
      title: input.title,
      day,
      quantity: input.quantity ?? null,
      unit: input.unit ?? null,
    });
  const at = dayToInstant(day);
  return {
    assigneeId: who.id,
    assigneeLabel: who.id ? null : who.label,
    workType: input.workType,
    title: input.title,
    status,
    openedAt: at,
    dueAt: input.dueOn ?? null,
    doneAt: status === 'done' ? at : null,
    lastActivityAt: at,
    quantity: input.quantity ?? null,
    unit: input.quantity !== undefined ? (input.unit ?? null) : null,
    team: input.team ?? null,
    source: { kind: source.kind ?? 'chat', system: source.system ?? null, ref },
  };
}

// ---------------------------------------------------------------------------
// work.preview_batch / work.record_batch
// ---------------------------------------------------------------------------

const batchInput = z.object({
  source: z.object({
    kind: z.enum(RECORDABLE_SOURCES).default('sheet'),
    system: z.string().trim().max(80).optional().describe('The sheet, table or group name.'),
  }),
  defaultWorkType: workTypeSchema.optional().describe('Work type for rows that do not say one.'),
  defaultUnit: z.string().trim().max(30).optional(),
  items: z
    .array(
      z.object({
        person: z.string().trim().max(160).optional(),
        workType: z.string().trim().max(60).optional(),
        title: z.string().trim().min(1).max(300),
        status: z.enum(['open', 'done', 'cancelled']).optional(),
        quantity: z.number().nonnegative().optional(),
        unit: z.string().trim().max(30).optional(),
        on: z.string().trim().optional(),
        dueOn: z.string().trim().optional(),
        team: z.string().trim().max(80).optional(),
        ref: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('Row id in the source, if it has one.'),
      }),
    )
    .min(1)
    .max(500),
});
type BatchInput = z.input<typeof batchInput>;

interface BatchPlan {
  drafts: WorkDraft[];
  rows: number[];
  rejected: Array<{ row: number; reason: string }>;
  withoutAccount: string[];
}

function planBatch(
  input: BatchInput,
  people: readonly WorkDirectoryPerson[],
  measured: readonly string[] | null,
  selfId: string,
  today: string,
): BatchPlan {
  const plan: BatchPlan = { drafts: [], rows: [], rejected: [], withoutAccount: [] };
  input.items.forEach((item, index) => {
    const row = index + 1;
    const reject = (reason: string) => plan.rejected.push({ row, reason });
    const typeRaw = item.workType?.trim() || input.defaultWorkType;
    if (!typeRaw) return reject('No dice qué tipo de trabajo es.');
    const workType = workTypeSchema.parse(typeRaw);
    if (!isMeasured(workType, measured)) return reject(`«${workType}» no se mide en esta empresa.`);
    if (item.on && !isIsoDay(item.on)) return reject(`«${item.on}» no es una fecha AAAA-MM-DD.`);
    if (item.dueOn && !isIsoDay(item.dueOn))
      return reject(`«${item.dueOn}» no es una fecha AAAA-MM-DD.`);
    let who: ResolvedPerson;
    try {
      who = personOrSelf(people, item.person, selfId, { allowUnknown: true });
    } catch (err) {
      return reject(err instanceof Error ? err.message : String(err));
    }
    if (!who.id && who.label && !plan.withoutAccount.includes(who.label))
      plan.withoutAccount.push(who.label);
    plan.drafts.push(
      recordDraft(
        {
          workType,
          title: item.title,
          status: item.status ?? 'done',
          quantity: item.quantity,
          unit: item.unit ?? (item.quantity !== undefined ? input.defaultUnit : undefined),
          on: item.on,
          dueOn: item.dueOn,
          team: item.team,
          source: {
            kind: input.source.kind ?? 'sheet',
            system: input.source.system,
            ref: item.ref,
          },
        },
        who,
        today,
      ),
    );
    plan.rows.push(row);
  });
  return plan;
}

const rejectedOut = z.array(z.object({ row: z.number(), reason: z.string() }));

export const workPreviewBatch = registerTool({
  id: 'work.preview_batch',
  description:
    'Preview, WITHOUT writing anything, how many rows of a sheet, table or WhatsApp operations log would enter the work registry: how many are new, how many were already there, which cannot be read and why, and which names have no Cortex account. Always call it before work.record_batch and tell the person the summary. Read-only.',
  inputSchema: batchInput,
  outputSchema: z.object({
    willCreate: z.number(),
    alreadyThere: z.number(),
    rejected: rejectedOut,
    withoutAccount: z.array(z.string()),
    sample: z.array(
      itemOut.omit({ id: true, overdue: true }).extend({ alreadyThere: z.boolean() }),
    ),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const [settings, people] = await Promise.all([readWorkSettings(ctx.db), workDirectory(ctx.db)]);
    const plan = planBatch(input, people, settings.measuredTypes, ctx.userId, today);
    const existing = await existingWorkByKeys(ctx.db, plan.drafts);
    const key = (d: WorkDraft) =>
      `${d.source.kind}\u0001${d.source.system ?? ''}\u0001${d.source.ref}`;
    const there = (d: WorkDraft) => existing.has(key(d));
    const alreadyThere = plan.drafts.filter(there).length;
    const names = new Map(people.map((p) => [p.id, personLabelOf(p)]));
    const sample = plan.drafts.slice(0, 20).map((d) => ({
      title: d.title,
      person: d.assigneeId
        ? (names.get(d.assigneeId) ?? '')
        : d.assigneeLabel
          ? `${d.assigneeLabel} (sin cuenta)`
          : 'Sin asignar',
      workType: d.workType,
      status: d.status,
      openedOn: dayOf(d.openedAt),
      dueOn: dayOf(d.dueAt),
      doneOn: dayOf(d.doneAt),
      quantity: d.quantity ?? null,
      unit: d.unit ?? null,
      source: WORK_SOURCE_LABEL[d.source.kind],
      alreadyThere: there(d),
    }));
    const willCreate = plan.drafts.length - alreadyThere;
    return {
      willCreate,
      alreadyThere,
      rejected: plan.rejected,
      withoutAccount: plan.withoutAccount,
      sample,
      guidance: [
        `${plan.drafts.length} fila(s) se pueden anotar: ${willCreate} nuevas y ${alreadyThere} que ya estaban (no se duplican).`,
        plan.rejected.length ? `${plan.rejected.length} no se pueden leer.` : '',
        plan.withoutAccount.length
          ? `Sin cuenta en Cortex (quedan sin responsable, con su nombre): ${plan.withoutAccount.join(', ')}.`
          : '',
        'Nada se escribió todavía.',
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
});

export const workRecordBatch = registerTool({
  id: 'work.record_batch',
  description:
    'Record many rows of team work at once (a sheet of dispatches, a WhatsApp operations log, a table export) into the work registry. Idempotent: rows already recorded (same source ref, or same facts) are not duplicated. Call work.preview_batch first. Requires confirmation.',
  inputSchema: batchInput,
  outputSchema: z.object({
    created: z.number(),
    updated: z.number(),
    unchanged: z.number(),
    rejected: rejectedOut,
    withoutAccount: z.array(z.string()),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 5 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const [settings, people] = await Promise.all([readWorkSettings(ctx.db), workDirectory(ctx.db)]);
    const plan = planBatch(input, people, settings.measuredTypes, ctx.userId, today);
    const r = await upsertWorkItems(ctx.db, plan.drafts, { recordedBy: ctx.userId });
    return {
      created: r.inserted.length,
      updated: r.updated.length,
      unchanged: r.unchanged,
      rejected: plan.rejected,
      withoutAccount: plan.withoutAccount,
      guidance: [
        `Anoté ${r.inserted.length} ítem(s) de trabajo nuevo(s)${r.updated.length ? ` y actualicé ${r.updated.length}` : ''}.`,
        r.unchanged ? `${r.unchanged} ya estaban igual y no se duplicaron.` : '',
        plan.rejected.length ? `${plan.rejected.length} fila(s) no se pudieron anotar.` : '',
        plan.withoutAccount.length
          ? `Sin cuenta en Cortex: ${plan.withoutAccount.join(', ')} (quedaron sin responsable).`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
});

// ---------------------------------------------------------------------------
// work.assign
// ---------------------------------------------------------------------------

export const workAssign = registerTool({
  id: 'work.assign',
  description:
    'Reassign work items to another person of the team (by item id from work.query). The change is made in the source when there is one (a commitment changes owner; a table row changes its responsible field) and the new person is notified. Management cases are reassigned in Gerencia (management.record) and approvals cannot be reassigned. An admin or the company owner can reassign anything; anyone else only their own items. Requires confirmation.',
  inputSchema: z.object({
    itemIds: z.array(z.string().uuid()).min(1).max(100),
    person: z.string().trim().min(1).max(160).describe('Who takes it: a name, an email or "yo".'),
  }),
  outputSchema: z.object({
    assigned: z.number(),
    refused: z.array(z.object({ id: z.string(), title: z.string(), reason: z.string() })),
    notified: z.boolean(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const [people, admin, settings] = await Promise.all([
      workDirectory(ctx.db),
      isWorkAdmin(ctx.db, ctx.userId),
      readWorkSettings(ctx.db),
    ]);
    const who = personOrSelf(people, input.person, ctx.userId, { allowUnknown: false });
    if (!who.id) throw new NotFoundError('Esa persona no está en el equipo.');
    const found = await getWorkItemsByIds(ctx.db, input.itemIds);
    const missing = input.itemIds.filter((id) => !found.some((i) => i.id === id));
    const refused: Array<{ id: string; title: string; reason: string }> = missing.map((id) => ({
      id,
      title: '',
      reason: 'No está en el registro de trabajo.',
    }));
    const allowed = found.filter((i) => {
      if (admin || i.assigneeId === ctx.userId) return true;
      refused.push({
        id: i.id,
        title: i.title,
        reason:
          'Sólo puedes pasar a otra persona tu propio trabajo; lo de los demás lo reasigna un administrador.',
      });
      return false;
    });
    const before = new Map(allowed.map((i) => [i.id, i.assigneeId]));
    const outcome = await reassignWorkItems(ctx.db, {
      items: allowed,
      assignee: { id: who.id, label: who.label ?? '' },
      mappings: settings.trackerMappings,
    });
    refused.push(...outcome.refused);
    const changed = outcome.assigned.filter((i) => before.get(i.id) !== who.id);
    let notified = false;
    if (changed.length && who.id !== ctx.userId) {
      notified = Boolean(
        await ctx.enqueueJob?.('work/assigned', {
          organizationId: ctx.organizationId,
          assigneeId: who.id,
          assignedBy: ctx.userId,
          itemIds: changed.map((i) => i.id),
          at: new Date().toISOString(),
        }),
      );
    }
    return {
      assigned: outcome.assigned.length,
      refused,
      notified,
      markdown: [
        outcome.assigned.length
          ? `Pasé ${outcome.assigned.length} ítem(s) a ${who.label}:\n${outcome.assigned.map((i) => `- ${i.title}`).join('\n')}`
          : 'No pasé nada.',
        notified ? `Le avisé a ${who.label} en la campana.` : '',
        refused.length
          ? `No pude pasar ${refused.length}:\n${refused.map((r) => `- ${r.title || r.id}: ${r.reason}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});

// ---------------------------------------------------------------------------
// work.suggest_mapping
// ---------------------------------------------------------------------------

export const workSuggestMapping = registerTool({
  id: 'work.suggest_mapping',
  description:
    'Propose how a company-specific table (trackers) becomes work in the work registry: which field says who is responsible, which is the status and which values mean done, the due date and the quantity. Read-only: show the proposal to the person, then an admin applies it with work.configure (mapTracker).',
  inputSchema: z.object({
    tracker: z.string().trim().min(2).max(48).describe('The table slug, e.g. "despachos".'),
  }),
  outputSchema: z.object({
    tracker: z.object({ slug: z.string(), name: z.string() }),
    assigneeCandidates: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        matchedPeople: z.number(),
        filled: z.number(),
        reason: z.string(),
      }),
    ),
    mapping: z.record(z.unknown()).nullable(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const tracker = await getTrackerBySlug(ctx.db, input.tracker);
    if (!tracker) throw new NotFoundError(`No hay una tabla «${input.tracker}» en este espacio.`);
    const [rows, people] = await Promise.all([
      queryRows(ctx.db, { trackerId: tracker.id, limit: 200 }),
      workDirectory(ctx.db),
    ]);
    const proposal = proposeTrackerMapping(tracker.fields, rows, people);
    const label = (key: string | null) =>
      key ? (tracker.fields.find((f) => f.key === key)?.label ?? key) : '—';
    const m = proposal.mapping;
    return {
      tracker: { slug: tracker.slug, name: tracker.name },
      assigneeCandidates: proposal.assigneeCandidates,
      mapping: m ? { tracker: tracker.slug, ...m } : null,
      markdown: [
        m
          ? [
              `Propuesta para **${tracker.name}**:`,
              `- Responsable: ${label(m.assigneeField)}`,
              `- Estado: ${label(m.statusField)}${m.doneValues.length ? ` (hecho = ${m.doneValues.join(', ')})` : ''}`,
              `- Vence: ${label(m.dueField)}`,
              `- Cantidad: ${label(m.quantityField)}`,
            ].join('\n')
          : `No encontré en **${tracker.name}** un campo que diga quién responde.`,
        ...proposal.notes,
        'Falta decir qué tipo de trabajo es (p. ej. «despacho»). Nada se cambió todavía.',
      ].join('\n'),
    };
  },
});

// ---------------------------------------------------------------------------
// work.configure
// ---------------------------------------------------------------------------

export const workConfigure = registerTool({
  id: 'work.configure',
  description:
    'Configure the work registry (admins and the company owner only): which work types are measured (others are not stored), which Cortex sources feed it (management cases, commitments, table rows, approvals), who sees whose work (self, team or all; admins always see everything), and map a company table to work (mapTracker: which field is the responsible, status + done values, due date, quantity + unit, work type) or unmap one. Mapping a table loads its rows right away. Use work.suggest_mapping first. Requires confirmation.',
  inputSchema: z.object({
    measuredTypes: z
      .array(workTypeSchema)
      .max(60)
      .nullable()
      .optional()
      .describe('Only these work types are measured. null = all.'),
    sources: z.array(z.enum(SYNCED_SOURCES)).optional(),
    teamVisibility: z.enum(TEAM_VISIBILITY).optional(),
    mapTracker: trackerMappingSchema.optional(),
    unmapTracker: z.string().trim().min(2).max(48).optional(),
  }),
  outputSchema: z.object({
    settings: z.object({
      measuredTypes: z.array(z.string()).nullable(),
      sources: z.array(z.string()),
      teamVisibility: z.string(),
      trackers: z.array(z.object({ tracker: z.string(), workType: z.string() })),
    }),
    loaded: z.number().nullable(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireAdmin(ctx, 'decidir qué trabajo se mide y cómo');
    const current = await readWorkSettings(ctx.db);
    let mappings = current.trackerMappings;
    const notes: string[] = [];

    const mapTracker = input.mapTracker ? trackerMappingSchema.parse(input.mapTracker) : null;
    if (mapTracker) {
      const m = mapTracker;
      const tracker = await getTrackerBySlug(ctx.db, m.tracker);
      if (!tracker) throw new NotFoundError(`No hay una tabla «${m.tracker}» en este espacio.`);
      const fieldOf = (key: string | null, what: string, types?: string[]) => {
        if (!key) return null;
        const f = tracker.fields.find((x) => x.key === key);
        if (!f)
          throw new ValidationError(
            `«${key}» no es un campo de ${tracker.name} (${what}). Campos: ${tracker.fields.map((x) => x.key).join(', ')}.`,
          );
        if (types && !types.includes(f.type))
          throw new ValidationError(`«${f.label}» no sirve como ${what}: es de tipo ${f.type}.`);
        return f;
      };
      fieldOf(m.assigneeField, 'responsable', ['text', 'select']);
      const status = fieldOf(m.statusField, 'estado', ['text', 'select']);
      fieldOf(m.dueField, 'vencimiento', ['date', 'text']);
      fieldOf(m.quantityField, 'cantidad', ['number', 'money']);
      fieldOf(m.titleField, 'título', ['text', 'select']);
      fieldOf(m.teamField, 'equipo', ['text', 'select']);
      fieldOf(m.doneAtField, 'fecha de cierre', ['date', 'text']);
      fieldOf(m.openedAtField, 'fecha de apertura', ['date', 'text']);
      if (status?.options?.length) {
        const unknown = [...m.doneValues, ...m.cancelledValues].filter(
          (v) => !status.options?.some((o) => foldText(o) === foldText(v)),
        );
        if (unknown.length)
          throw new ValidationError(
            `«${unknown.join('», «')}» no es una opción de ${status.label} (${status.options.join(', ')}).`,
          );
      }
      if (m.statusField && !m.doneValues.length)
        notes.push('Sin valores de «hecho», ninguna fila de esa tabla contará como cerrada.');
      mappings = [...mappings.filter((x) => x.tracker !== m.tracker), m];
    }
    if (input.unmapTracker) {
      mappings = mappings.filter((x) => x.tracker !== input.unmapTracker);
      const { error } = await ctx.db
        .from('work_items')
        .delete()
        .eq('source_kind', 'tracker_row')
        .eq('source_system', input.unmapTracker);
      if (error) throw error;
      notes.push(`La tabla «${input.unmapTracker}» ya no es trabajo: su registro se borró.`);
    }

    const saved = await saveWorkSettings(
      ctx.db,
      {
        measuredTypes: input.measuredTypes,
        sources: input.sources,
        teamVisibility: input.teamVisibility,
        trackerMappings: mapTracker || input.unmapTracker ? mappings : undefined,
      },
      ctx.userId,
    );

    let loaded: number | null = null;
    if (mapTracker) {
      const r = await syncWork(ctx.db, ctx.organizationId, { onlyTracker: mapTracker.tracker });
      const s = r.sources[`tracker_row:${mapTracker.tracker}`];
      loaded = s ? s.inserted + s.updated + s.unchanged : 0;
      notes.push(
        `Cargué ${loaded} ítem(s) de trabajo de «${mapTracker.tracker}» como «${mapTracker.workType}».`,
        ...r.warnings,
      );
    }

    return {
      settings: {
        measuredTypes: saved.measuredTypes,
        sources: saved.sources,
        teamVisibility: saved.teamVisibility,
        trackers: saved.trackerMappings.map((m) => ({ tracker: m.tracker, workType: m.workType })),
      },
      loaded,
      markdown: [
        'Registro de trabajo configurado:',
        `- Se mide: ${saved.measuredTypes ? saved.measuredTypes.join(', ') : 'todo tipo de trabajo'}.`,
        `- Fuentes: ${saved.sources.map((s) => WORK_SOURCE_LABEL[s]).join(', ') || 'ninguna'}.`,
        `- Visibilidad: ${TEAM_VISIBILITY_LABEL[saved.teamVisibility]} (quien administra ve todo; cada quien ve todo lo suyo).`,
        saved.trackerMappings.length
          ? `- Tablas que son trabajo: ${saved.trackerMappings.map((m) => `${m.tracker} (${m.workType})`).join(', ')}.`
          : '',
        ...notes,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});

// ---------------------------------------------------------------------------
// work.update_person
// ---------------------------------------------------------------------------

export const workUpdatePerson = registerTool({
  id: 'work.update_person',
  description:
    "Set a person's team, role label or away days (vacation, sick leave — away days do not count against them in work metrics). Anyone can add or remove their OWN away days; team, role and other people's data only an admin or the company owner. Requires confirmation.",
  inputSchema: z.object({
    person: z
      .string()
      .trim()
      .max(160)
      .optional()
      .describe('Name, email or "yo". Omit for the person asking.'),
    team: z.string().trim().max(80).nullable().optional(),
    role: z.string().trim().max(80).nullable().optional(),
    addAwayDays: z.array(dateSchema).max(120).optional(),
    removeAwayDays: z.array(dateSchema).max(120).optional(),
  }),
  outputSchema: z.object({
    person: z.string(),
    team: z.string().nullable(),
    role: z.string().nullable(),
    awayDays: z.array(z.string()),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const [people, admin] = await Promise.all([
      workDirectory(ctx.db),
      isWorkAdmin(ctx.db, ctx.userId),
    ]);
    const who = personOrSelf(people, input.person, ctx.userId, { allowUnknown: false });
    if (!who.id) throw new NotFoundError('Esa persona no está en el equipo.');
    const meta = await updateWorkPerson(ctx.db, {
      actor: { id: ctx.userId, admin },
      userId: who.id,
      change: {
        team: input.team,
        roleLabel: input.role,
        addAwayDays: input.addAwayDays,
        removeAwayDays: input.removeAwayDays,
      },
    });
    const today = bogotaToday();
    const upcoming = meta.awayDays.filter((d) => d >= today);
    return {
      person: who.label ?? '',
      team: meta.team,
      role: meta.roleLabel,
      awayDays: meta.awayDays,
      markdown: [
        `Listo, ${who.label}:`,
        `- Equipo: ${meta.team ?? '—'} · Cargo: ${meta.roleLabel ?? '—'}`,
        `- Días fuera próximos: ${upcoming.length ? upcoming.join(', ') : 'ninguno'} (no cuentan en contra).`,
      ].join('\n'),
    };
  },
});

// ---------------------------------------------------------------------------
// work.query
// ---------------------------------------------------------------------------

/** Si el registro lleva más de esto sin refrescarse, se sincroniza antes de contestar. */
const STALE_MS = 6 * 3_600_000;

export const workQuery = registerTool({
  id: 'work.query',
  description:
    'Read the work registry: items by person, work type and status (open, done, overdue, unassigned). Everyone sees all their own work; admins and the company owner see the whole team (and unassigned work); others see their team only if the company allows it. Use it for «¿qué tengo pendiente?», «¿qué tiene vencido Laura?», «¿qué hay sin asignar?», «¿cuántas guías despachó el equipo esta semana?». Read-only.',
  inputSchema: z.object({
    person: z
      .string()
      .trim()
      .max(160)
      .optional()
      .describe('Name, email or "yo". Omit = everyone you can see.'),
    workType: z.string().trim().max(60).optional(),
    status: z.enum(['open', 'overdue', 'done', 'unassigned', 'cancelled', 'all']).default('open'),
    since: dateSchema.optional().describe('With status=done: closed since this day.'),
    limit: z.number().int().min(1).max(200).default(40),
  }),
  outputSchema: z.object({
    items: z.array(itemOut),
    counts: z.object({ open: z.number(), overdue: z.number(), done: z.number() }),
    output: z.array(z.object({ unit: z.string(), total: z.number() })),
    scope: z.enum(['own', 'team', 'all']),
    truncated: z.boolean(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 40 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    let settings = await readWorkSettings(ctx.db);
    const warnings: string[] = [];
    if (workSyncIsStale(settings.lastSyncedAt, new Date(), STALE_MS)) {
      try {
        const r = await syncWork(ctx.db, ctx.organizationId);
        warnings.push(...r.warnings);
        settings = await readWorkSettings(ctx.db);
      } catch {
        warnings.push('No pude refrescar el registro ahora; muestro lo último que tenía.');
      }
    }
    const [scope, people] = await Promise.all([
      workScope(ctx.db, ctx.userId),
      workDirectory(ctx.db),
    ]);
    const names = new Map(people.map((p) => [p.id, personLabelOf(p)]));

    let assigneeIds = scopeAssigneeIds(scope);
    let personLabel: string | null = null;
    if (input.person) {
      const who = personOrSelf(people, input.person, ctx.userId, { allowUnknown: false });
      if (!who.id || !canSeeAssignee(scope, who.id))
        throw new ForbiddenError(
          'Cada persona ve todo su propio trabajo; el de los demás lo ve quien administra la empresa (o todos, si la empresa lo abrió).',
        );
      assigneeIds = [who.id];
      personLabel = who.label;
    }
    if (input.status === 'unassigned' && scope.visibleIds !== null)
      throw new ForbiddenError('Lo que no tiene responsable lo ve quien administra la empresa.');

    const workType = input.workType ? workTypeSchema.parse(input.workType) : null;
    const status =
      input.status === 'overdue' || input.status === 'unassigned'
        ? 'open'
        : input.status === 'all'
          ? null
          : input.status;
    const limit = input.limit ?? 40;
    const { items, truncated } = await listWorkItems(ctx.db, {
      assigneeIds: input.status === 'unassigned' ? null : assigneeIds,
      onlyUnassigned: input.status === 'unassigned',
      workType,
      status,
      doneSince: input.status === 'done' && input.since ? `${input.since}T00:00:00-05:00` : null,
      limit: input.status === 'overdue' ? 2000 : limit,
    });
    const visible = items
      .filter((i) => isMeasured(i.workType, settings.measuredTypes))
      .filter((i) => input.status === 'unassigned' || canSeeAssignee(scope, i.assigneeId))
      .map((i) => toOut(i, names, today));
    const chosen = (input.status === 'overdue' ? visible.filter((i) => i.overdue) : visible).slice(
      0,
      limit,
    );
    const output = new Map<string, number>();
    for (const i of chosen)
      if (i.status === 'done' && i.quantity !== null)
        output.set(i.unit ?? 'unidades', (output.get(i.unit ?? 'unidades') ?? 0) + i.quantity);
    const counts = {
      open: chosen.filter((i) => i.status === 'open').length,
      overdue: chosen.filter((i) => i.overdue).length,
      done: chosen.filter((i) => i.status === 'done').length,
    };
    const who =
      personLabel ??
      (scope.visibleIds === null
        ? 'el equipo'
        : scope.visibility === 'team' && (scope.visibleIds?.size ?? 0) > 1
          ? 'tu equipo'
          : 'ti');
    const statusWord: Record<string, string> = {
      open: 'pendiente',
      overdue: 'vencido',
      done: 'hecho',
      unassigned: 'sin asignar',
      cancelled: 'que ya no aplica',
      all: 'registrado',
    };
    return {
      items: chosen,
      counts,
      output: [...output].map(([unit, total]) => ({ unit, total })),
      scope: scope.visibleIds === null ? 'all' : (scope.visibleIds.size ?? 0) > 1 ? 'team' : 'own',
      truncated: truncated || visible.length > chosen.length,
      markdown: [
        chosen.length
          ? `Trabajo ${statusWord[input.status ?? 'open']} de ${who}${workType ? ` (${workType})` : ''}: ${chosen.length}${counts.overdue && input.status !== 'overdue' ? `, ${counts.overdue} vencido(s)` : ''}.`
          : `No hay trabajo ${statusWord[input.status ?? 'open']} de ${who}${workType ? ` (${workType})` : ''}.`,
        ...chosen.map(itemLine),
        output.size ? `Producido: ${[...output].map(([u, n]) => `${n} ${u}`).join(' · ')}.` : '',
        ...warnings,
        `Estados: ${Object.values(WORK_STATUS_LABEL).join(' / ')}.`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});
