import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../index';
import { categorizeByRules } from './categorize';
import { PAYROLL_CONFIDENTIAL_LABEL, canSeePayrollDetail, isPayrollCategory } from './privacy';
import {
  cashByAccount,
  dueSummary,
  monthlySummary,
  monthsBack,
  totalsByCategory,
  totalsByCounterparty,
} from './query';
import {
  CATEGORY_LABEL,
  MOVEMENT_COLUMNS,
  type MovementDraft,
  type MovementRow,
  categoryLabel,
  docKey,
  invoiceLinkKey,
  moneyText,
  normalizeText,
  num,
  refHash,
  rowToMovement,
  toCategoryKey,
} from './shape';
import {
  accountToCash,
  ensureAccount,
  findAccount,
  listAccounts,
  listMovements,
  loadRules,
  recategorize,
  setMovementCategory,
  upsertMovements,
} from './store';
import { syncLedger } from './sync';
import {
  LEDGER_CATEGORIES,
  type LedgerKind,
  type LedgerMovement,
  type LedgerSourceKind,
} from './types';

/**
 * EL LIBRO DE PLATA, EN EL CHAT (migración 0172).
 *
 * Cinco herramientas y una regla común: cada cifra que sale de aquí es de UNA
 * moneda, sale sólo de lo que cuenta (sin duplicados entre fuentes, sin
 * anulados, sin pagos en disputa) y dice de dónde viene.
 *
 *   ledger.record          anotar un movimiento de cualquier fuente que el
 *                          agente tenga a mano (el chat, un documento, una fila
 *                          de una hoja, un correo). Idempotente: la referencia
 *                          se deriva de la fuente, o de los hechos si no hay.
 *   ledger.record_batch    muchas filas a la vez (una hoja, una tabla, un CSV);
 *   ledger.preview_batch   …y su vista previa, que no escribe nada.
 *   ledger.recategorize    «los pagos a Rappi son mercadeo»: corrige lo que ya
 *                          está y guarda la regla para lo que llegue.
 *   ledger.query           la manera principal de contestar preguntas de plata.
 *   ledger.set_balance     el saldo de una cuenta, dicho a mano.
 *
 * Las que escriben piden confirmación. Ninguna borra. La nómina sale fila por
 * fila sólo para quien administra la empresa; para los demás es un total
 * «Nómina (confidencial)», sin personas (privacy.ts).
 */

const CURRENCY = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .describe(
    'Tres letras: COP, USD, EUR. Obligatoria y nunca se asume; si la persona habla de pesos, es COP.',
  );
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ORIGIN = z
  .object({
    kind: z
      .enum(['chat', 'document', 'email', 'sheet', 'manual'])
      .default('chat')
      .describe(
        'De dónde sacaste el dato: chat (lo dijo la persona), document (un PDF o archivo), email (un correo), sheet (una hoja o tabla), manual (la persona lo dictó como registro contable).',
      ),
    label: z
      .string()
      .max(80)
      .nullish()
      .describe(
        'El nombre de esa fuente: el título del documento, la hoja, el remitente del correo.',
      ),
    ref: z
      .string()
      .max(160)
      .nullish()
      .describe(
        'El identificador del dato en esa fuente (id del documento, id de la fila, id del mensaje). Con él, anotarlo otra vez no lo duplica.',
      ),
  })
  .default({ kind: 'chat' });

const ROW = z.object({
  direction: z
    .enum(['in', 'out'])
    .describe('in: plata que entra o nos deben. out: plata que sale o debemos.'),
  kind: z
    .enum(['income', 'expense', 'receivable', 'payable', 'transfer'])
    .nullish()
    .describe(
      'income/expense: plata que ya se movió o se moverá sin factura. receivable/payable: una factura por cobrar / por pagar. transfer: entre cuentas propias. Si no lo dices: con número de factura o vencimiento es factura; si no, ingreso/gasto.',
    ),
  status: z
    .enum(['expected', 'settled'])
    .nullish()
    .describe('settled: ya pasó. expected: va a pasar. Por defecto, una fecha futura es expected.'),
  amount: z
    .number()
    .positive()
    .describe('El valor, siempre positivo, en pesos (no centavos). El sentido lo pone direction.'),
  currency: CURRENCY,
  date: DATE.describe('El día del movimiento, o de emisión si es una factura.'),
  dueDate: DATE.nullish().describe('El vencimiento, si es una factura o algo esperado.'),
  counterpartyName: z
    .string()
    .max(200)
    .nullish()
    .describe('A quién se le pagó o quién pagó / debe.'),
  counterpartyTaxId: z
    .string()
    .max(30)
    .nullish()
    .describe('Su NIT o cédula, en cualquier formato.'),
  description: z
    .string()
    .max(500)
    .describe('En pocas palabras: «Fletes de septiembre», «Factura FE-88».'),
  category: z
    .string()
    .max(40)
    .nullish()
    .describe(`Sólo si la persona la dijo. Una de: ${LEDGER_CATEGORIES.join(', ')}.`),
  docNumber: z.string().max(120).nullish().describe('El número de la factura, si lo hay.'),
  account: z
    .string()
    .max(80)
    .nullish()
    .describe(
      'La cuenta propia (banco o efectivo) por donde pasó, si se sabe: «Bancolombia corriente».',
    ),
  ref: z
    .string()
    .max(160)
    .nullish()
    .describe('El identificador de ESTA fila en su fuente (id de la fila de la hoja). Opcional.'),
});

