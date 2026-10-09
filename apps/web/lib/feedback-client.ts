/**
 * Lado navegador del 👍/👎 (POST /api/chat/feedback). SIN imports de
 * `@cortex/agent-tools`: un componente de cliente que toque el barril tumba el
 * build de producción. Los motivos se repiten aquí a propósito.
 */

export type FeedbackReasonId = 'wrong_data' | 'not_requested' | 'slow' | 'other';

export const REASON_CHIPS: ReadonlyArray<{ id: FeedbackReasonId; label: string }> = [
  { id: 'wrong_data', label: 'Dato equivocado' },
  { id: 'not_requested', label: 'No hizo lo que pedí' },
  { id: 'slow', label: 'Muy lento' },
  { id: 'other', label: 'Otro' },
];

export type FeedbackResult =
  | { ok: true; proposed: boolean; messageId: string | null }
  | { ok: false; error: string };

async function send(body: Record<string, unknown>): Promise<FeedbackResult> {
  try {
    const res = await fetch('/api/chat/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: 'No se pudo guardar tu opinión.' };
    const json = (await res.json()) as { proposed?: boolean; messageId?: string };
    return { ok: true, proposed: json.proposed === true, messageId: json.messageId ?? null };
  } catch {
    return { ok: false, error: 'No se pudo guardar tu opinión.' };
  }
}

export function sendRating(input: {
  conversationId: string;
  messageId: string;
  rating: 1 | -1;
  reason?: FeedbackReasonId | null;
  comment?: string | null;
}): Promise<FeedbackResult> {
  return send({ action: 'rate', ...input });
}

export function clearRating(input: {
  conversationId: string;
  messageId: string;
}): Promise<FeedbackResult> {
  return send({ action: 'clear', ...input });
}

const votesCache = new Map<string, Promise<Map<string, 1 | -1>>>();

/** Los votos propios de una conversación, una sola lectura por conversación. */
export function loadVotes(conversationId: string): Promise<Map<string, 1 | -1>> {
  let cached = votesCache.get(conversationId);
  if (!cached) {
    cached = fetch(`/api/chat/feedback?conversationId=${encodeURIComponent(conversationId)}`)
      .then((r) => (r.ok ? r.json() : { votes: [] }))
      .then(
        (j: { votes?: Array<{ messageId: string; rating: 1 | -1 }> }) =>
          new Map((j.votes ?? []).map((v) => [v.messageId, v.rating] as const)),
      )
      .catch(() => new Map<string, 1 | -1>());
    votesCache.set(conversationId, cached);
  }
  return cached;
}

/** Tras votar, la caché se actualiza para que remontar el mensaje no lo olvide. */
export function rememberVote(conversationId: string, messageId: string, rating: 1 | -1 | null) {
  void loadVotes(conversationId).then((map) => {
    if (rating === null) map.delete(messageId);
    else map.set(messageId, rating);
  });
}
