import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../index';
import { KIND_LABEL, STATE_LABEL, signedAmount, sourceLabel, sourceRank } from './shape';
import {
  hydratePayments,
  listPayments,
  listWaitingReports,
  num,
  receivables,
  recordPaymentReport,
  reportsFor,
  resolvePaymentDispute,
} from './store';

/**
 * Los pagos, como cifra.
 *
 * Antes de esto Cortex sabía cuánto se había facturado y nada de cuánto se
 * había cobrado, así que no podía decir una sola cifra de negocio: la cartera
 * es una resta y sólo existía el minuendo.
 *
 * TRES COSAS QUE TODA RESPUESTA DE AQUÍ LLEVA, y ninguna es negociable:
 *
 *   SÓLO CUENTA LO CONFIRMADO Y LO REPORTADO. Un pago en disputa no está en
 *   ninguna cifra de este archivo. No es una cifra menor: no está en la cifra.
 *
 *   LO QUE SE QUEDÓ FUERA ES PARTE DE LA RESPUESTA. La cartera dice sobre
 *   cuántas facturas confirmadas está hecha y cuántas hay sin revisar, con el
 *   mismo vocabulario `pendingExcluded` que ya usa documents.totals.
 *
 *   LAS MONEDAS NO SE MEZCLAN. Cada moneda es su propia cifra, siempre.
 */

