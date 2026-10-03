import { type OpportunityRow, type StageDef, isClosedStage, stageByRole, stageOf } from './shape';

/**
 * LAS REGLAS DEL EMBUDO (migración 0193) — puras, sin base ni reloj.
 *
 *   1. La cotización mueve la etapa sola. Una oportunidad atada a una
 *      cotización de Ventas (0182) sigue lo que le pasa a esa cotización:
 *        enviada                → «Cotización enviada» (sólo hacia adelante:
 *                                 no devuelve una negociación a «enviada»)
 *        aceptada / pedido / facturada → «Ganada» (y se ata el pedido)
 *        vencida sin respuesta  → «En riesgo»
 *        rechazada              → «En riesgo» (perderla es decisión de una
 *                                 persona: a veces se manda otra cotización)
 *      Lo ganado o perdido no se mueve: sólo se le ata el pedido que falte.
 *
 *   2. Lo quieto pide seguimiento. Un negocio abierto sin actividad en N días
 *      (14 por defecto) o con el siguiente paso vencido sale en la lista de
 *      seguimiento con una frase de qué hacer, escrita por reglas.
 */

/** Lo que las reglas necesitan saber de una cotización. */
export interface QuoteFacts {
  id: string;
  /** «COT-12». */
  label: string;
  status: string;
  validUntil: string | null;
  /** El pedido que salió de ella, si existe. */
  orderId: string | null;
}

export interface StageChange {
  stage: string | null;
  orderId: string | null;
  /** La frase de la huella: «COT-12 fue aceptada por el cliente». */
  reason: string;
  won: boolean;
}

const WON_QUOTE = new Set(['aceptada', 'pedido', 'facturada']);

function indexOf(stages: readonly StageDef[], key: string): number {
  const i = stages.findIndex((s) => s.key === key);
  return i < 0 ? 0 : i;
}

export function quoteStageRule(
  opp: Pick<OpportunityRow, 'stage' | 'order_id'>,
  quote: QuoteFacts,
  stages: readonly StageDef[],
  today: string,
): StageChange | null {
  if (quote.status === 'anulada') return null;
  const won = stageByRole(stages, 'won');
  const atRisk = stageByRole(stages, 'at_risk');
  const sent = stageByRole(stages, 'quote_sent');
  const needsOrder = quote.orderId && !opp.order_id ? quote.orderId : null;

  if (isClosedStage(stages, opp.stage)) {
    // Ganada a mano antes de que Ventas se enterara: sólo falta atar el pedido.
    if (needsOrder && stageOf(stages, opp.stage)?.role === 'won')
      return {
        stage: null,
        orderId: needsOrder,
        reason: `Se ató el pedido de ${quote.label}.`,
        won: false,
      };
    return null;
  }

  if (WON_QUOTE.has(quote.status)) {
    if (!won) return null;
    return {
      stage: won.key,
      orderId: needsOrder,
      reason:
        quote.status === 'aceptada'
          ? `${quote.label} fue aceptada por el cliente.`
          : `${quote.label} ya es pedido.`,
      won: true,
    };
  }

  const expired =
    (quote.status === 'enviada' || quote.status === 'borrador') &&
    quote.validUntil !== null &&
    quote.validUntil < today;
  if (expired || quote.status === 'vencida') {
    if (!atRisk || opp.stage === atRisk.key) return null;
    return {
      stage: atRisk.key,
      orderId: null,
      reason: `${quote.label} venció${quote.validUntil ? ` el ${quote.validUntil}` : ''} sin respuesta del cliente.`,
      won: false,
    };
  }

  if (quote.status === 'rechazada') {
    if (!atRisk || opp.stage === atRisk.key) return null;
    return {
      stage: atRisk.key,
      orderId: null,
      reason: `El cliente rechazó ${quote.label}. Decide si mandar otra o darla por perdida.`,
      won: false,
    };
  }

  if (quote.status === 'enviada' && sent) {
    // Sólo hacia adelante, y nunca desde «En riesgo» (eso lo decide una persona).
    if (opp.stage === sent.key || opp.stage === atRisk?.key) return null;
    if (indexOf(stages, opp.stage) >= indexOf(stages, sent.key)) return null;
    return {
      stage: sent.key,
      orderId: null,
      reason: `Se le envió ${quote.label} al cliente.`,
      won: false,
    };
  }
  return null;
}

