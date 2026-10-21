import { type UsageRow, rowCostUsd } from '@/lib/usage-cost';

/**
 * LA COMPARACIÓN POR MODELO DEL PANEL DE USO (0236). Pura.
 *
 * Responde la pregunta del experimento de Haiku 5.5 contra Sonnet 5.5 en el
 * chat: ¿cuánto cuesta cada turno y cada conversación, con qué frecuencia falla
 * una herramienta, cuántos reintentos hizo falta, y qué dijo la gente (👍/👎)?
 *
 * DOS LECTURAS DE LO MISMO, y las dos importan:
 *   - por MODELO que corrió el turno: lo que cada uno cuesta y hace;
 *   - por BRAZO asignado (intención de tratar): una conversación de Haiku que
 *     cayó a Sonnet sigue contando como Haiku, así que el rescate de Sonnet no
 *     esconde los fallos de Haiku ni le regala sus aciertos.
 *
 * Sólo cuenta turnos de chat con conversación: las tareas y encargos no son
 * comparables. Los modelos sin tarifa conocida suman turnos pero no dólares
 * (el costo por turno se calcula sólo sobre los que tienen precio).
 */

export interface FeedbackRow {
  conversationId: string;
  messageId: string;
  /** 1 = 👍, -1 = 👎. */
  rating: number;
}

export interface ComparisonRow {
  key: string;
  label: string;
  turns: number;
  conversations: number;
  usd: number;
  /** Dólares por turno con precio; null si ninguno lo tiene. */
  usdPerTurn: number | null;
  usdPerConversation: number | null;
  /** Turnos con al menos un fallo de herramienta. */
  turnsWithToolError: number;
  toolErrors: number;
  /** % de turnos con algún fallo de herramienta. */
  toolErrorPct: number;
  retries: number;
  refusals: number;
  /** Turnos que corrieron en Sonnet por un fallo previo del brazo Haiku. */
  fellBack: number;
  up: number;
  down: number;
  /** 👎 sobre las valoraciones recibidas; null sin valoraciones. */
  downPct: number | null;
}

export interface ModelComparison {
  byModel: ComparisonRow[];
  byArm: ComparisonRow[];
  /** Hay filas del experimento (la migración 0236 está aplicada y hay brazo asignado). */
  hasExperiment: boolean;
}

const MODEL_LABEL: Array<[RegExp, string]> = [
  [/claude-haiku-5-5/, 'Haiku 5.5'],
  [/claude-sonnet-5-5/, 'Sonnet 5.5'],
  [/claude-opus-5-5/, 'Opus 5.5'],
  [/claude-haiku-4-5/, 'Haiku 4.5'],
  [/claude-sonnet-5/, 'Sonnet 5'],
  [/claude-opus-5/, 'Opus 5'],
];

export function modelLabel(model: string): string {
  for (const [re, label] of MODEL_LABEL) if (re.test(model)) return label;
  return model;
}

interface Acc {
  key: string;
  label: string;
  turns: number;
  conversations: Set<string>;
  pricedTurns: number;
  usd: number;
  turnsWithToolError: number;
  toolErrors: number;
  retries: number;
  refusals: number;
  fellBack: number;
  up: number;
  down: number;
}

const acc = (key: string, label: string): Acc => ({
  key,
  label,
  turns: 0,
  conversations: new Set(),
  pricedTurns: 0,
  usd: 0,
  turnsWithToolError: 0,
  toolErrors: 0,
  retries: 0,
  refusals: 0,
  fellBack: 0,
  up: 0,
  down: 0,
});

function finish(a: Acc): ComparisonRow {
  const conversations = a.conversations.size;
  const rated = a.up + a.down;
  return {
    key: a.key,
    label: a.label,
    turns: a.turns,
    conversations,
    usd: a.usd,
    usdPerTurn: a.pricedTurns > 0 ? a.usd / a.pricedTurns : null,
    usdPerConversation: conversations > 0 && a.pricedTurns > 0 ? a.usd / conversations : null,
    turnsWithToolError: a.turnsWithToolError,
    toolErrors: a.toolErrors,
    toolErrorPct: a.turns > 0 ? (a.turnsWithToolError / a.turns) * 100 : 0,
    retries: a.retries,
    refusals: a.refusals,
    fellBack: a.fellBack,
    up: a.up,
    down: a.down,
    downPct: rated > 0 ? (a.down / rated) * 100 : null,
  };
}

const ARM_LABEL = { haiku: 'Asignadas a Haiku 5.5', sonnet: 'Asignadas a Sonnet 5.5' } as const;

export function buildModelComparison(
  rows: readonly UsageRow[],
  feedback: readonly FeedbackRow[] = [],
): ModelComparison {
  const byModel = new Map<string, Acc>();
  const byArm = new Map<string, Acc>();
  // De dónde sale el modelo/brazo de un 👍/👎: del mensaje si se conoce, y si no,
  // del último turno de esa conversación.
  const messageKey = new Map<string, { model: string; arm: string | null }>();
  const conversationKey = new Map<string, { model: string; arm: string | null; at: string }>();

  for (const r of rows) {
    if (r.source !== 'chat' || !r.conversationId) continue;
    const model = byModel.get(r.model) ?? acc(r.model, modelLabel(r.model));
    byModel.set(r.model, model);
    const targets = [model];
    if (r.arm) {
      const arm = byArm.get(r.arm) ?? acc(r.arm, ARM_LABEL[r.arm]);
      byArm.set(r.arm, arm);
      targets.push(arm);
    }
    const usd = rowCostUsd(r);
    for (const t of targets) {
      t.turns += 1;
      t.conversations.add(r.conversationId);
      if (usd !== null) {
        t.usd += usd;
        t.pricedTurns += 1;
      }
      const errors = r.toolErrors ?? 0;
      if (errors > 0) t.turnsWithToolError += 1;
      t.toolErrors += errors;
      t.retries += r.retries ?? 0;
      t.refusals += r.refusals ?? 0;
      if (r.fellBack) t.fellBack += 1;
    }
    if (r.messageId) messageKey.set(r.messageId, { model: r.model, arm: r.arm ?? null });
    const prev = conversationKey.get(r.conversationId);
    if (!prev || r.at > prev.at)
      conversationKey.set(r.conversationId, { model: r.model, arm: r.arm ?? null, at: r.at });
  }

  for (const f of feedback) {
    const hit = messageKey.get(f.messageId) ?? conversationKey.get(f.conversationId);
    if (!hit) continue;
    const targets = [byModel.get(hit.model)];
    if (hit.arm) targets.push(byArm.get(hit.arm));
    for (const t of targets) {
      if (!t) continue;
      if (f.rating > 0) t.up += 1;
      else if (f.rating < 0) t.down += 1;
    }
  }

  const order = (a: ComparisonRow, b: ComparisonRow) => b.turns - a.turns;
  return {
    byModel: [...byModel.values()].map(finish).sort(order),
    byArm: [...byArm.values()].map(finish).sort(order),
    hasExperiment: byArm.size > 0,
  };
}
