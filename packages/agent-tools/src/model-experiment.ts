import { CHAT_MODEL, FAST_MODEL, resolveModelId } from './model';

/**
 * EL EXPERIMENTO: ¿Haiku 5.5 aguanta el chat principal?
 *
 * Un porcentaje de las CONVERSACIONES (no de los turnos) corre en Haiku 5.5;
 * el resto, en Sonnet 5.5. La asignación es por conversación y estable:
 *
 *   - POR CONVERSACIÓN, no por turno, porque el caché de prompts es por modelo.
 *     Cambiar de modelo a mitad invalida el prefijo entero (herramientas y
 *     system incluidos) y el siguiente turno paga una escritura al 1,25× en vez
 *     de una lectura al 0,1×.
 *   - ESTABLE: un hash del id de la conversación, sin estado. La misma
 *     conversación cae siempre en el mismo brazo, en cualquier instancia, sin
 *     tabla de asignaciones.
 *
 * LA SALIDA DE EMERGENCIA, también por conversación: si una conversación en
 * Haiku falla herramientas dos veces o recibe un `refusal`, el resto de ESA
 * conversación sigue en Sonnet 5.5 (un cambio, una sola vez, en un punto que de
 * todos modos ya fue un mal turno). Se decide leyendo lo registrado en
 * `model_usage` (0236), sin estado propio.
 *
 * Sólo se asigna cuando el agente usa el modelo por defecto del chat: un agente
 * que alguien apuntó a Opus a propósito no entra al experimento.
 */

/** Cuántas conversaciones de cada 100 van a Haiku, si la variable no dice otra cosa. */
export const DEFAULT_HAIKU_SHARE = 15;
/** Fallos de herramienta (acumulados en la conversación) que sacan de Haiku. */
export const HAIKU_TOOL_ERROR_LIMIT = 2;

export type ExperimentArm = 'haiku' | 'sonnet';

/** `CHAT_HAIKU_SHARE`: 0..100; vacío, ausente o basura = el valor por defecto. */
export function parseHaikuShare(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw.trim() === '') return DEFAULT_HAIKU_SHARE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_HAIKU_SHARE;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** FNV-1a de 32 bits: barato, estable y bien repartido sobre uuids. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** El cubo 0..99 de una conversación. */
export function conversationBucket(conversationId: string): number {
  return hash32(conversationId) % 100;
}

/** El brazo de una conversación para un porcentaje dado. */
export function assignArm(conversationId: string, haikuShare: number): ExperimentArm {
  return conversationBucket(conversationId) < haikuShare ? 'haiku' : 'sonnet';
}

/** Lo ya ocurrido en los turnos Haiku de la conversación (de `model_usage`). */
export interface HaikuHistory {
  toolErrors: number;
  refusals: number;
}

export interface TurnModelDecision {
  /** Id del modelo con el que corre ESTE turno. */
  model: string;
  /** Brazo asignado a la conversación; null = fuera del experimento. */
  arm: ExperimentArm | null;
  /** Estaba asignada a Haiku pero este turno corre en Sonnet por un fallo previo. */
  fellBack: boolean;
  reason?: 'tool_errors' | 'refusal';
}

/**
 * El modelo de un turno. Pura.
 *
 * `configuredModel` es el del agente: sólo si resuelve al modelo por defecto del
 * chat se entra al experimento.
 */
export function decideTurnModel(input: {
  conversationId: string;
  configuredModel: string | null | undefined;
  haikuShare: number;
  history?: HaikuHistory | null;
}): TurnModelDecision {
  const configured = resolveModelId(input.configuredModel);
  if (configured !== CHAT_MODEL || input.haikuShare <= 0) {
    return { model: configured, arm: null, fellBack: false };
  }
  const arm = assignArm(input.conversationId, input.haikuShare);
  if (arm === 'sonnet') return { model: CHAT_MODEL, arm, fellBack: false };

  const history = input.history;
  if (history && history.refusals >= 1) {
    return { model: CHAT_MODEL, arm, fellBack: true, reason: 'refusal' };
  }
  if (history && history.toolErrors >= HAIKU_TOOL_ERROR_LIMIT) {
    return { model: CHAT_MODEL, arm, fellBack: true, reason: 'tool_errors' };
  }
  return { model: FAST_MODEL, arm, fellBack: false };
}

/** ¿Hay que mirar el historial? Sólo las conversaciones de Haiku lo necesitan. */
export function needsHistory(input: {
  conversationId: string;
  configuredModel: string | null | undefined;
  haikuShare: number;
}): boolean {
  return decideTurnModel({ ...input, history: null }).model === FAST_MODEL;
}
