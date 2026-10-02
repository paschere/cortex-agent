import type { SupabaseClient } from '@supabase/supabase-js';
import { type BankLineSource, bankLineDraft } from './adapters';
import { settlePayablesFromBank } from './payables';
import { ensureAccount, upsertMovements } from './store';

/**
 * EL EXTRACTO, ENTERO, AL LIBRO.
 *
 * El importador de extractos (payments/bank/store.ts) sólo guardaba los
 * ABONOS, como pagos de clientes, y tiraba las salidas: «Las N salidas del
 * extracto no se importan». Para Pagos eso sigue siendo cierto — una salida no
 * es el pago de un cliente — pero al libro de plata le importan las dos
 * mitades: lo que entró, lo que salió (nómina, arriendo, DIAN, el 4x1000) y
 * el saldo con el que cerró la cuenta.
 *
 * Esta función la llama el importador DESPUÉS de escribir sus pagos, y no
 * cambia nada de lo que el importador ya hacía: si el libro falla, la
 * importación de pagos ya quedó y el resumen lo dice.
 *
 *   · Los abonos entran con la MISMA referencia que su payment_report, y con
 *     la llave del pago (`payment:<id>`): si Siigo ya había reportado ese pago,
 *     las dos filas son el mismo hecho y cuenta una (manda el banco).
 *   · Las salidas entran como gastos (o como traslado entre cuentas propias,
 *     si el extracto lo dice), con referencia `d:<huella>`.
 *   · El saldo final del extracto, si trae columna de saldo, es el saldo de la
 *     cuenta a esa fecha — salvo que ya hubiera uno más reciente.
 *   · Las salidas que pagan una factura por pagar abierta (misma contraparte,
 *     mismo valor ±1%) la dejan saldada (payables.ts). Si eso falla, el
 *     extracto ya quedó: la próxima sincronización lo vuelve a intentar.
 */

export interface BankStatementLedgerInput {
  /** 'extracto · <cuenta>': la misma fuente que usan sus payment_reports. */
  system: string;
  /** El nombre de la cuenta como lo escribió la persona. */
  accountLabel: string;
  currency: string;
  credits: Array<BankLineSource & { paymentId?: string | null }>;
  debits: BankLineSource[];
  closing?: { date: string; balance: number } | null;
  createdBy?: string | null;
}

export interface BankStatementLedgerResult {
  accountId: string;
  credits: number;
  debits: number;
  transfers: number;
  inserted: number;
  linked: number;
  balanceUpdated: boolean;
  /** Facturas por pagar que quedaron saldadas por una salida de este extracto. */
  payablesSettled: number;
}

export async function ingestBankStatement(
  db: SupabaseClient,
  input: BankStatementLedgerInput,
): Promise<BankStatementLedgerResult> {
  const { account, balanceUpdated } = await ensureAccount(db, {
    name: input.accountLabel,
    currency: input.currency,
    source: { kind: 'bank', system: input.system, ref: input.accountLabel.slice(0, 200) },
    createdBy: input.createdBy ?? null,
    balance: input.closing
      ? { amount: input.closing.balance, at: input.closing.date, source: 'bank' }
      : null,
  });
  const drafts = [
    ...input.credits.map((c) =>
      bankLineDraft(c, {
        system: input.system,
        currency: input.currency,
        accountId: account.id,
        paymentId: c.paymentId ?? null,
      }),
    ),
    ...input.debits.map((d) =>
      bankLineDraft(d, { system: input.system, currency: input.currency, accountId: account.id }),
    ),
  ];
  const written = await upsertMovements(db, drafts, { recordedBy: input.createdBy ?? null });
  let payablesSettled = 0;
  if (input.debits.length) {
    try {
      payablesSettled = (await settlePayablesFromBank(db)).settled;
    } catch {
      // Ver la cabecera: la sincronización lo intenta otra vez.
    }
  }
  return {
    accountId: account.id,
    credits: input.credits.length,
    debits: drafts.filter((d) => d.direction === 'out' && d.kind === 'expense').length,
    transfers: drafts.filter((d) => d.kind === 'transfer').length,
    inserted: written.inserted.length,
    linked: written.linked,
    balanceUpdated,
    payablesSettled,
  };
}
