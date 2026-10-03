import { type RiskLevel, formatAmount } from './shape';

/**
 * EL RIESGO DE PERDER A UN CLIENTE, CON SU EVIDENCIA (migración 0193).
 *
 * Puro: mismas entradas, mismo resultado. La lectura está en ./read.ts.
 *
 * Cada señal se compara con la HISTORIA DEL MISMO CLIENTE, no con un umbral de
 * la empresa: un cliente que compra cada seis meses no está «perdido» a los
 * tres, y uno que compraba cada dos semanas sí preocupa al mes y medio.
 *
 *   frecuencia   días desde su última compra contra su intervalo típico
 *                (mediana entre compras). ≥2× ya pesa; ≥3× pesa más.
 *   facturación  lo de los últimos 90 días contra su promedio por trimestre del
 *                año anterior a eso. Cae a la mitad → pesa; a menos de un 30 %
 *                → pesa más.
 *   pagos        días de pago de lo facturado en los últimos 6 meses contra lo
 *                de antes (de la cartera, igual que la ficha 360). +15 días y
 *                50 % más lento → pesa. Mora de más de 60 días también.
 *   contacto     días sin correo, reunión, WhatsApp, nota ni cobro, sólo si el
 *                cliente compró en el último año (si no compra, el silencio no
 *                es una señal nueva).
 *   quejas       conversaciones de WhatsApp escaladas a una persona (0185) en
 *                los últimos 90 días.
 *   encuesta     su última calificación (180 días) fue de detractor (0–6).
 *
 * Puntaje 0–100 sumando pesos; ≥50 alto, ≥25 medio. Con poca historia una
 * señal no se calcula (se dice por qué no en `gaps`): nunca se inventa.
 */

export interface ChurnInput {
  clientId: string;
  clientName: string;
  today: string;
  /** Sus facturas en pesos (emitidas; anuladas fuera). */
  invoices: ReadonlyArray<{ issuedOn: string; total: number }>;
  /** Días promedio de pago de lo facturado en los últimos 180 días y de lo anterior. */
  paymentDays?: {
    recent: { average: number; sample: number } | null;
    prior: { average: number; sample: number } | null;
  };
  /** La mora más vieja de lo abierto, si hay vencidas. */
  overdue?: { amount: number; maxDays: number } | null;
  lastContactAt: string | null;
  escalations?: ReadonlyArray<{ at: string; reason: string | null }>;
  nps?: ReadonlyArray<{ at: string; score: number; comment: string | null }>;
}

export type ChurnSignalKey =
  | 'frecuencia'
  | 'facturacion'
  | 'pagos'
  | 'mora'
  | 'contacto'
  | 'quejas'
  | 'encuesta';

export interface ChurnSignal {
  key: ChurnSignalKey;
  weight: number;
  /** La frase con cifras: «Compraba cada 21 días y lleva 64 sin comprar». */
  evidence: string;
}

export interface ChurnAssessment {
  clientId: string;
  clientName: string;
  level: RiskLevel;
  score: number;
  signals: ChurnSignal[];
  /** La acción sugerida, para la señal más fuerte. Null sin riesgo. */
  action: string | null;
  /** Lo facturado en los últimos 12 meses (lo que está en juego). */
  revenue12m: number;
  /** Señales que no se pudieron medir y por qué. */
  gaps: string[];
}

export const CONTACT_QUIET_DAYS = 60;
const DAY = 86_400_000;

function days(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) /
      DAY,
  );
}

