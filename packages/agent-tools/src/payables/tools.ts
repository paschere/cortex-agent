import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../index';
import { mondayOf } from '../ledger/forecast-shared';
import type { ToolContext } from '../types';
import { draftFromManual } from './intake';
import {
  AWAITING_APPROVAL,
  OPEN_STATUSES,
  PAYABLE_STATUS_LABEL,
  type PayableInvoiceRow,
  type PayableStatus,
  adaptPayable,
  moneyCop,
  numberKey,
  shortDay,
  supplierNameKey,
} from './shape';
import {
  type DecisionResult,
  approvePayables,
  intakePayable,
  listPayables,
  loadPayPlan,
  rejectPayables,
  schedulePayables,
} from './store';

/**
 * CUENTAS POR PAGAR EN EL CHAT (migración 0181).
 *
 *   payables.inbox     «¿qué facturas de proveedor tengo por aprobar?»
 *   payables.pay_plan  «¿qué hay que pagar esta semana?»: el programa de pagos
 *                      con la caja proyectada de cada semana.
 *   payables.record    anotar una factura que la persona dicta (con confirmación).
 *   payables.approve   aprobar (con confirmación; nunca por mandato).
 *   payables.reject    rechazar con motivo (con confirmación).
 *   payables.schedule  programar el día de pago: el que sugiere la caja, o el
 *                      que diga la persona (con confirmación).
 *
 * Ninguna mueve plata. Pagar lo hace una persona en su banco; Cortex se entera
 * por el extracto.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const REFS = z
  .array(z.string().min(1).max(160))
  .min(1)
  .max(25)
  .describe(
    'Las facturas: su id (de payables.inbox) o su número tal como lo dijo la persona («FEPA-451»). Hasta 25.',
  );

const itemSchema = z.object({
  id: z.string(),
  supplier: z.string(),
  number: z.string(),
  status: z.string(),
  total: z.number(),
  net: z.number().describe('Lo que sale del banco: total menos retenciones'),
  currency: z.string(),
  dueDate: z.string().nullable(),
  scheduledPayDate: z.string().nullable(),
  flags: z.array(z.string()).describe('Lo que la revisión encontró, lo más grave primero'),
});

function toItem(row: PayableInvoiceRow) {
  const inv = adaptPayable(row);
  const order = { block: 0, warn: 1, info: 2 } as const;
  return {
    id: inv.id,
    supplier: inv.supplierName,
    number: inv.docNumber,
    status: PAYABLE_STATUS_LABEL[inv.status],
    total: inv.total,
    net: inv.netAmount,
    currency: inv.currency,
    dueDate: inv.dueDate,
    scheduledPayDate: inv.scheduledPayDate,
    flags: [...inv.checks]
      .sort((a, b) => order[a.severity] - order[b.severity])
      .filter((c) => c.code !== 'po_match')
      .map((c) => c.message)
      .slice(0, 4),
  };
}

/** Ids o números de factura → ids. Un número que es de dos proveedores es ambiguo. */
async function resolveRefs(ctx: ToolContext, refs: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  const numbers = refs.filter((r) => !UUID_RE.test(r.trim()));
  ids.push(...refs.filter((r) => UUID_RE.test(r.trim())).map((r) => r.trim()));
  if (!numbers.length) return [...new Set(ids)];
  const { data, error } = await ctx.db
    .from('payable_invoices')
    .select('id, doc_number, supplier_name, status')
    .neq('status', 'pagada')
    .limit(2000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; doc_number: string; supplier_name: string }>;
  for (const n of numbers) {
    const key = numberKey(n);
    const hits = rows.filter((r) => numberKey(r.doc_number) === key);
    if (hits.length === 0)
      throw new Error(`No encontré la factura «${n}». Pide el listado con payables.inbox.`);
    if (hits.length > 1)
      throw new Error(
        `«${n}» es de más de un proveedor (${hits.map((h) => h.supplier_name).join(', ')}). Usa el id de payables.inbox.`,
      );
    ids.push((hits[0] as { id: string }).id);
  }
  return [...new Set(ids)];
}

function describeDecision(r: DecisionResult, verb: string): string {
  const parts: string[] = [];
  if (r.done.length)
    parts.push(
      `${verb} ${r.done.length === 1 ? 'la factura' : `${r.done.length} facturas`}: ${r.done
        .slice(0, 6)
        .map((d) => `${d.supplierName} ${d.docNumber}`)
        .join(', ')}${r.done.length > 6 ? '…' : ''}.`,
    );
  if (r.skipped.length)
    parts.push(`No toqué ${r.skipped.length}: ${r.skipped.map((s) => s.reason).join(' ')}`);
  return parts.join(' ') || 'No cambió nada.';
}