type RowInput = z.infer<typeof ROW>;
type OriginInput = z.output<typeof ORIGIN>;

/** El origen con su valor por defecto: lo que llega al handler aún no lo trae puesto. */
function originOf(o: z.input<typeof ORIGIN> | undefined): OriginInput {
  return { kind: o?.kind ?? 'chat', label: o?.label ?? null, ref: o?.ref ?? null };
}

const SOURCE_OF: Record<OriginInput['kind'], LedgerSourceKind> = {
  chat: 'chat',
  document: 'document',
  email: 'document',
  sheet: 'sheet',
  manual: 'manual',
};

/** El sistema de la fuente: 'correo · ana@acme.co', 'hoja · Gastos 2026'… */
function systemOf(origin: OriginInput): string {
  const label = origin.label?.replace(/\s+/g, ' ').trim() ?? '';
  const prefix =
    origin.kind === 'email'
      ? 'correo'
      : origin.kind === 'sheet'
        ? 'hoja'
        : origin.kind === 'document'
          ? 'documento'
          : '';
  if (!prefix) return '';
  return (label ? `${prefix} · ${label}` : prefix).slice(0, 80);
}

/**
 * De lo que dijo la persona (o la fila de la hoja) a un borrador del libro.
 * La referencia: la de la fuente si la hay; si no, el número de factura; si
 * no, una huella de los hechos (sentido, clase, valor, moneda, fecha y
 * contraparte) — así repetir la misma frase no anota dos veces.
 */
export function rowToDraft(
  row: RowInput,
  origin: OriginInput,
  ctx: { today: string; userId: string; accountId?: string | null },
): MovementDraft {
  const invoiceish = Boolean(row.docNumber || row.dueDate);
  const kind: LedgerKind =
    row.kind ??
    (invoiceish
      ? row.direction === 'in'
        ? 'receivable'
        : 'payable'
      : row.direction === 'in'
        ? 'income'
        : 'expense');
  const isInvoice = kind === 'receivable' || kind === 'payable';
  const status =
    row.status ?? (isInvoice ? 'expected' : row.date > ctx.today ? 'expected' : 'settled');
  const who = normalizeText(row.counterpartyName).replace(/\s+/g, '');
  const ownRef = row.ref ?? null;
  const ref = ownRef
    ? `r:${ownRef}`
    : row.docNumber
      ? `doc:${row.direction}:${docKey(row.docNumber)}:${who.slice(0, 40)}`
      : `h:${refHash([row.direction, kind, row.amount.toFixed(2), row.currency, row.date, who, origin.ref ?? ''])}`;
  const category = toCategoryKey(row.category);
  return {
    direction: row.direction,
    kind,
    status,
    amount: row.amount,
    currency: row.currency,
    date: row.date,
    dueDate: row.dueDate ?? null,
    settledAt: status === 'settled' && !isInvoice ? row.date : null,
    outstanding: isInvoice ? (status === 'settled' ? 0 : row.amount) : null,
    counterpartyName: row.counterpartyName ?? null,
    counterpartyTaxId: row.counterpartyTaxId ?? null,
    description: row.description,
    docNumber: row.docNumber ?? null,
    accountId: ctx.accountId ?? null,
    category,
    categorySource: category ? 'person' : null,
    linkKey: isInvoice
      ? invoiceLinkKey({
          direction: row.direction,
          docNumber: row.docNumber,
          counterpartyTaxId: row.counterpartyTaxId,
          counterpartyName: row.counterpartyName,
        })
      : null,
    recordedBy: ctx.userId,
    source: {
      kind: SOURCE_OF[origin.kind],
      system: systemOf(origin),
      ref: ref.slice(0, 200),
    },
  };
}

