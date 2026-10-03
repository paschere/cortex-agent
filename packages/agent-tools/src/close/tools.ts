import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../index';
import { numberKey } from '../payables/shape';
import type { ToolContext } from '../types';
import { CLOSE_TASK_KEYS, isPeriod, periodLabel } from './shape';
import {
  closePeriod,
  computeClose,
  currentClosePeriod,
  markCloseTask,
  reopenPeriod,
} from './store';
import { PROVIDER_LABEL, type WritebackKind, type WritebackProvider } from './writeback/shape';
import { executeWriteback, loadWritebackQueue, prepareWriteback } from './writeback/store';

/**
 * EL CIERRE DEL MES Y EL REGISTRO EN EL PROGRAMA CONTABLE, EN EL CHAT (0192).
 *
 *   close.status                     «¿cómo va el cierre de septiembre?»: la
 *                                    lista con lo que falta, la cola de lo que
 *                                    hay que registrar y, con `preview`, la
 *                                    partida exacta de una escritura.
 *   close.mark_task                  dar una tarea por hecha (con evidencia) o
 *                                    por no aplica (con confirmación).
 *   close.close_period               cerrar (o reabrir) el mes (confirmación
 *                                    obligatoria; sólo un administrador).
 *   accounting.write_purchase        causar facturas de proveedor aprobadas.
 *   accounting.write_receipt         registrar recibos de caja.
 *   accounting.write_supplier_payment registrar pagos a proveedores.
 *
 * Las tres escrituras salen de la empresa (al programa contable): confirmación
 * obligatoria, nunca desde una rutina, y la vista previa (close.status con
 * `preview`) se muestra antes.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .describe(
    'El mes como AAAA-MM. Sin él, el que toca cerrar (el anterior mientras no esté cerrado).',
  );
const PROVIDER = z
  .enum(['siigo', 'alegra', 'quickbooks'])
  .optional()
  .describe('Sólo si hay más de un programa contable conectado');

async function periodOrCurrent(ctx: ToolContext, period: string | undefined): Promise<string> {
  if (period) {
    if (!isPeriod(period))
      throw new ValidationError('El mes va como AAAA-MM, por ejemplo 2026-09.');
    return period;
  }
  return currentClosePeriod(ctx.db, bogotaToday());
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

const entrySchema = z.object({
  account: z.string(),
  accountName: z.string(),
  accountSource: z.string(),
  description: z.string(),
  debit: z.number(),
  credit: z.number(),
});

export const closeStatus = registerTool({
  id: 'close.status',
  description:
    "Month-end close («cierre del mes»): the guided checklist for a month with each task's automatic check against the data (bank statements imported through month end, bank credits not matched to an invoice, supplier invoices awaiting approval or not yet booked, customer payments without a cash receipt in the accounting program, supplier payments not registered, uncategorized ledger movements, payroll, taxes due, inventory count, accrual and depreciation reminders), progress x/y and whether the month is closed. Also returns the write-back queue: what Cortex can register in Siigo/Alegra/QuickBooks (purchases to book, cash receipts, supplier payments). With `preview` it returns the exact journal entry (accounts, debits, credits) and blockers of ONE write — show it before calling accounting.write_*. Read-only.",
  inputSchema: z.object({
    period: PERIOD.optional(),
    preview: z
      .object({
        kind: z.enum(['compra', 'recibo', 'pago_proveedor']),
        id: z.string().min(1).max(80).describe('sourceId de la cola'),
      })
      .optional()
      .describe('La vista previa de una escritura de la cola'),
  }),
  outputSchema: z.object({
    period: z.string(),
    label: z.string(),
    status: z.string(),
    progress: z.object({ done: z.number(), total: z.number() }),
    tasks: z.array(
      z.object({
        key: z.string(),
        title: z.string(),
        ready: z.boolean(),
        status: z.string(),
        check: z.string(),
        detail: z.string(),
        fixPrompt: z.string(),
      }),
    ),
    queue: z.object({
      provider: z.string().nullable(),
      items: z.array(
        z.object({
          kind: z.string(),
          id: z.string(),
          label: z.string(),
          date: z.string(),
          amount: z.number(),
          status: z.string(),
          error: z.string().nullable(),
        }),
      ),
    }),
    preview: z
      .object({
        label: z.string(),
        provider: z.string(),
        date: z.string(),
        amount: z.number(),
        entries: z.array(entrySchema),
        problems: z.array(z.string()),
        warnings: z.array(z.string()),
      })
      .nullable(),
    href: z.string(),
    guidance: z.string(),
  }),
  handler: async (input, ctx) => {
    const period = await periodOrCurrent(ctx, input.period);
    const [view, queue] = await Promise.all([
      computeClose(ctx.db, period),
      loadWritebackQueue(ctx.db, { period }).catch(() => null),
    ]);
    let preview = null;
    if (input.preview) {
      const p = await prepareWriteback(
        ctx.db,
        input.preview.kind as WritebackKind,
        input.preview.id,
      );
      preview = {
        label: p.preview.label,
        provider: PROVIDER_LABEL[p.preview.provider],
        date: p.preview.date,
        amount: p.preview.amount,
        entries: p.preview.entries.map((e) => ({
          account: e.account,
          accountName: e.accountName,
          accountSource: e.accountSource === 'defecto' ? 'defecto de Cortex' : e.accountSource,
          description: e.description,
          debit: e.debit,
          credit: e.credit,
        })),
        problems: p.preview.problems,
        warnings: p.preview.warnings,
      };
    }
    const missing = view.tasks.filter((t) => !t.ready);
    const notes = [
      `${view.headline} (${view.progress.done}/${view.progress.total}).`,
      view.status === 'cerrado'
        ? `${view.label} está cerrado: los cambios de Cortex con fecha de ese mes están bloqueados.`
        : missing.length
          ? `Falta: ${missing
              .map((t) => t.title)
              .slice(0, 5)
              .join('; ')}.`
          : 'Todo listo: close.close_period lo cierra (lo aprueba un administrador).',
      queue?.provider && queue.items.length
        ? `${queue.items.length} cosa${queue.items.length === 1 ? '' : 's'} por registrar en ${queue.providerName}; muestra la vista previa (preview) antes de accounting.write_*.`
        : (queue?.guidance ?? ''),
    ];
    return {
      period,
      label: view.label,
      status: view.status,
      progress: view.progress,
      tasks: view.tasks.map((t) => ({
        key: t.key,
        title: t.title,
        ready: t.ready,
        status: t.status,
        check: t.auto.state,
        detail: t.auto.detail,
        fixPrompt: t.fix.prompt,
      })),
      queue: {
        provider: queue?.providerName ?? null,
        items: (queue?.items ?? []).slice(0, 25).map((i) => ({
          kind: i.kind,
          id: i.sourceId,
          label: i.label,
          date: i.date,
          amount: i.amount,
          status: i.status,
          error: i.error,
        })),
      },
      preview,
      href: `/cierre?mes=${period}`,
      guidance: notes.filter(Boolean).join(' '),
    };
  },
});

// ---------------------------------------------------------------------------
// La lista
// ---------------------------------------------------------------------------

export const closeMarkTask = registerTool({
  id: 'close.mark_task',
  description:
    'Mark a month-end close task as done (with evidence — required when the automatic check still sees it pending, e.g. «el abono de $1.2M es un préstamo del socio»), as not applicable this month (with the reason), or back to pending. Fails on a closed month. Requires confirmation.',
  inputSchema: z.object({
    period: PERIOD.optional(),
    task: z.enum(CLOSE_TASK_KEYS),
    status: z.enum(['hecha', 'no_aplica', 'pendiente']),
    evidence: z
      .string()
      .max(2000)
      .optional()
      .describe('Qué se hizo o por qué no aplica, en palabras de la persona'),
  }),
  outputSchema: z.object({
    period: z.string(),
    progress: z.object({ done: z.number(), total: z.number() }),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const period = await periodOrCurrent(ctx, input.period);
    const view = await markCloseTask(ctx.db, {
      period,
      key: input.task,
      status: input.status,
      evidence: input.evidence ?? null,
      userId: ctx.userId,
    });
    return {
      period,
      progress: view.progress,
      guidance: `${view.headline} (${view.progress.done}/${view.progress.total}).`,
    };
  },
});

export const closeClosePeriod = registerTool({
  id: 'close.close_period',
  description:
    'Close a month (only when every checklist task is ready: automatically up to date, done with evidence, or not applicable) — closing locks Cortex-side changes dated in that month (ledger entries, recategorizations, write-backs to the accounting program); or reopen a closed month with a reason. Only an owner or admin. Never from a routine. Requires confirmation, always by a person.',
  inputSchema: z.object({
    period: PERIOD.optional(),
    action: z.enum(['cerrar', 'reabrir']).default('cerrar'),
    reason: z
      .string()
      .max(500)
      .optional()
      .describe('Al reabrir: por qué. Al cerrar: una nota opcional.'),
  }),
  outputSchema: z.object({
    period: z.string(),
    status: z.string(),
    href: z.string(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    if (ctx.surface === 'schedule')
      throw new ValidationError(
        'El mes no se cierra ni se reabre desde una rutina: pídemelo en el chat o en /cierre.',
      );
    const period = await periodOrCurrent(ctx, input.period);
    if ((input.action ?? 'cerrar') === 'reabrir') {
      const view = await reopenPeriod(ctx.db, {
        period,
        userId: ctx.userId,
        reason: input.reason ?? '',
      });
      return {
        period,
        status: view.status,
        href: `/cierre?mes=${period}`,
        guidance: `Reabrí ${view.label}: se puede volver a cambiar.`,
      };
    }
    const r = await closePeriod(ctx.db, { period, userId: ctx.userId, note: input.reason ?? null });
    return {
      period,
      status: r.view.status,
      href: `/cierre?mes=${period}`,
      guidance: r.closed
        ? `Cerré ${r.view.label} (${r.view.progress.done}/${r.view.progress.total}). Los cambios de Cortex con fecha de ese mes quedan bloqueados; el informe del cierre está en /cierre.`
        : `${periodLabel(period)} ya estaba cerrado.`,
    };
  },
});

// ---------------------------------------------------------------------------
// Las escrituras en el programa contable
// ---------------------------------------------------------------------------

const writeOutput = z.object({
  done: z.array(
    z.object({ id: z.string(), label: z.string(), providerNumber: z.string().nullable() }),
  ),
  failed: z.array(z.object({ id: z.string(), reason: z.string() })),
  guidance: z.string(),
});

/** Ids, o números de factura de proveedor («FEPA-451»), a ids. */
async function payableIds(ctx: ToolContext, refs: readonly string[]): Promise<string[]> {
  const ids = refs.filter((r) => UUID_RE.test(r.trim())).map((r) => r.trim());
  const numbers = refs.filter((r) => !UUID_RE.test(r.trim()));
  if (numbers.length) {
    const { data, error } = await ctx.db
      .from('payable_invoices')
      .select('id, doc_number, supplier_name')
      .in('status', ['aprobada', 'programada', 'pagada'])
      .limit(3000);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id: string; doc_number: string; supplier_name: string }>;
    for (const n of numbers) {
      const hits = rows.filter((r) => numberKey(r.doc_number) === numberKey(n));
      if (hits.length === 0)
        throw new ValidationError(
          `No encontré la factura de proveedor «${n}» aprobada. Mira la cola con close.status.`,
        );
      if (hits.length > 1)
        throw new ValidationError(
          `«${n}» es de más de un proveedor (${hits.map((h) => h.supplier_name).join(', ')}). Usa el id de close.status.`,
        );
      ids.push((hits[0] as { id: string }).id);
    }
  }
  return [...new Set(ids)];
}