/**
 * Atar sola una cotización a una oportunidad: la oportunidad abierta del MISMO
 * cliente, sin cotización, creada antes que ella. Si hay más de una candidata
 * no se adivina (null): dos negocios abiertos con el mismo cliente se atan a
 * mano.
 */
export function matchQuoteToOpportunity(
  quote: { clientId: string | null; createdAt: string },
  opps: ReadonlyArray<
    Pick<OpportunityRow, 'id' | 'client_id' | 'quote_id' | 'stage' | 'created_at'>
  >,
  stages: readonly StageDef[],
): string | null {
  if (!quote.clientId) return null;
  const candidates = opps.filter(
    (o) =>
      o.client_id === quote.clientId &&
      !o.quote_id &&
      !isClosedStage(stages, o.stage) &&
      o.created_at <= quote.createdAt,
  );
  return candidates.length === 1 ? (candidates[0]?.id ?? null) : null;
}

// ---------------------------------------------------------------------------
// Lo quieto
// ---------------------------------------------------------------------------

export const STALE_DAYS = 14;

export interface StaleDeal {
  id: string;
  title: string;
  clientName: string;
  ownerUserId: string | null;
  value: number;
  currency: string;
  stage: string;
  quietDays: number;
  /** Días de vencido el siguiente paso (>0), si lo tiene vencido. */
  nextStepLate: number | null;
  /** Qué hacer, en una frase. */
  suggestion: string;
  /** Por qué sale, con cifras. */
  why: string;
}

function daysFrom(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) /
      86_400_000,
  );
}

function suggestionFor(
  opp: Pick<OpportunityRow, 'stage' | 'client_name' | 'next_step'>,
  stages: readonly StageDef[],
  late: number | null,
): string {
  if (late !== null && opp.next_step) return `Haz lo pendiente: «${opp.next_step}».`;
  const role = stageOf(stages, opp.stage)?.role;
  if (role === 'quote_sent')
    return `Llama a ${opp.client_name} para saber qué le pareció la cotización y qué le falta para decidir.`;
  if (role === 'at_risk')
    return `Rescátalo: pregúntale a ${opp.client_name} qué cambió, o dalo por perdido con su razón.`;
  const index = stages.findIndex((s) => s.key === opp.stage);
  if (index <= 0) return `Haz el primer contacto con ${opp.client_name} y agenda una reunión.`;
  if (index === 1)
    return `Arma la cotización para ${opp.client_name} con lo que ya sabes que necesita.`;
  return `Retoma la conversación con ${opp.client_name} y acuerda una fecha de decisión.`;
}

export function staleDeals(
  opps: ReadonlyArray<OpportunityRow>,
  stages: readonly StageDef[],
  today: string,
  days = STALE_DAYS,
): StaleDeal[] {
  const out: StaleDeal[] = [];
  for (const o of opps) {
    if (isClosedStage(stages, o.stage)) continue;
    const quiet = Math.max(0, daysFrom(o.last_activity_at, today));
    const late =
      o.next_step_due && o.next_step_due < today ? daysFrom(o.next_step_due, today) : null;
    if (quiet < days && late === null) continue;
    const why =
      late !== null
        ? `El siguiente paso${o.next_step ? ` «${o.next_step}»` : ''} venció hace ${late} día${late === 1 ? '' : 's'}${quiet >= days ? ` y no hay actividad hace ${quiet} días` : ''}.`
        : `Sin actividad hace ${quiet} días en «${stageOf(stages, o.stage)?.label ?? o.stage}».`;
    out.push({
      id: o.id,
      title: o.title,
      clientName: o.client_name,
      ownerUserId: o.owner_user_id,
      value: o.value,
      currency: o.currency,
      stage: o.stage,
      quietDays: quiet,
      nextStepLate: late,
      suggestion: suggestionFor(o, stages, late),
      why,
    });
  }
  // Lo de más plata y más quieto primero.
  return out.sort((a, b) => b.value - a.value || b.quietDays - a.quietDays);
}
