import type { SupabaseClient } from '@supabase/supabase-js';
import { defaultCompanySpace } from '../kb/proposals';
import {
  type CorrectionKind,
  type FeedbackReason,
  cleanComment,
  clip,
  inferCorrectionKind,
  looksLikeCorrection,
} from './pure';

/**
 * Lectura y escritura del 👍/👎 (migración 0219). Todo con el manejador de UNA
 * empresa (`getOrgScopedClient`); el filtro de tenencia lo pone el registro.
 */

export const FEEDBACK_TABLE = 'chat_message_feedback';

export interface FeedbackRow {
  id: string;
  userId: string;
  conversationId: string;
  messageId: string;
  rating: 1 | -1;
  reason: FeedbackReason | null;
  comment: string | null;
  question: string | null;
  answer: string | null;
  caseStatus: 'promoted' | 'dismissed' | null;
  createdAt: string;
}

interface Raw {
  id: string;
  user_id: string;
  conversation_id: string;
  message_id: string;
  rating: number;
  reason: string | null;
  comment: string | null;
  question: string | null;
  answer: string | null;
  case_status: string | null;
  created_at: string;
}

const COLUMNS =
  'id, user_id, conversation_id, message_id, rating, reason, comment, question, answer, case_status, created_at';

function toRow(r: Raw): FeedbackRow {
  return {
    id: r.id,
    userId: r.user_id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    rating: r.rating === 1 ? 1 : -1,
    reason: (r.reason as FeedbackReason | null) ?? null,
    comment: r.comment,
    question: r.question,
    answer: r.answer,
    caseStatus: (r.case_status as FeedbackRow['caseStatus']) ?? null,
    createdAt: r.created_at,
  };
}

export interface SaveFeedbackInput {
  organizationId: string;
  userId: string;
  conversationId: string;
  messageId: string;
  rating: 1 | -1;
  reason?: FeedbackReason | null;
  comment?: string | null;
  question?: string | null;
  answer?: string | null;
}

/** Crea o cambia el voto de esta persona sobre esta respuesta. */
export async function saveFeedback(
  db: SupabaseClient,
  input: SaveFeedbackInput,
): Promise<FeedbackRow> {
  const down = input.rating === -1;
  const payload = {
    organization_id: input.organizationId,
    user_id: input.userId,
    conversation_id: input.conversationId,
    message_id: input.messageId,
    rating: input.rating,
    // El motivo y el comentario sólo existen en un 👎: al pasar a 👍 se limpian.
    reason: down ? (input.reason ?? null) : null,
    comment: down ? cleanComment(input.comment) : null,
    question: down ? clip(input.question, 4000) : null,
    answer: down ? clip(input.answer, 8000) : null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from(FEEDBACK_TABLE)
    .upsert(payload, { onConflict: 'user_id,message_id' })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return toRow(data as unknown as Raw);
}

/** Quita el voto (deshacer). Devuelve si había algo que quitar. */
export async function clearFeedback(
  db: SupabaseClient,
  userId: string,
  messageId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from(FEEDBACK_TABLE)
    .delete()
    .eq('user_id', userId)
    .eq('message_id', messageId)
    .select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Los votos de esta persona en una conversación: para pintar los botones. */
export async function listConversationFeedback(
  db: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<Array<{ messageId: string; rating: 1 | -1 }>> {
  const { data, error } = await db
    .from(FEEDBACK_TABLE)
    .select('message_id, rating')
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .limit(500);
  if (error) throw error;
  return ((data ?? []) as unknown as Array<{ message_id: string; rating: number }>).map((r) => ({
    messageId: r.message_id,
    rating: r.rating === 1 ? 1 : -1,
  }));
}

/** Los 👎 sin revisar, con pregunta y respuesta: los «casos candidatos». */
export async function listCaseCandidates(
  db: SupabaseClient,
  opts: { status?: 'pending' | 'promoted'; limit?: number } = {},
): Promise<FeedbackRow[]> {
  let q = db
    .from(FEEDBACK_TABLE)
    .select(COLUMNS)
    .eq('rating', -1)
    .not('question', 'is', null)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 30);
  q = opts.status === 'promoted' ? q.eq('case_status', 'promoted') : q.is('case_status', null);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as unknown as Raw[]).map(toRow);
}

/** Convertir en caso de prueba (o descartar). Devuelve si cambió algo. */
export async function decideCaseCandidate(
  db: SupabaseClient,
  id: string,
  deciderId: string,
  decision: 'promoted' | 'dismissed',
): Promise<boolean> {
  const { data, error } = await db
    .from(FEEDBACK_TABLE)
    .update({
      case_status: decision,
      case_decided_by: deciderId,
      case_decided_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('rating', -1)
    .select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Los casos ya promovidos, en el formato de `EvalCase` simplificado (JSON). */
export interface PromotedCase {
  id: string;
  question: string;
  badAnswer: string;
  reason: FeedbackReason | null;
  note: string | null;
}

export function toPromotedCase(row: FeedbackRow): PromotedCase {
  return {
    id: `feedback-${row.id}`,
    question: row.question ?? '',
    badAnswer: row.answer ?? '',
    reason: row.reason,
    note: row.comment,
  };
}

/**
 * Si el comentario de un 👎 enuncia un hecho o una regla, lo propone para la
 * memoria de la empresa (`memory_proposals`, 0157): nunca escribe solo, una
 * persona con permiso lo aprueba. La cita es el propio comentario, que es
 * palabra de la persona. Devuelve el id de la propuesta o null.
 */
export async function proposeCorrectionFromFeedback(
  db: SupabaseClient,
  input: {
    userId: string;
    conversationId: string;
    reason: FeedbackReason | null;
    comment: string | null;
  },
): Promise<string | null> {
  if (input.reason === 'slow') return null;
  const comment = cleanComment(input.comment);
  if (!comment || !looksLikeCorrection(comment)) return null;
  const kind: CorrectionKind = inferCorrectionKind(comment);
  const target = await defaultCompanySpace(db, input.userId).catch(() => null);
  const { data, error } = await db
    .from('memory_proposals')
    .insert({
      proposed_by: input.userId,
      conversation_id: input.conversationId,
      kind,
      subject: null,
      statement: comment,
      quote: comment,
      target_space_id: target?.id ?? null,
    })
    .select('id')
    .maybeSingle();
  // La misma frase ya esperando no es un error.
  if (error && (error as { code?: string }).code === '23505') return null;
  if (error) throw error;
  return data ? String((data as { id: string }).id) : null;
}