async function runWrites(
  ctx: ToolContext,
  kind: WritebackKind,
  ids: readonly string[],
  opts: { provider?: WritebackProvider; retryUncertain?: boolean },
) {
  // Sale de la empresa a un libro legal: nunca sin una persona mirando.
  if (ctx.surface === 'schedule')
    throw new ValidationError(
      'Cortex no registra nada en el programa contable desde una rutina: pídemelo en el chat o en /cierre.',
    );
  const done: Array<{ id: string; label: string; providerNumber: string | null }> = [];
  const failed: Array<{ id: string; reason: string }> = [];
  for (const id of ids) {
    try {
      const out = await executeWriteback(
        {
          db: ctx.db,
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          enqueueJob: ctx.enqueueJob,
        },
        kind,
        id,
        opts,
      );
      done.push({ id, label: out.label, providerNumber: out.providerNumber });
    } catch (err) {
      failed.push({ id, reason: err instanceof Error ? err.message : 'Error desconocido' });
    }
  }
  const parts: string[] = [];
  if (done.length)
    parts.push(
      `Registré ${done.length}: ${done
        .slice(0, 6)
        .map((d) => `${d.label}${d.providerNumber ? ` → ${d.providerNumber}` : ''}`)
        .join('; ')}.`,
    );
  if (failed.length)
    parts.push(`No se registró ${failed.length}: ${failed.map((f) => f.reason).join(' ')}`);
  return { done, failed, guidance: parts.join(' ') || 'No había nada que registrar.' };
}

