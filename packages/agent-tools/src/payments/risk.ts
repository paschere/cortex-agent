import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../commitments/shape';
import { type OverdueInvoice, overdueReceivableInvoices } from './store';

/**
 * PLATA EN RIESGO: UNA CIFRA, CON SUS PARTES A LA VISTA.
 *
 * La auditoría de septiembre lo dijo sin rodeos: Cortex sabía de fechas y de
 * facturas, pero en ningún sitio decía cuánta plata se estaba jugando. Un
 * gerente abre el día con esa cifra.
 *
 * QUÉ ENTRA, Y SÓLO ESO — tres cosas que ya están escritas y confirmadas en el
 * espacio, nunca una estimación:
 *
 *   1. CARTERA VENCIDA: saldo de facturas por cobrar confirmadas que pasaron su
 *      fecha (`overdueReceivableInvoices`, mismas reglas que la cartera).
 *   2. PAGOS COMPROMETIDOS vencidos o que vencen en los próximos 7 días
 *      (vencimientos `kind = 'payment'` confirmados, con `amount_cop`): lo que
 *      la empresa tiene que pagar y que, si se pasa, cuesta intereses, cortes o
 *      multas.
 *   3. MULTAS DE TRÁNSITO PENDIENTES que el SIMIT ya reportó (`vehicle_fines`).
 *
 * NO SE MEZCLAN MONEDAS. La cifra principal es en pesos; la cartera en otras
 * monedas va aparte, con su código. Y no se llama «pérdida»: es plata que se
 * puede recuperar o no pagar de más si alguien actúa, que es el punto.
 */

export const DUE_SOON_DAYS = 7;