async function rowByRef(db: SupabaseClient, draft: MovementDraft): Promise<MovementRow | null> {
  const { data, error } = await db
    .from('ledger_movements')
    .select(MOVEMENT_COLUMNS)
    .eq('source_kind', draft.source.kind)
    .eq('source_system', draft.source.system ?? '')
    .eq('source_ref', draft.source.ref)
    .maybeSingle();
  if (error) throw error;
  return (data as MovementRow | null) ?? null;
}

const KIND_SENTENCE: Record<LedgerKind, string> = {
  income: 'ingreso',
  expense: 'gasto',
  receivable: 'cuenta por cobrar',
  payable: 'cuenta por pagar',
  transfer: 'traslado entre cuentas',
};

// ---------------------------------------------------------------------------

export const ledgerRecord = registerTool({
  id: 'ledger.record',
  description:
    'Anotar en el libro de plata de la empresa un movimiento que sacaste de cualquier fuente: lo que la persona dijo en el chat («registra que le pagamos $2.000.000 a Transportes X por fletes el 1 de octubre»), un documento, un correo o una fila de una hoja («nos deben 5 M de la factura FE-88 que vence el 15»). Sirve para gastos, ingresos, facturas por cobrar y por pagar. Dice de dónde salió (origin) y es idempotente: anotar lo mismo otra vez no lo duplica, y si el banco o Siigo ya traen ese mismo movimiento, se enlaza y cuenta una sola vez. La moneda es obligatoria. Requiere confirmación.',
  inputSchema: ROW.omit({ ref: true }).extend({ origin: ORIGIN }),
  outputSchema: z.object({
    movementId: z.string(),
    outcome: z.enum(['created', 'updated', 'unchanged']),
    duplicateOf: z.string().nullable(),
    category: z.string().nullable(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    let accountId: string | null = null;
    let accountNote = '';
    if (input.account) {
      const account = await findAccount(ctx.db, input.account);
      if (account) accountId = account.id;
      else
        accountNote = ` No encontré la cuenta «${input.account}»; quedó sin cuenta (créala con ledger.set_balance si quieres seguir su saldo).`;
    }
    const draft = rowToDraft(input, originOf(input.origin), {
      today,
      userId: ctx.userId,
      accountId,
    });
    const result = await upsertMovements(ctx.db, [draft], { recordedBy: ctx.userId });
    if (result.rejected.length) throw new Error(result.rejected[0]?.reason ?? 'No se pudo anotar.');
    const row = await rowByRef(ctx.db, draft);
    if (!row) throw new Error('El movimiento no quedó escrito.');
    const outcome = result.inserted.length
      ? 'created'
      : result.updated.length
        ? 'updated'
        : 'unchanged';
    const what = `${KIND_SENTENCE[row.kind]} de ${moneyText(num(row.amount) ?? 0, row.currency)}${row.counterparty_name ? ` con ${row.counterparty_name}` : ''} (${row.date})`;
    const parts = [
      outcome === 'created'
        ? `Anoté el ${what}.`
        : outcome === 'updated'
          ? `Ya estaba anotado; actualicé el ${what}.`
          : `El ${what} ya estaba anotado igual; no lo dupliqué.`,
    ];
    if (row.duplicate_of) {
      parts.push(
        'Ese mismo movimiento ya había llegado por otra fuente (el banco, el programa contable o un documento): quedaron enlazados y cuenta una sola vez.',
      );
    }
    parts.push(
      row.category
        ? `Categoría: ${categoryLabel(row.category)}.`
        : 'Sin categoría todavía; la pongo en la próxima pasada.',
    );
    return {
      movementId: row.id,
      outcome,
      duplicateOf: row.duplicate_of ?? null,
      category: row.category ?? null,
      guidance: parts.join(' ') + accountNote,
    };
  },
});

// ---------------------------------------------------------------------------

const BATCH_INPUT = z.object({
  rows: z.array(ROW).min(1).max(500).describe('Las filas, ya leídas de la hoja, tabla o archivo.'),
  origin: ORIGIN.describe(
    'La fuente de TODAS las filas: la hoja, el archivo o la tabla, con su nombre.',
  ),
});

interface BatchPlan {
  drafts: MovementDraft[];
  rejected: Array<{ row: number; reason: string }>;
}

function planBatch(
  input: z.input<typeof BATCH_INPUT>,
  ctx: { today: string; userId: string },
): BatchPlan {
  const plan: BatchPlan = { drafts: [], rejected: [] };
  const origin = originOf(input.origin);
  input.rows.forEach((row, i) => {
    try {
      plan.drafts.push(rowToDraft(row, origin, ctx));
    } catch (err) {
      plan.rejected.push({
        row: i + 1,
        reason: err instanceof Error ? err.message : 'Fila ilegible.',
      });
    }
  });
  return plan;
}

function batchTotals(drafts: MovementDraft[]) {
  const map = new Map<
    string,
    { currency: string; direction: string; kind: string; total: number; count: number }
  >();
  for (const d of drafts) {
    const key = `${d.currency}|${d.direction}|${d.kind}`;
    const e = map.get(key) ?? {
      currency: d.currency,
      direction: d.direction,
      kind: d.kind,
      total: 0,
      count: 0,
    };
    e.total += d.amount;
    e.count += 1;
    map.set(key, e);
  }
  return [...map.values()].map((e) => ({ ...e, total: Math.round(e.total * 100) / 100 }));
}

const BATCH_TOTALS = z.array(
  z.object({
    currency: z.string(),
    direction: z.string(),
    kind: z.string(),
    total: z.number(),
    count: z.number(),
  }),
);

export const ledgerPreviewBatch = registerTool({
  id: 'ledger.preview_batch',
  description:
    'Mirar, SIN escribir nada, cómo quedarían en el libro de plata muchas filas de una hoja, tabla o CSV: cuántas entran, cuántas ya estaban, cuáles no se pueden leer y por qué, y con qué categoría entraría cada una. Úsalo siempre antes de ledger.record_batch y cuéntale el resumen a la persona.',
  inputSchema: BATCH_INPUT,
  outputSchema: z.object({
    willCreate: z.number(),
    alreadyThere: z.number(),
    rejected: z.array(z.object({ row: z.number(), reason: z.string() })),
    totals: BATCH_TOTALS,
    sample: z.array(
      z.object({
        row: z.number(),
        date: z.string(),
        description: z.string(),
        amount: z.number(),
        currency: z.string(),
        kind: z.string(),
        category: z.string().nullable(),
        alreadyThere: z.boolean(),
      }),
    ),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const plan = planBatch(input, { today: bogotaToday(), userId: ctx.userId });
    const rules = await loadRules(ctx.db);
    const existing = new Set<string>();
    const bySystem = new Map<string, string[]>();
    for (const d of plan.drafts) {
      const key = `${d.source.kind}\u0001${d.source.system ?? ''}`;
      bySystem.set(key, [...(bySystem.get(key) ?? []), d.source.ref]);
    }
    for (const [key, refs] of bySystem) {
      const [kind, system] = key.split('\u0001') as [string, string];
      for (let i = 0; i < refs.length; i += 100) {
        const { data, error } = await ctx.db
          .from('ledger_movements')
          .select('source_ref')
          .eq('source_kind', kind)
          .eq('source_system', system)
          .in('source_ref', refs.slice(i, i + 100));
        if (error) throw error;
        for (const r of (data ?? []) as Array<{ source_ref: string }>)
          existing.add(`${key}\u0001${r.source_ref}`);
      }
    }
    const isThere = (d: MovementDraft) =>
      existing.has(`${d.source.kind}\u0001${d.source.system ?? ''}\u0001${d.source.ref}`);
    const alreadyThere = plan.drafts.filter(isThere).length;
    const sample = plan.drafts.slice(0, 25).map((d, i) => ({
      row: i + 1,
      date: d.date,
      description: d.description,
      amount: d.amount,
      currency: d.currency,
      kind: d.kind,
      category: d.category ?? categorizeByRules(d, rules)?.category ?? null,
      alreadyThere: isThere(d),
    }));
    const willCreate = plan.drafts.length - alreadyThere;
    const totals = batchTotals(plan.drafts);
    return {
      willCreate,
      alreadyThere,
      rejected: plan.rejected,
      totals,
      sample,
      guidance: [
        `${plan.drafts.length} fila(s) se pueden anotar: ${willCreate} nuevas y ${alreadyThere} que ya estaban (no se duplican).`,
        plan.rejected.length ? `${plan.rejected.length} no se pueden leer.` : '',
        ...totals.map(
          (t) =>
            `${t.count} ${KIND_SENTENCE[t.kind as LedgerKind] ?? t.kind}(s) por ${moneyText(t.total, t.currency)}.`,
        ),
        'Nada se escribió todavía.',
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
});

export const ledgerRecordBatch = registerTool({
  id: 'ledger.record_batch',
  description:
    'Anotar de una vez en el libro de plata muchas filas de una hoja, una tabla o un CSV adjunto (gastos del mes, facturas por pagar, una nómina). Idempotente: si una fila ya estaba (misma referencia de la fuente, o mismos hechos), no se duplica, y lo que el banco o Siigo ya traían se enlaza. Llama antes a ledger.preview_batch. Requiere confirmación.',
  inputSchema: BATCH_INPUT,
  outputSchema: z.object({
    created: z.number(),
    updated: z.number(),
    unchanged: z.number(),
    linked: z.number(),
    rejected: z.array(z.object({ row: z.number(), reason: z.string() })),
    totals: BATCH_TOTALS,
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 5 },
  handler: async (input, ctx) => {
    const plan = planBatch(input, { today: bogotaToday(), userId: ctx.userId });
    const result = await upsertMovements(ctx.db, plan.drafts, { recordedBy: ctx.userId });
    const rejected = [
      ...plan.rejected,
      ...result.rejected.map((r) => ({
        row: plan.drafts.findIndex((d) => d.source.ref === r.ref) + 1,
        reason: r.reason,
      })),
    ];
    const totals = batchTotals(plan.drafts);
    return {
      created: result.inserted.length,
      updated: result.updated.length,
      unchanged: result.unchanged,
      linked: result.linked,
      rejected,
      totals,
      guidance: [
        `Anoté ${result.inserted.length} movimiento(s) nuevo(s)${result.updated.length ? ` y actualicé ${result.updated.length}` : ''}.`,
        result.unchanged ? `${result.unchanged} ya estaban igual y no se duplicaron.` : '',
        result.linked
          ? `${result.linked} coincidían con lo que ya traía otra fuente: quedaron enlazados y cuentan una vez.`
          : '',
        rejected.length ? `${rejected.length} fila(s) no se pudieron anotar.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
});

// ---------------------------------------------------------------------------

export const ledgerRecategorize = registerTool({
  id: 'ledger.recategorize',
  description:
    'Corregir la categoría de gastos o ingresos en el libro de plata y recordarlo: «los pagos a Rappi son mercadeo», «lo de EPM es arriendo, no servicios». Cambia los movimientos que ya coinciden con el patrón (en la contraparte o la descripción) y guarda una regla de la empresa para los que lleguen después. Lo que una persona ya categorizó a mano no se toca salvo que lo pida (overridePerson). Con movementId cambia sólo ese movimiento. Requiere confirmación.',
  inputSchema: z.object({
    category: z
      .string()
      .max(40)
      .describe(`La categoría correcta. Una de: ${LEDGER_CATEGORIES.join(', ')}.`),
    pattern: z
      .string()
      .max(120)
      .nullish()
      .describe(
        'La palabra o frase que reconoce esos movimientos: «rappi», «epm», «transportes x».',
      ),
    field: z
      .enum(['counterparty', 'description', 'any'])
      .default('any')
      .describe('Dónde buscar el patrón.'),
    direction: z.enum(['in', 'out', 'any']).default('any'),
    movementId: z.string().uuid().nullish().describe('Un solo movimiento, sin guardar regla.'),
    overridePerson: z.boolean().default(false),
  }),
  outputSchema: z.object({
    updated: z.number(),
    keptPerson: z.number(),
    ruleId: z.string().nullable(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const category = toCategoryKey(input.category);
    if (!category) throw new Error(`No reconozco la categoría «${input.category}».`);
    const label = CATEGORY_LABEL[category] ?? category;
    if (input.movementId) {
      const ok = await setMovementCategory(ctx.db, input.movementId, category);
      if (!ok) throw new Error('No encontré ese movimiento en el libro.');
      return {
        updated: 1,
        keptPerson: 0,
        ruleId: null,
        guidance: `Listo: ese movimiento ahora es «${label}».`,
      };
    }
    if (!input.pattern || normalizeText(input.pattern).length < 2) {
      throw new Error(
        'Dime qué palabra reconoce esos movimientos (la contraparte o algo de la descripción), o el movimiento puntual.',
      );
    }
    const result = await recategorize(ctx.db, {
      pattern: input.pattern,
      field: input.field,
      direction: input.direction,
      category,
      createdBy: ctx.userId,
      overridePerson: input.overridePerson,
    });
    const parts = [
      result.updated
        ? `Cambié ${result.updated} movimiento(s) a «${label}».`
        : 'Ningún movimiento existente cambió.',
      `Guardé la regla: lo que diga «${result.rule.pattern}» será «${label}» de aquí en adelante.`,
    ];
    if (result.keptPerson) {
      parts.push(
        `${result.keptPerson} ya tenían una categoría puesta a mano y no los toqué; si también van, pídelo con overridePerson.`,
      );
    }
    return {
      updated: result.updated,
      keptPerson: result.keptPerson,
      ruleId: result.rule.id,
      guidance: parts.join(' '),
    };
  },
});

// ---------------------------------------------------------------------------

const QUERY_ROW = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));
const QUERY_OUTPUT = z.object({
  view: z.string(),
  currency: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  rows: z.array(QUERY_ROW),
  totals: z.record(z.number()),
  otherCurrencies: z.array(z.string()),
  uncategorized: z.number(),
  truncated: z.boolean(),
  guidance: z.string(),
});
type QueryOutput = z.infer<typeof QUERY_OUTPUT>;

export const ledgerQuery = registerTool({
  id: 'ledger.query',
  description:
    'La forma principal de contestar preguntas de plata de la empresa, desde el libro de plata (programa contable, extractos del banco, pagos, facturas confirmadas y lo anotado a mano, contado una sola vez): view=summary para ventas/ingresos, gastos y margen por mes («¿cómo nos fue este trimestre?»); by_category para «¿en qué se nos va la plata?» o «¿cuánto gastamos en nómina?»; by_counterparty para «¿a quién le pagamos más?» o «¿quién nos paga más?»; due para lo que está por cobrar y por pagar y cuándo vence; cash para la caja por cuenta; movements para ver los movimientos uno por uno con filtros. Sólo lectura. Una moneda por respuesta (COP por defecto). La nómina sale persona por persona sólo para quien administra la empresa; para los demás, como un total «Nómina (confidencial)».',
  inputSchema: z.object({
    view: z.enum(['summary', 'by_category', 'by_counterparty', 'due', 'cash', 'movements']),
    from: DATE.nullish().describe(
      'Desde (incluido). Por defecto, el inicio del período de `months`.',
    ),
    to: DATE.nullish().describe('Hasta (incluido). Por defecto, hoy.'),
    months: z
      .number()
      .int()
      .min(1)
      .max(36)
      .default(3)
      .describe('Cuántos meses hacia atrás, contando el actual, si no das fechas.'),
    direction: z
      .enum(['in', 'out'])
      .nullish()
      .describe(
        'in: lo que entra. out: lo que sale. by_category y by_counterparty usan out por defecto.',
      ),
    category: z.string().max(40).nullish(),
    counterparty: z.string().max(120).nullish().describe('Filtrar por contraparte (contiene).'),
    currency: CURRENCY.default('COP'),
    limit: z.number().int().min(1).max(200).default(40),
  }),
  outputSchema: QUERY_OUTPUT,
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx): Promise<QueryOutput> => {
    const today = bogotaToday();
    // Lo nuevo de las fuentes, sin modelo y como mucho cada 15 minutos.
    try {
      await syncLedger(ctx.db, ctx.organizationId, {
        today,
        classifier: null,
        minIntervalMinutes: 15,
        deadline: Date.now() + 20_000,
      });
    } catch (err) {
      ctx.logger.warn({ err }, 'ledger sync before query failed');
    }
    const currency = input.currency ?? 'COP';
    const limit = input.limit ?? 40;
    const to = input.to ?? today;
    const from = input.from ?? monthsBack(to, input.months ?? 3);
    const category = input.category ? toCategoryKey(input.category) : null;
    const who = input.counterparty ? normalizeText(input.counterparty) : null;
    const matchesWho = (m: { counterpartyName?: string | null; description: string }) =>
      !who || normalizeText(`${m.counterpartyName ?? ''} ${m.description}`).includes(who);

    if (input.view === 'cash') {
      const accounts = (await listAccounts(ctx.db)).map(accountToCash);
      const cash = cashByAccount(accounts, today);
      const mine = cash.lines.filter((l) => l.currency === currency);
      const total = cash.totals.find((t) => t.currency === currency)?.total ?? 0;
      const stale = mine.filter((l) => l.stale);
      return {
        view: 'cash',
        currency,
        from: null,
        to: today,
        rows: mine.map((l) => ({
          cuenta: l.name,
          saldo: l.balance,
          al: l.balanceAt,
          dias: l.daysOld,
          viejo: l.stale,
        })),
        totals: { caja: total, cuentas: mine.length },
        otherCurrencies: cash.totals.map((t) => t.currency).filter((c) => c !== currency),
        uncategorized: 0,
        truncated: false,
        guidance: mine.length
          ? [
              `Caja en ${currency}: ${moneyText(total, currency)} en ${mine.length} cuenta(s).`,
              stale.length
                ? `Ojo: el saldo de ${stale.map((s) => `«${s.name}» es del ${s.balanceAt}`).join(', ')}; importa un extracto reciente o dime el saldo de hoy.`
                : '',
            ]
              .filter(Boolean)
              .join(' ')
          : 'No conozco ninguna cuenta con saldo. Importa un extracto del banco (con columna de saldo) o dime el saldo con ledger.set_balance.',
      };
    }

    const [all, admin] = await Promise.all([
      listMovements(ctx.db, {
        from: input.view === 'due' ? null : from,
        to: input.view === 'due' ? null : to,
        status: input.view === 'due' ? ['expected'] : null,
      }),
      canSeePayrollDetail(ctx.db, ctx.userId),
    ]);
    const otherCurrencies = [...new Set(all.rows.map((r) => r.currency))].filter(
      (c) => c !== currency,
    );
    // Sin permiso, la nómina pierde sus nombres ANTES de filtrar: buscar por
    // el nombre de una persona no la encuentra, y por contraparte sale toda
    // junta como «Nómina (confidencial)».
    const movements = all.rows
      .filter((r) => r.currency === currency)
      .map(rowToMovement)
      .map((m) => (admin ? m : maskPayrollMovement(m)))
      .filter((m) => (!category || m.category === category) && matchesWho(m));
    const payrollHidden = admin ? [] : movements.filter((m) => isPayrollCategory(m.category));
    const uncategorized = movements.filter(
      (m) => !m.category && m.status === 'settled' && (m.kind === 'income' || m.kind === 'expense'),
    ).length;
    const base = {
      currency,
      otherCurrencies,
      uncategorized,
      truncated: all.truncated,
    };
    const tail = [
      otherCurrencies.length
        ? `También hay movimientos en ${otherCurrencies.join(', ')}, que no se suman aquí.`
        : '',
      uncategorized ? `${uncategorized} movimiento(s) aún sin categoría.` : '',
      all.truncated
        ? 'Hay más movimientos de los que leí; acota las fechas para una cifra exacta.'
        : '',
    ];

    if (input.view === 'summary') {
      const months = monthlySummary(movements, { from, to });
      const sum = (k: 'ingresos' | 'gastos' | 'facturado' | 'compras') =>
        months.reduce((s, m) => s + m[k], 0);
      const ingresos = sum('ingresos');
      const gastos = sum('gastos');
      return {
        ...base,
        view: 'summary',
        from,
        to,
        rows: months.map((m) => ({ ...m })),
        totals: {
          ingresos,
          gastos,
          margen: ingresos - gastos,
          facturado: sum('facturado'),
          compras: sum('compras'),
        },
        guidance: [
          `Del ${from} al ${to}: entraron ${moneyText(ingresos, currency)}, salieron ${moneyText(gastos, currency)}; margen de caja ${moneyText(ingresos - gastos, currency)}. Se facturó ${moneyText(sum('facturado'), currency)}.`,
          'Ingresos y gastos son caja (lo que de verdad entró y salió); «facturado» es lo emitido, se haya cobrado o no.',
          ...tail,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }

    if (input.view === 'by_category') {
      const direction = input.direction ?? 'out';
      const list = totalsByCategory(movements, direction);
      const total = list.reduce((s, c) => s + c.total, 0);
      return {
        ...base,
        view: 'by_category',
        from,
        to,
        rows: list.slice(0, limit).map((c) => ({
          categoria: !admin && isPayrollCategory(c.category) ? PAYROLL_CONFIDENTIAL_LABEL : c.label,
          clave: c.category,
          total: c.total,
          movimientos: c.count,
          porcentaje: c.share,
        })),
        totals: { total },
        guidance: [
          `${direction === 'out' ? 'Salieron' : 'Entraron'} ${moneyText(total, currency)} del ${from} al ${to}.`,
          list[0]
            ? `Lo más grande: ${list[0].label} con ${moneyText(list[0].total, currency)} (${list[0].share}%).`
            : 'No hay movimientos en ese período.',
          ...tail,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }

    if (input.view === 'by_counterparty') {
      const direction = input.direction ?? 'out';
      const list = totalsByCounterparty(movements, direction, limit);
      return {
        ...base,
        view: 'by_counterparty',
        from,
        to,
        rows: list.map((c) => ({
          contraparte: c.counterparty,
          total: c.total,
          movimientos: c.count,
          ultimo: c.lastDate,
        })),
        totals: { total: list.reduce((s, c) => s + c.total, 0) },
        guidance: [
          list[0]
            ? `${direction === 'out' ? 'A quien más se le pagó' : 'Quien más pagó'}: ${list[0].counterparty}, ${moneyText(list[0].total, currency)} en ${list[0].count} movimiento(s).`
            : 'No hay movimientos con contraparte en ese período.',
          ...tail,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }

    if (input.view === 'due') {
      const due = dueSummary(movements, today, limit);
      // Las cifras incluyen la nómina; las filas, no (serían por persona).
      due.items = due.items.filter((i) => i.counterparty !== PAYROLL_CONFIDENTIAL_LABEL);
      const r = due.receivable;
      const p = due.payable;
      return {
        ...base,
        view: 'due',
        from: null,
        to: null,
        rows: due.items.map((i) => ({
          sentido: i.direction === 'in' ? 'por cobrar' : 'por pagar',
          contraparte: i.counterparty,
          descripcion: i.description,
          vence: i.dueDate,
          dias: i.daysToDue,
          pendiente: i.pending,
        })),
        totals: {
          por_cobrar_vencido: r.overdue,
          por_cobrar_7_dias: r.next7,
          por_cobrar_30_dias: r.next30,
          por_cobrar_despues: r.later + r.noDate,
          por_pagar_vencido: p.overdue,
          por_pagar_7_dias: p.next7,
          por_pagar_30_dias: p.next30,
          por_pagar_despues: p.later + p.noDate,
        },
        guidance: [
          `Por cobrar: ${moneyText(r.overdue, currency)} vencido, ${moneyText(r.next7, currency)} en los próximos 7 días y ${moneyText(r.next30, currency)} entre 8 y 30 días.`,
          `Por pagar: ${moneyText(p.overdue, currency)} vencido, ${moneyText(p.next7, currency)} en 7 días y ${moneyText(p.next30, currency)} entre 8 y 30.`,
          ...tail,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }

    // movements
    const direction = input.direction ?? null;
    const hiddenSet = new Set(payrollHidden);
    const list = movements
      .filter((m) => (!direction || m.direction === direction) && !hiddenSet.has(m))
      .slice(0, limit);
    const hiddenTotal = payrollHidden
      .filter((m) => !direction || m.direction === direction)
      .reduce((s, m) => s + (m.direction === 'out' ? m.amount : -m.amount), 0);
    return {
      ...base,
      view: 'movements',
      from,
      to,
      rows: list.map((m) => ({
        id: m.id,
        fecha: m.date,
        sentido: m.direction === 'in' ? 'entra' : 'sale',
        clase: KIND_SENTENCE[m.kind],
        estado: m.status,
        valor: m.amount,
        contraparte: m.counterpartyName ?? null,
        descripcion: m.description,
        categoria: m.category ? categoryLabel(m.category) : null,
        fuente: m.source.system ? `${m.source.kind} · ${m.source.system}` : m.source.kind,
      })),
      totals: { mostrados: list.length },
      guidance: [
        list.length ? `${list.length} movimiento(s).` : 'No hay movimientos con ese filtro.',
        payrollHidden.length
          ? `La nómina (${payrollHidden.length} movimiento(s), ${moneyText(hiddenTotal, currency)} netos) no se muestra fila por fila: es confidencial y sólo la ve quien administra la empresa.`
          : '',
        ...tail,
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
});

// ---------------------------------------------------------------------------

export const ledgerSetBalance = registerTool({
  id: 'ledger.set_balance',
  description:
    'Fijar a mano el saldo actual de una cuenta propia (banco o efectivo): «hoy hay $ 48.300.000 en Bancolombia corriente», «en caja menor hay 600 mil». Si la cuenta no existe, la crea. Es el punto de partida de la caja y de la proyección; un extracto importado después con fecha más reciente lo reemplaza. Requiere confirmación.',
  inputSchema: z.object({
    account: z
      .string()
      .min(1)
      .max(80)
      .describe('El nombre de la cuenta: «Bancolombia corriente», «Caja menor».'),
    balance: z
      .number()
      .describe('El saldo, en unidades de la moneda. Puede ser negativo (sobregiro).'),
    currency: CURRENCY,
    asOf: DATE.nullish().describe('De qué día es ese saldo. Por defecto, hoy.'),
  }),
  outputSchema: z.object({
    accountId: z.string(),
    name: z.string(),
    balance: z.number(),
    balanceAt: z.string(),
    created: z.boolean(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const at = input.asOf ?? bogotaToday();
    const { account, created } = await ensureAccount(ctx.db, {
      name: input.account,
      currency: input.currency,
      source: {
        kind: 'manual',
        system: '',
        ref: normalizeText(input.account).slice(0, 200) || 'cuenta',
      },
      createdBy: ctx.userId,
      balance: { amount: input.balance, at, source: 'manual' },
    });
    return {
      accountId: account.id,
      name: account.name,
      balance: num(account.balance) ?? input.balance,
      balanceAt: account.balance_at,
      created,
      guidance: `${created ? 'Creé la cuenta' : 'Actualicé el saldo de'} «${account.name}»: ${moneyText(input.balance, input.currency)} al ${at}.`,
    };
  },
});

/** La nómina sin la persona: contraparte y descripción confidenciales (privacy.ts). */
function maskPayrollMovement(m: LedgerMovement): LedgerMovement {
  if (!isPayrollCategory(m.category)) return m;
  return {
    ...m,
    counterpartyName: PAYROLL_CONFIDENTIAL_LABEL,
    counterpartyTaxId: null,
    description: PAYROLL_CONFIDENTIAL_LABEL,
  };
}