const IDS = (what: string) =>
  z.array(z.string().min(1).max(160)).min(1).max(10).describe(`${what}. Hasta 10 por vez.`);

export const accountingWritePurchase = registerTool({
  id: 'accounting.write_purchase',
  description:
    "Book («causar») approved supplier invoices in the connected accounting program: Siigo purchase (FC), Alegra bill or QuickBooks Bill, with the supplier looked up by NIT/name, the expense account from the company's PUC mapping, IVA and withholdings. Idempotent (an invoice already booked is reported, not duplicated). Before calling, show the preview from close.status with `preview: {kind: 'compra', id}`. Never from a routine. Requires confirmation, always by a person.",
  inputSchema: z.object({
    invoices: IDS(
      'Facturas de proveedor aprobadas: id de la cola (close.status) o número («FEPA-451»)',
    ),
    provider: PROVIDER,
    retryUncertain: z
      .boolean()
      .optional()
      .describe('Sólo cuando la persona revisó el programa y el intento cortado NO quedó'),
  }),
  outputSchema: writeOutput,
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) =>
    runWrites(ctx, 'compra', await payableIds(ctx, input.invoices), {
      provider: input.provider,
      retryUncertain: input.retryUncertain,
    }),
});

export const accountingWriteReceipt = registerTool({
  id: 'accounting.write_receipt',
  description:
    'Register cash receipts («recibo de caja» / payment received) in the connected accounting program for customer payments that came into the bank and are matched to an invoice the program knows (Siigo voucher RC, Alegra payment, QuickBooks Payment). Use the ids from the close.status queue (kind «recibo») and show its preview first. Idempotent. Never from a routine. Requires confirmation, always by a person.',
  inputSchema: z.object({
    payments: IDS('Pagos de la cola de close.status (kind «recibo»): su id'),
    provider: PROVIDER,
    retryUncertain: z.boolean().optional(),
  }),
  outputSchema: writeOutput,
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const ids = input.payments.map((p) => p.trim());
    const bad = ids.find((id) => !UUID_RE.test(id));
    if (bad)
      throw new ValidationError(`«${bad}» no es un id de pago: tómalo de la cola de close.status.`);
    return runWrites(ctx, 'recibo', ids, {
      provider: input.provider,
      retryUncertain: input.retryUncertain,
    });
  },
});

export const accountingWriteSupplierPayment = registerTool({
  id: 'accounting.write_supplier_payment',
  description:
    'Register supplier payments in the connected accounting program for supplier invoices the bank already paid and whose purchase is already in the program (Siigo payment receipt RP, Alegra payment against the bill, QuickBooks BillPayment). Show the preview from close.status first. Idempotent. Never from a routine. Requires confirmation, always by a person.',
  inputSchema: z.object({
    invoices: IDS('Facturas de proveedor pagadas: id de la cola (close.status) o número'),
    provider: PROVIDER,
    retryUncertain: z.boolean().optional(),
  }),
  outputSchema: writeOutput,
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) =>
    runWrites(ctx, 'pago_proveedor', await payableIds(ctx, input.invoices), {
      provider: input.provider,
      retryUncertain: input.retryUncertain,
    }),
});