const CURRENCY = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .describe('Tres letras: COP, USD, EUR. Obligatoria y nunca se asume.');

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const paymentsRecord = registerTool({
  id: 'payments.record',
  description:
    'Registrar a mano un pago que entró: el contable lo dice, o el cliente mandó el soporte. Queda con el nombre de quien lo registró y con su moneda escrita — la moneda es obligatoria y nunca se asume, porque un abono en dólares contado como pesos está mal por cuatro mil veces. Si otra fuente (Siigo, el banco, un comprobante) ya había reportado ese mismo pago, NO se duplica: se enlaza y sube la confianza. Si dice algo distinto, el pago queda en disputa y sale de todas las cifras hasta que una persona decida. Requiere confirmación.',
  inputSchema: z.object({
    amount: z.number().min(0).describe('El importe, siempre positivo. El signo lo pone kind.'),
    currency: CURRENCY,
    paidOn: DATE.describe('El día en que se pagó, no el día de hoy.'),
    kind: z
      .enum(['payment', 'reversal', 'adjustment'])
      .default('payment')
      .describe('reversal para una devolución o un cheque devuelto: resta, y es una fila nueva.'),
    clientNit: z
      .string()
      .nullish()
      .describe('El NIT de quien pagó, en cualquier formato. Se empareja dígito a dígito.'),
    clientId: z.string().uuid().nullish().describe('El cliente, si ya lo tienes identificado.'),
    invoiceNumber: z.string().max(120).nullish().describe('La factura que paga, si se sabe.'),
    reference: z
      .string()
      .max(200)
      .nullish()
      .describe('El número de la transferencia o del recibo.'),
    note: z.string().max(1000).nullish(),
  }),
  outputSchema: z.object({
    outcome: z.string(),
    paymentId: z.string().nullable(),
    state: z.string().nullable(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const result = await recordPaymentReport(ctx.db, {
      source: { kind: 'manual', userId: ctx.userId },
      amount: input.amount,
      currency: input.currency,
      paidOn: input.paidOn,
      kind: input.kind ?? 'payment',
      clientId: input.clientId ?? null,
      clientNit: input.clientNit ?? null,
      invoiceNumber: input.invoiceNumber ?? null,
      reference: input.reference ?? null,
      note: input.note ?? null,
      createdBy: ctx.userId,
    });
    return {
      outcome: result.outcome,
      paymentId: result.payment?.id ?? null,
      state: result.payment?.state ?? null,
      guidance: result.note,
    };
  },
});

// ---------------------------------------------------------------------------

export const paymentsList = registerTool({
  id: 'payments.list',
  description:
    'Los pagos registrados, filtrados por cliente, por moneda o por fechas. Cada uno dice cuántas fuentes distintas lo respaldan y en qué estado está. Responde "¿qué nos ha pagado este cliente este mes?" y "¿qué entró la semana pasada?". Los pagos en disputa aparecen marcados y NO están en ninguna suma.',
  inputSchema: z.object({
    clientId: z.string().uuid().nullish(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullish(),
    paidFrom: DATE.nullish(),
    paidTo: DATE.nullish(),
    includeDisputed: z
      .boolean()
      .default(true)
      .describe('Mostrarlos o no. Estén o no en la lista, nunca están en las sumas.'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  outputSchema: z.object({
    payments: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        amount: z.number(),
        currency: z.string(),
        paidOn: z.string(),
        client: z.string().nullable(),
        invoiceNumber: z.string().nullable(),
        state: z.string(),
        sourceCount: z.number(),
      }),
    ),
    totalsByCurrency: z.array(
      z.object({ currency: z.string(), total: z.number(), count: z.number() }),
    ),
    disputedExcluded: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const states = input.includeDisputed
      ? (['reported', 'confirmed', 'disputed'] as const)
      : (['reported', 'confirmed'] as const);
    const rows = await hydratePayments(
      ctx.db,
      await listPayments(ctx.db, {
        state: [...states],
        clientId: input.clientId ?? undefined,
        currency: input.currency ?? undefined,
        paidFrom: input.paidFrom ?? undefined,
        paidTo: input.paidTo ?? undefined,
        limit: input.limit,
      }),
    );

    // LA SUMA SÓLO TOMA LO QUE CUENTA, y agrupa por moneda siempre. Sumar
    // 3.000 USD a 12.000.000 COP produce 12.003.000 de nada.
    const totals = new Map<string, { currency: string; total: number; count: number }>();
    let disputedExcluded = 0;
    for (const row of rows) {
      if (row.state === 'disputed') {
        disputedExcluded += 1;
        continue;
      }
      const bucket = totals.get(row.currency) ?? { currency: row.currency, total: 0, count: 0 };
      bucket.total += signedAmount(row.kind, num(row.amount) ?? 0);
      bucket.count += 1;
      totals.set(row.currency, bucket);
    }

    return {
      payments: rows.map((r) => ({
        id: r.id,
        kind: KIND_LABEL[r.kind],
        amount: num(r.amount) ?? 0,
        currency: r.currency,
        paidOn: r.paid_on,
        client: r.client_name ?? null,
        invoiceNumber: r.invoice_number,
        state: STATE_LABEL[r.state],
        sourceCount: r.source_count,
      })),
      totalsByCurrency: [...totals.values()],
      disputedExcluded,
      guidance: [
        rows.length === 0 ? 'No hay pagos registrados con ese filtro.' : `${rows.length} pago(s).`,
        ...[...totals.values()].map((t) => `${t.count} suman ${t.total} ${t.currency}.`),
        disputedExcluded > 0
          ? `${disputedExcluded} pago(s) están en disputa entre dos fuentes y NO están en ninguna de esas sumas. No son una cifra menor: no están en la cifra.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
});

// ---------------------------------------------------------------------------

export const paymentsReceivables = registerTool({
  id: 'payments.receivables',
  description:
    'La cartera: cuánto se debe, a cuántos días, y sobre qué base. Se calcula SÓLO sobre facturas que una persona confirmó, y la respuesta dice siempre cuántas facturas leídas siguen sin revisar y por tanto no están en la cifra. Cada moneda es su propia cartera; no se suman entre sí. Los pagos en disputa no restan de nada. Responde "¿cuánto nos deben?", "¿cuánto debe este cliente?" y "¿cuánto hay vencido?".',
  inputSchema: z.object({
    clientId: z.string().uuid().nullish().describe('Para la cartera de un solo cliente.'),
  }),
  outputSchema: z.object({
    today: z.string(),
    byCurrency: z.array(
      z.object({
        currency: z.string(),
        outstanding: z.number(),
        invoiced: z.number(),
        paid: z.number(),
        openInvoices: z.number(),
        ageDays: z.number().nullable(),
        overdue: z.number(),
        overdueInvoices: z.number(),
      }),
    ),
    confirmedInvoices: z.number(),
    pendingExcluded: z.number(),
    disputedPayments: z.number(),
    unappliedPayments: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const result = await receivables(ctx.db, {
      clientId: input.clientId ?? undefined,
      today: bogotaToday(),
    });
    return {
      today: result.today,
      byCurrency: result.byCurrency.map((c) => ({
        currency: c.currency,
        outstanding: c.outstanding,
        invoiced: c.invoiced,
        paid: c.paid,
        openInvoices: c.openInvoices,
        ageDays: c.ageDays,
        overdue: c.overdue,
        overdueInvoices: c.overdueInvoices,
      })),
      confirmedInvoices: result.confirmedInvoices,
      pendingExcluded: result.pendingExcluded,
      disputedPayments: result.disputedPayments,
      unappliedPayments: result.unappliedPayments,
      // La frase ya trae todas las confesiones. Dila entera: la mitad sin la
      // otra enseña a leer un total incompleto como si fuera completo.
      guidance: result.sentence,
    };
  },
});

// ---------------------------------------------------------------------------

export const paymentsDisputes = registerTool({
  id: 'payments.disputes',
  description:
    'Los pagos donde dos fuentes dicen cosas distintas, con lo que dijo cada una. Ninguno está en ninguna cifra mientras siga aquí. La lista viene ordenada por la fuente más fuerte que habló (banco antes que sistema contable, antes que comprobante, antes que a mano) — ese orden sólo decide por dónde empezar a mirar, NO quién tiene razón. La última palabra es siempre de una persona.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: z.object({
    disputes: z.array(
      z.object({
        paymentId: z.string(),
        client: z.string().nullable(),
        currency: z.string(),
        standingAmount: z.number(),
        paidOn: z.string(),
        versions: z.array(
          z.object({
            source: z.string(),
            amount: z.number(),
            currency: z.string(),
            paidOn: z.string(),
            quote: z.string().nullable(),
          }),
        ),
        /** Lo que la pantalla marcaría por defecto. Una casilla, no una decisión. */
        suggested: z.number().nullable(),
        note: z.string().nullable(),
      }),
    ),
    waitingReports: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const rows = await hydratePayments(
      ctx.db,
      await listPayments(ctx.db, { state: 'disputed', limit: input.limit }),
    );
    const reports = await reportsFor(
      ctx.db,
      rows.map((r) => r.id),
    );

    const disputes = rows.map((row) => {
      const list = (reports.get(row.id) ?? [])
        .slice()
        // LA JERARQUÍA, HACIENDO LO ÚNICO QUE PUEDE HACER: ordenar. El primero
        // de la lista es por dónde empezar a mirar, y su importe es lo que la
        // pantalla marca por defecto. Ni una ni otra cosa escribe nada.
        .sort(
          (a, b) =>
            sourceRank(b.source_kind, b.source_system) - sourceRank(a.source_kind, a.source_system),
        );
      return {
        paymentId: row.id,
        client: row.client_name ?? null,
        currency: row.currency,
        standingAmount: num(row.amount) ?? 0,
        paidOn: row.paid_on,
        versions: list.map((r) => ({
          source: sourceLabel(r.source_kind, r.source_system),
          amount: num(r.amount) ?? 0,
          currency: r.currency,
          paidOn: r.paid_on,
          quote: r.source_quote,
        })),
        suggested: list[0] ? (num(list[0].amount) ?? null) : null,
        note: row.dispute_note,
      };
    });

    const waiting = await listWaitingReports(ctx.db, 200);

    return {
      disputes,
      waitingReports: waiting.length,
      guidance:
        disputes.length === 0
          ? `No hay ningún pago en disputa.${waiting.length > 0 ? ` Sí hay ${waiting.length} reporte(s) que llegaron y no emparejaron con ninguna factura.` : ''}`
          : [
              `${disputes.length} pago(s) en disputa. Ninguno está en la cartera ni en ningún total mientras siga así.`,
              'Enséñale a la persona lo que dice CADA fuente, con su cita cuando la tenga, y deja que elija. El orden de la lista es sólo por dónde empezar: que el banco vaya primero no lo hace tener razón — un extracto que malinterpreta una reversión es exactamente el caso donde no la tiene.',
            ].join(' '),
    };
  },
});

// ---------------------------------------------------------------------------

export const paymentsResolveDispute = registerTool({
  id: 'payments.resolve_dispute',
  description:
    'Cerrar una disputa: una persona mira lo que dijo cada fuente y dice cuál vale, o descarta el pago entero. Es el ÚNICO camino de vuelta a las cifras — no hay ninguna regla automática, ninguna media y ninguna jerarquía que lo haga sola. Sólo hazlo cuando alguien te haya dicho explícitamente qué versión es la buena, después de enseñarle las dos. Requiere confirmación.',
  inputSchema: z.object({
    paymentId: z.string().uuid(),
    decision: z
      .enum(['settle', 'discard'])
      .describe('settle: este es el importe bueno. discard: el pago no era real.'),
    amount: z.number().min(0).nullish().describe('El importe que la persona da por bueno.'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullish(),
    paidOn: DATE.nullish(),
    note: z.string().max(1000).nullish().describe('Por qué, en español.'),
  }),
  outputSchema: z.object({
    state: z.string(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const payment = await resolvePaymentDispute(ctx.db, {
      paymentId: input.paymentId,
      userId: ctx.userId,
      decision: input.decision,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      paidOn: input.paidOn ?? null,
      note: input.note ?? null,
    });
    return {
      state: payment.state,
      guidance:
        payment.state === 'discarded'
          ? 'Descartado bajo tu nombre. No cuenta en ninguna cifra, y los reportes que lo dijeron siguen guardados tal cual llegaron.'
          : 'Resuelto bajo tu nombre. El pago vuelve a contar en la cartera y en los totales con el importe que confirmaste; lo que dijo cada fuente sigue guardado, sin tocar.',
    };
  },
});
