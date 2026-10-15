import { canonicalInput } from './confirmation-claim';

/**
 * UNA PROPUESTA, UNA TARJETA.
 *
 * El modelo a veces llama dos veces a la misma herramienta con la misma
 * entrada en un turno (se vio con `trackers.define`: dos tarjetas idénticas
 * «Crear o cambiar la tabla…» en el mismo mensaje, y aprobar una dejaba la
 * gemela pendiente). Dos defensas con la misma llave:
 *
 *  - la interfaz dibuja una sola (`dedupeProposals`), por toolCallId y por
 *    (herramienta + entrada canónica);
 *  - el servidor no crea la segunda tarjeta (`createProposalGuard`): le
 *    devuelve al modelo un resultado corto en vez del centinela.
 *
 * Pura: la importan el navegador, la ruta del chat y la de confirmar.
 */

/** La llave de una propuesta: independiente del orden de las llaves del input. */
export function proposalKey(toolId: string, input: unknown): string {
  return `${toolId}\u0000${canonicalInput(input)}`;
}

export function dedupeProposals<T extends { toolCallId: string; toolId: string; input: unknown }>(
  items: readonly T[],
): T[] {
  const ids = new Set<string>();
  const keys = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = proposalKey(item.toolId, item.input);
    if (ids.has(item.toolCallId) || keys.has(key)) continue;
    ids.add(item.toolCallId);
    keys.add(key);
    out.push(item);
  }
  return out;
}

/** Lo que el modelo lee cuando repite una propuesta que sigue esperando. */
export const DUPLICATE_PROPOSAL_MESSAGE =
  'Ya está propuesto y espera aprobación; no lo repitas. Espera a que la persona decida.';

export interface DuplicateProposalResult {
  __duplicate_proposal: true;
  toolId: string;
  message: string;
}

export function isDuplicateProposal(v: unknown): v is DuplicateProposalResult {
  return (
    Boolean(v) &&
    typeof v === 'object' &&
    (v as DuplicateProposalResult).__duplicate_proposal === true
  );
}

/** Una por turno: `seen(toolId, input)` es true desde la segunda vez. */
export function createProposalGuard() {
  const proposed = new Set<string>();
  return {
    seen(toolId: string, input: unknown): boolean {
      const key = proposalKey(toolId, input);
      if (proposed.has(key)) return true;
      proposed.add(key);
      return false;
    },
    duplicate(toolId: string): DuplicateProposalResult {
      return { __duplicate_proposal: true, toolId, message: DUPLICATE_PROPOSAL_MESSAGE };
    },
  };
}

/**
 * Tras aprobar una propuesta: ¿qué otras entradas del mismo mensaje son su
 * gemela (misma herramienta y entrada) y siguen pendientes? Devuelve sus
 * índices para que la ruta las marque como atendidas y no quede ninguna colgando.
 */
export function pendingTwinIndexes(
  results: ReadonlyArray<Record<string, unknown>>,
  approvedIndex: number,
): number[] {
  const approved = results[approvedIndex];
  const base = approved?.result as { toolId?: string; input?: unknown } | undefined;
  const toolId = base?.toolId;
  if (!toolId) return [];
  const key = proposalKey(toolId, base?.input);
  return results.flatMap((entry, i) => {
    const r = entry?.result as
      | { __requires_confirmation?: boolean; toolId?: string; input?: unknown }
      | undefined;
    return i !== approvedIndex &&
      r?.__requires_confirmation === true &&
      r.toolId === toolId &&
      proposalKey(toolId, r.input) === key
      ? [i]
      : [];
  });
}