function minus(today: string, n: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function levelOf(score: number): RiskLevel {
  if (score >= 50) return 'alto';
  if (score >= 25) return 'medio';
  return 'bajo';
}

export function assessChurn(input: ChurnInput): ChurnAssessment {
  const { today } = input;
  const signals: ChurnSignal[] = [];
  const gaps: string[] = [];
  const invoices = input.invoices
    .filter((i) => i.issuedOn && i.issuedOn <= today && i.total > 0)
    .sort((a, b) => a.issuedOn.localeCompare(b.issuedOn));
  const since12 = minus(today, 365);
  const revenue12m = invoices.filter((i) => i.issuedOn >= since12).reduce((s, i) => s + i.total, 0);
  const boughtThisYear = revenue12m > 0;

  // --- Frecuencia ----------------------------------------------------------
  // Días distintos de compra: tres facturas el mismo día son una compra.
  const buyDays = [...new Set(invoices.map((i) => i.issuedOn))];
  if (buyDays.length >= 4) {
    const gapsBetween: number[] = [];
    for (let i = 1; i < buyDays.length; i++)
      gapsBetween.push(days(buyDays[i - 1] as string, buyDays[i] as string));
    const typical = Math.max(1, Math.round(median(gapsBetween)));
    const since = days(buyDays[buyDays.length - 1] as string, today);
    const ratio = since / typical;
    if (since >= 30 && ratio >= 2) {
      signals.push({
        key: 'frecuencia',
        weight: ratio >= 3 ? 35 : 25,
        evidence: `Compraba cada ${plural(typical, 'día', 'días')} y lleva ${plural(since, 'día', 'días')} sin comprar.`,
      });
    }
  } else if (invoices.length > 0) {
    gaps.push(
      'Frecuencia: menos de cuatro compras en la historia, no hay un ritmo con qué comparar.',
    );
  }

  // --- Facturación -----------------------------------------------------------
  const recentFrom = minus(today, 90);
  const priorFrom = minus(today, 455);
  const recent = invoices.filter((i) => i.issuedOn > recentFrom);
  const prior = invoices.filter((i) => i.issuedOn > priorFrom && i.issuedOn <= recentFrom);
  if (prior.length >= 3) {
    const priorQuarter = (prior.reduce((s, i) => s + i.total, 0) / 365) * 90;
    const recentTotal = recent.reduce((s, i) => s + i.total, 0);
    const share = priorQuarter > 0 ? recentTotal / priorQuarter : 1;
    if (share < 0.5) {
      const drop = Math.round((1 - share) * 100);
      signals.push({
        key: 'facturacion',
        weight: share < 0.3 ? 30 : 20,
        evidence: `En los últimos 90 días le facturó ${formatAmount(recentTotal)}; antes promediaba ${formatAmount(priorQuarter)} por trimestre (${drop} % menos).`,
      });
    }
  } else if (invoices.length > 0) {
    gaps.push('Facturación: menos de tres facturas en el año anterior para comparar.');
  }

  // --- Pagos ---------------------------------------------------------------
  const pd = input.paymentDays;
  if (pd?.recent && pd.prior && pd.recent.sample >= 2 && pd.prior.sample >= 2) {
    const delta = pd.recent.average - pd.prior.average;
    if (delta >= 15 && pd.recent.average >= pd.prior.average * 1.5) {
      signals.push({
        key: 'pagos',
        weight: delta >= 30 ? 20 : 15,
        evidence: `Paga cada vez más tarde: ${pd.recent.average} días en promedio en los últimos 6 meses, contra ${pd.prior.average} antes.`,
      });
    }
  } else if (pd) {
    gaps.push('Pagos: pocas facturas pagadas para ver si se está demorando más.');
  }
  if (input.overdue && input.overdue.maxDays > 60 && input.overdue.amount > 0) {
    signals.push({
      key: 'mora',
      weight: 15,
      evidence: `Debe ${formatAmount(input.overdue.amount)} vencidos; la factura más vieja lleva ${input.overdue.maxDays} días de mora.`,
    });
  }

  // --- Contacto --------------------------------------------------------------
  if (boughtThisYear) {
    if (input.lastContactAt) {
      const quiet = days(input.lastContactAt, today);
      if (quiet >= CONTACT_QUIET_DAYS)
        signals.push({
          key: 'contacto',
          weight: quiet >= 120 ? 20 : 15,
          evidence: `Nadie de la empresa ha hablado con ${input.clientName} hace ${quiet} días (correo, reunión, WhatsApp o nota).`,
        });
    } else {
      signals.push({
        key: 'contacto',
        weight: 10,
        evidence: `Compró este año pero no hay ningún correo, reunión ni WhatsApp registrado con ${input.clientName}.`,
      });
    }
  }

  // --- Quejas ------------------------------------------------------------------
  const since90 = minus(today, 90);
  const escal = (input.escalations ?? []).filter((e) => e.at.slice(0, 10) >= since90);
  if (escal.length > 0) {
    const last = escal.reduce((m, e) => (e.at > m.at ? e : m));
    signals.push({
      key: 'quejas',
      weight: Math.min(30, 20 + (escal.length - 1) * 5),
      evidence: `${plural(escal.length, 'conversación de WhatsApp escalada', 'conversaciones de WhatsApp escaladas')} a una persona en 90 días${last.reason ? `; la última: «${last.reason.slice(0, 120)}»` : ''}.`,
    });
  }

  // --- Encuesta ----------------------------------------------------------------
  const since180 = minus(today, 180);
  const lastNps = (input.nps ?? [])
    .filter((n) => n.at.slice(0, 10) >= since180)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (lastNps && lastNps.score <= 6) {
    signals.push({
      key: 'encuesta',
      weight: lastNps.score <= 3 ? 30 : 25,
      evidence: `En la encuesta calificó ${lastNps.score}/10${lastNps.comment ? `: «${lastNps.comment.slice(0, 160)}»` : ''}.`,
    });
  }

  signals.sort((a, b) => b.weight - a.weight);
  const score = Math.min(
    100,
    signals.reduce((s, x) => s + x.weight, 0),
  );
  const level = levelOf(score);
  return {
    clientId: input.clientId,
    clientName: input.clientName,
    level,
    score,
    signals,
    action: level === 'bajo' ? null : actionFor(signals[0], input, lastNps?.score ?? null),
    revenue12m,
    gaps,
  };
}

function actionFor(
  top: ChurnSignal | undefined,
  input: ChurnInput,
  npsScore: number | null,
): string | null {
  if (!top) return null;
  const name = input.clientName;
  switch (top.key) {
    case 'encuesta':
      return `Llama a ${name} para entender su ${npsScore === null ? 'calificación' : `${npsScore}/10`} y acordar qué se corrige, antes de que se vaya.`;
    case 'quejas':
      return `Revisa la queja por WhatsApp con quien la atendió y llama a ${name} para cerrarla en persona.`;
    case 'frecuencia':
    case 'facturacion':
      return `Visita o llama a ${name}: pregúntale si cambió algo (precio, servicio, un competidor) y ofrécele una cotización de lo que solía comprar.`;
    case 'pagos':
    case 'mora':
      return `Habla con ${name} sobre los pagos: una demora que crece puede ser un problema de caja o un cliente inconforme.`;
    case 'contacto':
      return `Retoma el contacto con ${name}: una llamada de cortesía o una reunión de seguimiento.`;
    default:
      return null;
  }
}

/** Sólo los que están en riesgo, lo más grave y de más plata primero. */
export function atRiskList(assessments: readonly ChurnAssessment[]): ChurnAssessment[] {
  return assessments
    .filter((a) => a.level !== 'bajo')
    .sort((a, b) => b.score - a.score || b.revenue12m - a.revenue12m);
}