export interface MoneyAtRisk {
  today: string;
  cop: {
    receivablesOverdue: number;
    overdueInvoices: number;
    paymentsOverdue: number;
    paymentsDueSoon: number;
    paymentCommitments: number;
    finesPending: number;
    fines: number;
    total: number;
  };
  /**
   * De dónde sale cada parte del total, escrito: «cartera vencida: 3 facturas
   * confirmadas o de Siigo, saldo al día de hoy». La respuesta a «¿y esto de
   * dónde sale?» no se adivina.
   */
  sources: Array<{
    key: 'cartera_vencida' | 'pagos_comprometidos' | 'multas';
    label: string;
    amount: number;
    count: number;
    /** Hacia dónde va la plata: lo que nos deben o lo que debemos pagar. */
    direction: 'por_cobrar' | 'por_pagar';
    from: string;
  }>;
  /** Cuántos pagos comprometidos repetidos (mismo título, día y valor) se contaron una sola vez. */
  duplicatePaymentsIgnored: number;
  /** Cartera vencida en monedas distintas del peso, cada una por su lado. */
  otherCurrencies: Array<{ currency: string; receivablesOverdue: number; overdueInvoices: number }>;
  /** Las facturas vencidas de mayor saldo, para el correo y la pantalla. */
  topInvoices: OverdueInvoice[];
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isCop(currency: string): boolean {
  return currency.trim().toUpperCase() === 'COP';
}

export interface PaymentCommitmentRow {
  id?: string | null;
  title?: string | null;
  amount_cop: number | string | null;
  due_on: string;
}

/**
 * Los pagos comprometidos que de verdad suman: valor positivo y, si el mismo
 * pago se extrajo dos veces (mismo título, mismo día, mismo valor), una sola
 * vez. Un valor negativo o ilegible no resta ni suma.
 */
export function dedupePaymentCommitments(rows: PaymentCommitmentRow[]): {
  rows: Array<{ amount: number; due_on: string }>;
  duplicates: number;
} {
  const seen = new Set<string>();
  const out: Array<{ amount: number; due_on: string }> = [];
  let duplicates = 0;
  for (const r of rows) {
    const amount = Number(r.amount_cop);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const title = (r.title ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const key = title ? `${title}|${r.due_on}|${amount}` : null;
    if (key) {
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
    }
    out.push({ amount, due_on: r.due_on });
  }
  return { rows: out, duplicates };
}

export async function moneyAtRisk(
  db: SupabaseClient,
  opts: { today?: string } = {},
): Promise<MoneyAtRisk> {
  const today = opts.today ?? bogotaToday();
  const [invoices, commitments, fines] = await Promise.all([
    overdueReceivableInvoices(db, { today }),
    db
      .from('commitments')
      .select('id, title, amount_cop, due_on')
      .eq('kind', 'payment')
      .eq('review_state', 'confirmed')
      .not('state', 'in', '(met,dropped)')
      .not('amount_cop', 'is', null)
      .lte('due_on', addDays(today, DUE_SOON_DAYS))
      .limit(1000),
    db.from('vehicle_fines').select('amount_cop').eq('status', 'PENDING').limit(2000),
  ]);
  if (commitments.error) throw commitments.error;
  if (fines.error) throw fines.error;

  let receivablesOverdue = 0;
  let overdueInvoices = 0;
  const others = new Map<string, { receivablesOverdue: number; overdueInvoices: number }>();
  for (const inv of invoices) {
    if (isCop(inv.currency)) {
      receivablesOverdue += inv.balance;
      overdueInvoices += 1;
    } else {
      const code = inv.currency.trim().toUpperCase();
      const b = others.get(code) ?? { receivablesOverdue: 0, overdueInvoices: 0 };
      b.receivablesOverdue += inv.balance;
      b.overdueInvoices += 1;
      others.set(code, b);
    }
  }

  let paymentsOverdue = 0;
  let paymentsDueSoon = 0;
  const paid = dedupePaymentCommitments((commitments.data ?? []) as PaymentCommitmentRow[]);
  for (const c of paid.rows) {
    if (c.due_on < today) paymentsOverdue += c.amount;
    else paymentsDueSoon += c.amount;
  }
  const paymentCount = paid.rows.length;

  const fineRows = ((fines.data ?? []) as Array<{ amount_cop: number | string }>).filter(
    (f) => Number.isFinite(Number(f.amount_cop)) && Number(f.amount_cop) > 0,
  );
  const finesPending = fineRows.reduce((sum, f) => sum + Number(f.amount_cop), 0);

  return {
    today,
    cop: {
      receivablesOverdue,
      overdueInvoices,
      paymentsOverdue,
      paymentsDueSoon,
      paymentCommitments: paymentCount,
      finesPending,
      fines: fineRows.length,
      total: receivablesOverdue + paymentsOverdue + paymentsDueSoon + finesPending,
    },
    sources: [
      {
        key: 'cartera_vencida',
        label: 'Cartera vencida',
        amount: receivablesOverdue,
        count: overdueInvoices,
        direction: 'por_cobrar',
        from: 'Saldo de facturas por cobrar ya vencidas (confirmadas como documento o traídas del programa contable, cada una una vez), contado con el día de Bogotá.',
      },
      {
        key: 'pagos_comprometidos',
        label: 'Pagos comprometidos',
        amount: paymentsOverdue + paymentsDueSoon,
        count: paymentCount,
        direction: 'por_pagar',
        from: `Vencimientos de pago confirmados, vencidos o que vencen en ${DUE_SOON_DAYS} días. No incluye las facturas de proveedor de Por pagar.`,
      },
      {
        key: 'multas',
        label: 'Multas de tránsito',
        amount: finesPending,
        count: fineRows.length,
        direction: 'por_pagar',
        from: 'Comparendos pendientes que reportó el SIMIT.',
      },
    ],
    duplicatePaymentsIgnored: paid.duplicates,
    otherCurrencies: [...others.entries()]
      .map(([currency, b]) => ({ currency, ...b }))
      .sort((a, b) => b.receivablesOverdue - a.receivablesOverdue),
    topInvoices: invoices.slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Los escalones de mora que merecen un aviso
// ---------------------------------------------------------------------------

/**
 * Se avisa al CRUZAR cada escalón, una vez: al vencer, a los 30, a los 60 y a
 * los 90 días. No todos los días — un correo diario con la misma factura
 * enseña a ignorarlo al tercer día. El vigilante reclama (factura, escalón) en
 * `receivable_notices` antes de mandar nada (migración 0159).
 */
export const OVERDUE_STAGES = [1, 30, 60, 90] as const;
export type OverdueStage = (typeof OVERDUE_STAGES)[number];

export function overdueStage(daysOverdue: number): OverdueStage | null {
  let stage: OverdueStage | null = null;
  for (const s of OVERDUE_STAGES) if (daysOverdue >= s) stage = s;
  return stage;
}

export function stageLabel(stage: OverdueStage): string {
  return stage === 1 ? 'recién vencida' : `más de ${stage} días`;
}

// ---------------------------------------------------------------------------
// Reclamar el aviso antes de mandarlo
// ---------------------------------------------------------------------------

/**
 * Gana o pierde el derecho a avisar de (factura, escalón). Mismo contrato que
 * `claimNotice` de los vencimientos: el índice único de la 0159 decide, no este
 * código, así que un cron que corre dos veces manda un correo.
 */
export async function claimReceivableNotice(
  db: SupabaseClient,
  input: {
    invoiceId: string;
    stage: OverdueStage;
    sentOn: string;
    /** 0165: una factura de un programa contable se reclama por su propia columna. */
    source?: OverdueInvoice['source'];
    /**
     * 0166: lo que se debía el día del aviso. Es el punto de partida de «plata
     * recuperada» (recovered.ts): sin él, cuánto se debía cuando Cortex actuó
     * sería una suposición.
     */
    balance?: number;
    currency?: string;
  },
): Promise<boolean> {
  const { error } = await db.from('receivable_notices').insert({
    [noticeColumn(input.source)]: input.invoiceId,
    stage: input.stage,
    sent_on: input.sentOn,
    ...(input.balance != null && Number.isFinite(input.balance) && input.balance >= 0
      ? { balance: Math.round(input.balance * 100) / 100 }
      : {}),
    ...(input.currency && /^[A-Z]{3}$/.test(input.currency.trim().toUpperCase())
      ? { currency: input.currency.trim().toUpperCase() }
      : {}),
  });
  if (!error) return true;
  if ((error as { code?: string }).code === '23505') return false;
  throw error;
}

/**
 * La columna de `receivable_notices` que nombra la factura: la extracción de un
 * documento (0159) o la factura de un programa contable (0165). Exactamente
 * una va llena; la base lo exige.
 */
export function noticeColumn(
  source: OverdueInvoice['source'] | undefined,
): 'extraction_id' | 'accounting_invoice_id' {
  return source === 'accounting' ? 'accounting_invoice_id' : 'extraction_id';
}