const decisionSchema = z.object({
  done: z.array(
    z.object({
      id: z.string(),
      docNumber: z.string(),
      supplierName: z.string(),
      status: z.string(),
    }),
  ),
  skipped: z.array(z.object({ id: z.string(), docNumber: z.string(), reason: z.string() })),
  guidance: z.string(),
});

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

const INBOX_FILTER: Record<string, readonly PayableStatus[]> = {
  por_aprobar: AWAITING_APPROVAL,
  aprobadas: ['aprobada'],
  programadas: ['programada'],
  abiertas: OPEN_STATUSES,
  pagadas: ['pagada'],
  rechazadas: ['rechazada'],
};

export const payablesInbox = registerTool({
  id: 'payables.inbox',
  description:
    'Supplier invoices (cuentas por pagar) and where each one is: por revisar, por aprobar, aprobada, programada, pagada, rechazada — with what the automatic review found (possible double billing, invoice addressed to another NIT, price jump vs. the last purchase, missing withholding, mismatch with the purchase order). Use for «¿qué facturas de proveedor tengo por aprobar?», «¿qué le debemos a X?», «¿llegó la factura de Y?». Read-only. Invoices arrive by themselves from email (DIAN e-invoice ZIP/XML), the Bandeja and the accounting program.',
  inputSchema: z.object({
    filter: z
      .enum(['por_aprobar', 'aprobadas', 'programadas', 'abiertas', 'pagadas', 'rechazadas'])
      .default('abiertas'),
    supplier: z
      .string()
      .max(160)
      .optional()
      .describe('Nombre o NIT del proveedor, si preguntan por uno'),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  outputSchema: z.object({
    counts: z.record(z.number()),
    awaitingAmount: z.number(),
    items: z.array(itemSchema),
    guidance: z.string(),
  }),
  handler: async (input, ctx) => {
    const filter = input.filter ?? 'abiertas';
    const all = await listPayables(ctx.db, { statuses: OPEN_STATUSES, limit: 2000 });
    const counts: Record<string, number> = {};
    for (const r of all)
      counts[PAYABLE_STATUS_LABEL[r.status]] = (counts[PAYABLE_STATUS_LABEL[r.status]] ?? 0) + 1;
    let rows =
      filter === 'pagadas' || filter === 'rechazadas'
        ? await listPayables(ctx.db, { statuses: INBOX_FILTER[filter], limit: 500 })
        : all.filter((r) => (INBOX_FILTER[filter] ?? OPEN_STATUSES).includes(r.status));
    if (input.supplier) {
      const nit = input.supplier.replace(/\D/g, '');
      const key = supplierNameKey(input.supplier);
      rows = rows.filter(
        (r) =>
          (nit.length >= 6 && (r.supplier_nit ?? '').startsWith(nit.slice(0, 9))) ||
          supplierNameKey(r.supplier_name).includes(key),
      );
    }
    const awaiting = all.filter((r) => AWAITING_APPROVAL.includes(r.status));
    const awaitingAmount = awaiting.reduce((s, r) => s + adaptPayable(r).netAmount, 0);
    const items = rows.slice(0, input.limit ?? 30).map(toItem);
    const firstDue = awaiting
      .map((r) => r.due_date)
      .filter((d): d is string => Boolean(d))
      .sort()[0];
    const guidance = awaiting.length
      ? `${awaiting.length} factura${awaiting.length === 1 ? '' : 's'} de proveedor esperan aprobación (${moneyCop(awaitingAmount)} neto)${firstDue ? `; la primera vence el ${shortDay(firstDue)}` : ''}. Para aprobar, payables.approve; para fijar el día de pago, payables.schedule.`
      : items.length
        ? 'Nada espera aprobación.'
        : 'No hay facturas de proveedor en ese estado.';
    return { counts, awaitingAmount: Math.round(awaitingAmount), items, guidance };
  },
});

export const payablesPayPlan = registerTool({
  id: 'payables.pay_plan',
  description:
    "The supplier payment plan («Programa de pagos»): scheduled supplier payments grouped by week with each week's total against the projected cash (opening, closing, minimum cash), plus approved invoices still without a pay date and what awaits approval. Use for «¿qué hay que pagar esta semana?», «¿cuánto le pagamos a proveedores la próxima semana?», «¿alcanza la caja para los pagos?». Read-only.",
  inputSchema: z.object({
    week: DAY.optional().describe(
      'Cualquier día de la semana que preguntan; por defecto, esta semana',
    ),
    weeks: z.number().int().min(1).max(13).default(4).describe('Cuántas semanas mostrar desde esa'),
  }),
  outputSchema: z.object({
    minimumCash: z.number(),
    weeks: z.array(
      z.object({
        start: z.string(),
        total: z.number(),
        closing: z.number().nullable(),
        belowMinimum: z.boolean(),
        payments: z.array(
          z.object({
            supplier: z.string(),
            number: z.string(),
            amount: z.number(),
            date: z.string(),
          }),
        ),
      }),
    ),
    unscheduled: z.array(
      z.object({
        id: z.string(),
        supplier: z.string(),
        number: z.string(),
        amount: z.number(),
        dueDate: z.string().nullable(),
      }),
    ),
    awaiting: z.object({ count: z.number(), amount: z.number(), firstDue: z.string().nullable() }),
    guidance: z.string(),
  }),
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const plan = await loadPayPlan(ctx.db, { today });
    const from = mondayOf(input.week ?? today);
    const shown = plan.weeks.filter((w) => w.start >= from).slice(0, input.weeks ?? 4);
    const first = shown.find((w) => w.start === from);
    const notes: string[] = [];
    notes.push(
      first
        ? `Semana del ${shortDay(first.start)}: ${first.items.length} pago${first.items.length === 1 ? '' : 's'} por ${moneyCop(first.total)}${first.closing != null ? `; la caja cerraría en ${moneyCop(first.closing)}${first.belowMinimum ? `, DEBAJO del mínimo (${moneyCop(plan.minimumCash)})` : ''}` : ''}.`
        : `No hay pagos a proveedores programados la semana del ${shortDay(from)}.`,
    );
    if (plan.unscheduled.length)
      notes.push(
        `${plan.unscheduled.length} aprobada${plan.unscheduled.length === 1 ? '' : 's'} sin día de pago (payables.schedule la programa contra la caja).`,
      );
    if (plan.awaiting.count)
      notes.push(`${plan.awaiting.count} esperan aprobación (${moneyCop(plan.awaiting.amount)}).`);
    notes.push('Cortex no paga: los pagos los hace una persona en el banco.');
    return {
      minimumCash: plan.minimumCash,
      weeks: shown.map((w) => ({
        start: w.start,
        total: w.total,
        closing: w.closing,
        belowMinimum: w.belowMinimum,
        payments: w.items.map((i) => ({
          supplier: i.supplierName,
          number: i.docNumber,
          amount: i.amount,
          date: i.date,
        })),
      })),
      unscheduled: plan.unscheduled.map((u) => ({
        id: u.id,
        supplier: u.supplierName,
        number: u.docNumber,
        amount: u.amount,
        dueDate: u.dueDate,
      })),
      awaiting: plan.awaiting,
      guidance: notes.join(' '),
    };
  },
});

// ---------------------------------------------------------------------------
// Escrituras (con confirmación)
// ---------------------------------------------------------------------------

export const payablesRecord = registerTool({
  id: 'payables.record',
  description:
    'Record a supplier invoice the person dictates or pastes («llegó la factura 1234 de Papelería El Cóndor por 2.380.000, vence el 28»). It enters the approval flow with the same automatic review as one that arrives by email, and is never duplicated (same supplier + number, or same CUFE, is recognised). Do NOT use for invoices the company ISSUED (those are sales). Requires confirmation.',
  inputSchema: z.object({
    supplierName: z.string().min(2).max(200),
    supplierNit: z
      .string()
      .max(30)
      .optional()
      .describe('NIT del proveedor, con o sin dígito de verificación'),
    number: z.string().min(1).max(120).describe('Número de la factura del proveedor'),
    issueDate: DAY,
    dueDate: DAY.optional(),
    total: z.number().positive().describe('Total a pagar de la factura, con IVA'),
    iva: z.number().min(0).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('COP'),
    orderReference: z.string().max(120).optional().describe('Orden de compra que cita, si la cita'),
    note: z.string().max(500).optional(),
  }),
  outputSchema: z.object({
    id: z.string(),
    created: z.boolean(),
    status: z.string(),
    flags: z.array(z.string()),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const draft = draftFromManual(
      {
        supplierName: input.supplierName,
        supplierNit: input.supplierNit ?? null,
        docNumber: input.number,
        issueDate: input.issueDate,
        dueDate: input.dueDate ?? null,
        total: input.total,
        iva: input.iva ?? null,
        currency: input.currency ?? 'COP',
        orderReference: input.orderReference ?? null,
        note: input.note ?? null,
      },
      {
        source: 'chat',
        ref: `chat:${ctx.conversationId ?? ctx.userId}:${numberKey(input.number)}:${supplierNameKey(input.supplierName)}`,
      },
    );
    const r = await intakePayable(ctx.db, draft, { today: bogotaToday(), userId: ctx.userId });
    const item = toItem(r.invoice);
    return {
      id: r.invoice.id,
      created: r.outcome === 'creada',
      status: item.status,
      flags: item.flags,
      guidance:
        r.outcome === 'creada'
          ? `Anotada la factura ${item.number} de ${item.supplier}: queda ${item.status.toLowerCase()}.${item.flags.length ? ` Ojo: ${item.flags[0]}` : ''}`
          : `Esa factura ya estaba (${item.supplier} ${item.number}, ${item.status.toLowerCase()}); no la dupliqué.`,
    };
  },
});

export const payablesApprove = registerTool({
  id: 'payables.approve',
  description:
    "Approve supplier invoices: the person says they are owed and can be paid. Only the supplier's approver, an owner or an admin can approve. Before calling, tell the person what the automatic review flagged on each invoice (payables.inbox). Approving does NOT pay anything — then payables.schedule sets the pay date. Requires confirmation, always by a person.",
  inputSchema: z.object({ invoices: REFS }),
  outputSchema: decisionSchema,
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const ids = await resolveRefs(ctx, input.invoices);
    const r = await approvePayables(ctx.db, ids, { userId: ctx.userId });
    return {
      ...r,
      guidance: `${describeDecision(r, 'Aprobé')}${r.done.length ? ' Falta el día de pago: payables.schedule lo sugiere contra la caja.' : ''}`,
    };
  },
});

export const payablesReject = registerTool({
  id: 'payables.reject',
  description:
    "Reject supplier invoices that will not be paid (double billing, wrong NIT, not received, wrong price), with the reason in the person's words. Can be reopened later from /pagar. Requires confirmation.",
  inputSchema: z.object({
    invoices: REFS,
    reason: z.string().min(3).max(500).describe('Por qué no se paga, en palabras de la persona'),
  }),
  outputSchema: decisionSchema,
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const ids = await resolveRefs(ctx, input.invoices);
    const r = await rejectPayables(ctx.db, ids, { userId: ctx.userId, reason: input.reason });
    return { ...r, guidance: describeDecision(r, 'Rechacé') };
  },
});

