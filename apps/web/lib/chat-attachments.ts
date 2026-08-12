import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The files somebody attached to THIS conversation and chose not to remember.
 *
 * ===========================================================================
 * WHY THIS IS A DIFFERENT BLOCK FROM `<context>`
 * ===========================================================================
 * Retrieval pastes Brain Knowledge fragments above the question inside a
 * `<context>` block, and the model is taught to cite them: a fragment is a
 * thing that lives in the brain, has a document behind it, and can be reopened
 * later by anybody who is allowed to see it.
 *
 * A 'turn' attachment is none of that. It was never indexed, it belongs to no
 * space, nobody else can reach it, and it stops existing in a week. Handing it
 * to the model inside the same block would make it look like knowledge, and the
 * model would cite it the way it cites everything else in there — producing an
 * answer that points at a document that does not exist and that the reader
 * cannot open. That is worse than not using the file at all, because a citation
 * that cannot be followed is the one failure this product is built to prevent.
 *
 * So it gets its own block, its own name, and an explicit instruction about
 * what it is. The model may use it freely; it must attribute it to the file the
 * person just attached rather than to the company's memory.
 *
 * ===========================================================================
 * WHY IT IS CAPPED
 * ===========================================================================
 * A 24 000-character contract is already a lot of prompt; three of them plus
 * retrieval plus the transcript starts crowding out the conversation, and the
 * model quietly gets worse at the thing it was asked. Two attachments, and the
 * block says out loud when it truncated so the answer can too.
 */

/** How many attached files one turn will carry. */
const MAX_FILES = 2;

/** Per file. The route already clipped at 24 000 on the way in. */
const MAX_CHARS_EACH = 12_000;

export interface TurnAttachment {
  filename: string;
  text: string;
  truncated: boolean;
}

export async function loadTurnAttachments(
  db: SupabaseClient,
  conversationId: string,
): Promise<TurnAttachment[]> {
  try {
    const { data } = await db
      .from('chat_attachments')
      .select('filename, extracted_text')
      .eq('conversation_id', conversationId)
      .eq('disposition', 'turn')
      .order('created_at', { ascending: false })
      .limit(MAX_FILES);

    return (data ?? [])
      .map((row) => {
        const full = (row.extracted_text as string | null) ?? '';
        return {
          filename: row.filename as string,
          text: full.slice(0, MAX_CHARS_EACH),
          truncated: full.length > MAX_CHARS_EACH,
        };
      })
      .filter((a) => a.text.trim().length > 0)
      .reverse();
  } catch {
    // An attachment that cannot be loaded costs the answer some context. A turn
    // that fails because of it costs the answer entirely.
    return [];
  }
}

/** The block as it is pasted above the question, or '' when there is nothing. */
export function renderTurnAttachmentBlock(attachments: readonly TurnAttachment[]): string {
  if (attachments.length === 0) return '';

  const files = attachments
    .map(
      (a) =>
        `<archivo nombre="${a.filename.replace(/"/g, "'")}">\n${a.text}${
          a.truncated ? '\n[…el archivo sigue; sólo se leyó esta parte…]' : ''
        }\n</archivo>`,
    )
    .join('\n\n');

  return [
    '<adjuntos>',
    'La persona adjuntó estos archivos a ESTA conversación y decidió NO guardarlos en Brain Knowledge.',
    'Úsalos para responder. Al citarlos di que vienen del archivo que acaba de adjuntar, con su nombre —',
    'no los presentes como algo que estuviera en la memoria de la empresa, porque no lo están: nadie más',
    'los puede abrir y se borran solos. Si la respuesta depende de una parte que quedó sin leer, dilo.',
    '',
    files,
    '</adjuntos>',
  ].join('\n');
}
