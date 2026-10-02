import 'server-only';
import { decideAction, runApprovedActionRow } from '@/lib/actions/decide';
import { decideApproval, runApprovedAction } from '@/lib/approvals/decide';

/**
 * «APROBAR LAS 6»: EL LOTE ES UN BUCLE SOBRE LA PUERTA DE SIEMPRE.
 *
 * No hay una segunda manera de aprobar. Cada elemento del lote pasa, en orden
 * y uno por uno, por exactamente lo mismo que el botón de su tarjeta:
 *
 *   approvals  decideApproval → runApprovedAction (lib/approvals/decide.ts)
 *   actions    decideAction   → runApprovedActionRow (lib/actions/decide.ts)
 *
 * Así cada uno queda reclamado (la reclamación atómica impide aprobar dos
 * veces), auditado con la persona que decidió, re-chequeado contra lo que el
 * equipo bloqueó, y ejecutado con la guarda de repetición de 0168 intacta: el
 * lote NUNCA pide `allowRepeat`, así que algo idéntico ya hecho vuelve como
 * «ya estaba hecho» en vez de repetirse. Lo que repite algo a sabiendas se
 * aprueba en su tarjeta, no aquí (la pantalla ni lo mete en el lote).
 *
 * Secuencial a propósito: en paralelo, seis envíos chocarían con el límite por
 * minuto de la herramienta y la mitad saldría como error sin haber fallado
 * nada. Y un fallo no detiene el lote: lo que sí salió, salió, y la respuesta
 * dice uno por uno qué pasó.
 */

/** Cuántos caben en un lote. El mismo tope que la pantalla (follow-through/group.ts). */
export const BATCH_LIMIT = 25;

export type BatchItemOutcome =
  | { id: string; ok: true; replayed: boolean }
  | { id: string; ok: false; message: string };

function replayed(result: unknown): boolean {
  const idem =
    result && typeof result === 'object'
      ? (result as { _idempotency?: { outcome?: unknown } })._idempotency
      : undefined;
  return idem?.outcome === 'replayed';
}

/** Llamadas paradas (`mcp_pending_actions`). */
export async function approveApprovalsBatch(input: {
  organizationId: string;
  userId: string;
  ids: readonly string[];
}): Promise<BatchItemOutcome[]> {
  const out: BatchItemOutcome[] = [];
  for (const id of [...new Set(input.ids)].slice(0, BATCH_LIMIT)) {
    const claim = await decideApproval({
      organizationId: input.organizationId,
      approvalId: id,
      userId: input.userId,
      decision: 'approved',
      via: 'web',
    });
    if (claim.status !== 'claimed') {
      out.push({ id, ok: false, message: claimMessage(claim.status) });
      continue;
    }
    const run = await runApprovedAction(claim.action);
    out.push(
      run.ok
        ? { id, ok: true, replayed: replayed(run.result) }
        : { id, ok: false, message: run.message },
    );
  }
  return out;
}

/** Borradores (`actions`): cada uno con la huella del texto que la persona vio. */
export async function approveActionsBatch(input: {
  organizationId: string;
  userId: string;
  items: ReadonlyArray<{ id: string; contentHash: string }>;
}): Promise<BatchItemOutcome[]> {
  const out: BatchItemOutcome[] = [];
  const seen = new Set<string>();
  for (const item of input.items.slice(0, BATCH_LIMIT)) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const claim = await decideAction({
      organizationId: input.organizationId,
      actionId: item.id,
      userId: input.userId,
      decision: 'approve',
      contentHash: item.contentHash,
      via: 'web',
    });
    if (claim.status !== 'claimed') {
      out.push({ id: item.id, ok: false, message: actionClaimMessage(claim.status) });
      continue;
    }
    const run = await runApprovedActionRow(input.organizationId, claim.action, item.contentHash);
    out.push(
      run.ok
        ? { id: item.id, ok: true, replayed: replayed(run.result) }
        : { id: item.id, ok: false, message: run.message },
    );
  }
  return out;
}

/** Descartar en lote lo que lleva días esperando: la misma puerta, decisión «dismiss». */
export async function dismissActionsBatch(input: {
  organizationId: string;
  userId: string;
  ids: readonly string[];
  reason: string;
}): Promise<BatchItemOutcome[]> {
  const out: BatchItemOutcome[] = [];
  for (const id of [...new Set(input.ids)].slice(0, BATCH_LIMIT)) {
    const claim = await decideAction({
      organizationId: input.organizationId,
      actionId: id,
      userId: input.userId,
      decision: 'dismiss',
      reason: input.reason,
      via: 'web',
    });
    out.push(
      claim.status === 'claimed'
        ? { id, ok: true, replayed: false }
        : { id, ok: false, message: actionClaimMessage(claim.status) },
    );
  }
  return out;
}

function claimMessage(status: string): string {
  switch (status) {
    case 'expired':
      return 'Ya había vencido; no se ejecutó.';
    case 'already_decided':
      return 'Ya estaba decidida; no se ejecutó otra vez.';
    default:
      return 'No existe o no es tuya.';
  }
}

function actionClaimMessage(status: string): string {
  switch (status) {
    case 'expired':
      return 'Ya venció: las cifras quedaron viejas. No se envió.';
    case 'already_decided':
      return 'Ya estaba decidida; no se envió otra vez.';
    case 'content_changed':
      return 'El texto cambió desde que lo viste; no se envió. Revísalo en su tarjeta.';
    default:
      return 'No existe o no es tuya.';
  }
}

/** La frase del resultado del lote. */
export function batchSummary(outcomes: readonly BatchItemOutcome[], verb = 'Aprobé'): string {
  const ok = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.length - ok;
  if (failed === 0) return `${verb} ${ok} de ${outcomes.length}.`;
  return `${verb} ${ok} de ${outcomes.length}; ${failed} no ${failed === 1 ? 'se pudo' : 'se pudieron'}: revísalas una por una.`;
}