export const payablesSchedule = registerTool({
  id: 'payables.schedule',
  description:
    "Set the pay date of approved supplier invoices. Without `date`, Cortex picks it: the due date, moved to a later week if paying then would leave the projected cash below the company's minimum (it says how many days late and why). With `date`, that day. Scheduling feeds the 13-week cash forecast. It never pays: the person pays at the bank and Cortex sees it in the statement. Requires confirmation.",
  inputSchema: z.object({
    invoices: REFS,
    date: DAY.optional().describe('El día que dijo la persona. Sin él, el que sugiere la caja.'),
    note: z.string().max(300).optional(),
  }),
  outputSchema: decisionSchema.extend({
    suggestions: z.array(
      z.object({
        id: z.string(),
        date: z.string(),
        lateDays: z.number(),
        belowMinimum: z.boolean(),
        reason: z.string(),
      }),
    ),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const ids = await resolveRefs(ctx, input.invoices);
    const r = await schedulePayables(ctx.db, ids, {
      userId: ctx.userId,
      today: bogotaToday(),
      date: input.date ?? null,
      note: input.note ?? null,
    });
    const notes = r.suggestions
      .filter((s) => ids.includes(s.id))
      .map((s) => s.reason)
      .slice(0, 4);
    return {
      done: r.done,
      skipped: r.skipped,
      suggestions: r.suggestions.map((s) => ({
        id: s.id,
        date: s.date,
        lateDays: s.lateDays,
        belowMinimum: s.belowMinimum,
        reason: s.reason,
      })),
      guidance: `${describeDecision(r, 'Programé')} ${input.date ? '' : notes.join(' ')}`.trim(),
    };
  },
});
