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

export async function moneyAtRisk(
  db: SupabaseClient,
  opts: { today?: string } = {},
): Promise<MoneyAtRisk> {
  const today = opts.today ?? bogotaToday();
  const [invoices, commitments, fines] = await Promise.all([
    overdueReceivableInvoices(db, { today }),
    db
      .from('commitments')
      .select('amount_cop, due_on')
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
  const paymentRows = (commitments.data ?? []) as Array<{
    amount_cop: number | string;
    due_on: string;
  }>;
  for (const c of paymentRows) {
    const amount = Number(c.amount_cop) || 0;
    if (c.due_on < today) paymentsOverdue += amount;
    else paymentsDueSoon += amount;
  }

  const fineRows = (fines.data ?? []) as Array<{ amount_cop: number | string }>;
  const finesPending = fineRows.reduce((sum, f) => sum + (Number(f.amount_cop) || 0), 0);

  return {
    today,
    cop: {
      receivablesOverdue,
      overdueInvoices,
      paymentsOverdue,
      paymentsDueSoon,
      paymentCommitments: paymentRows.length,
      finesPending,
      fines: fineRows.length,
      total: receivablesOverdue + paymentsOverdue + paymentsDueSoon + finesPending,
    },
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
  input: { invoiceId: string; stage: OverdueStage; sentOn: string },
): Promise<boolean> {
  const { error } = await db.from('receivable_notices').insert({
    extraction_id: input.invoiceId,
    stage: input.stage,
    sent_on: input.sentOn,
  });
  if (!error) return true;
  if ((error as { code?: string }).code === '23505') return false;
  throw error;
}
