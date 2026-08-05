import type { SupabaseClient } from '@supabase/supabase-js';
import { ingestMarkdown } from '../kb/ingest';
import { parseDocument } from '../kb/parsers';
import { transcribeAudio } from '../kb/transcribe';

/**
 * What happens to the things in a group that are not words.
 *
 * A WhatsApp group is not a text channel. On any given day it carries voice
 * notes, photographs of a loading bay, a supplier's PDF invoice, a screenshot
 * of a bank transfer and a location pin. Deciding what to do with each of them
 * is a real decision, not plumbing, so each one is written down here with its
 * reason.
 *
 * ── VOICE NOTES: transcribed, and the words become part of the conversation ──
 *
 * In a Colombian operation the voice note is not an accessory to the
 * conversation, it frequently IS the conversation — the warehouse lead does not
 * type, he records eleven seconds while walking. Dropping them would archive
 * the half of the group that writes and lose the half that talks.
 *
 * They go through DEEPGRAM, the same `transcribeAudio` the Brain Knowledge
 * audio path has used since 0058 — same key, same nova-3 model, same language
 * detection. No second provider, no second key, no second failure mode to learn.
 * The transcript is stored on the message row and appears in the document as
 * that person's turn, marked 🎤 so a reader knows it was spoken and transcribed
 * rather than typed. The AUDIO ITSELF IS NOT KEPT: the words are what can be
 * searched and cited, and the bytes are a recording of somebody's voice that
 * they sent to a group chat, not to us.
 *
 * A failed transcription is not a failed message. The turn becomes "[voice note
 * — not transcribed]" and the conversation around it is still archived intact.
 *
 * ── IMAGES AND VIDEO: the caption, never the bytes ──
 *
 * Brain Knowledge has no vision pipeline. `parseDocument` reads PDF, DOCX and
 * text; there is nothing that would turn a photograph into something
 * retrievable. Storing the image anyway would mean paying for storage and
 * holding other people's photographs in order to produce a document that says
 * nothing. So the image becomes a marker and its CAPTION is indexed — which is
 * the part that carries the meaning anyway, because a photo posted to a work
 * group almost always arrives with "esta es la guía del despacho de Acme".
 *
 * ── FILES: ingested as their own document ──
 *
 * A supplier's invoice shared in a group is exactly the thing that should end
 * up in the company's memory, and unlike a photograph it is already in a shape
 * Brain Knowledge can read. So a PDF, a Word file or a plain-text attachment is
 * parsed and ingested as a document in its own right, in the same space as the
 * group, titled so it is obvious where it came from — and the conversation gets
 * a line saying the file was saved, so the episode still reads correctly.
 *
 * Two documents rather than one because they answer different questions.
 * "¿Cuánto nos facturó Acme en marzo?" wants the invoice; "¿por qué le pedimos
 * la factura de nuevo?" wants the conversation. Folding the invoice's text into
 * the conversation document would make both worse.
 *
 * Anything else — spreadsheets we cannot parse, archives, executables — is a
 * marker and nothing more. We do not download bytes we have no plan for.
 */

/**
 * A WhatsApp voice note is a few seconds of Opus; anything past this is not a
 * voice note, it is an audio file somebody attached, and paying to transcribe
 * an hour of it because it landed in a group is not a decision this should make
 * on its own.
 */
export const MAX_VOICE_BYTES = 12 * 1024 * 1024;

/** A shared document past this is not worth pulling through a serverless function. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Exactly what `parseDocument` can read. Nothing is downloaded speculatively. */
export const INGESTIBLE_DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/csv',
]);

export function isIngestibleDocument(mime: string | null | undefined): boolean {
  if (!mime) return false;
  return INGESTIBLE_DOCUMENT_MIMES.has(mime.split(';')[0]?.trim().toLowerCase() ?? '');
}

export interface VoiceTranscriptionResult {
  text: string | null;
  /** One sentence, stored on the message row so an operator can see why. */
  error: string | null;
}

/**
 * Deepgram, on the bytes of one voice note.
 *
 * Bytes rather than a signed URL — the opposite of the Brain Knowledge audio
 * path, deliberately. A recording uploaded to Cortex is already in Storage, so
 * handing Deepgram a URL saves pulling megabytes through the worker. A WhatsApp
 * voice note is not in Storage and is not going to be: putting it there in
 * order to hand out a URL would mean persisting exactly the audio this module
 * has decided not to keep.
 *
 * Never throws — `transcribeAudio` is one of the two modules in this package
 * that treats a third party's bad day as an operating condition, and this
 * preserves that. A group is archived with or without its voice notes.
 */
export async function transcribeVoiceNote(
  bytes: Uint8Array,
  mime: string,
  opts: { signal?: AbortSignal } = {},
): Promise<VoiceTranscriptionResult> {
  if (bytes.byteLength === 0) return { text: null, error: 'The voice note arrived empty.' };
  if (bytes.byteLength > MAX_VOICE_BYTES) {
    return {
      text: null,
      error: `That audio is ${Math.round(bytes.byteLength / 1024 / 1024)} MB, past the ${Math.round(MAX_VOICE_BYTES / 1024 / 1024)} MB ceiling for a voice note, so it was not transcribed.`,
    };
  }

  const result = await transcribeAudio(
    { bytes, mime: mime || 'audio/ogg' },
    { ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  if (!result.ok) return { text: null, error: result.reason };

  const text = result.data.turns
    .map((t) => t.text.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  // Diarization is deliberately thrown away here. A voice note has one speaker
  // — the person who sent it — and WhatsApp already told us who that is, so
  // "Speaker 1:" prefixes would be noise contradicting a name we are sure of.
  return text ? { text, error: null } : { text: null, error: 'No speech was found in it.' };
}

export interface AttachmentIngestResult {
  documentId: string | null;
  /** Null when it worked, one sentence when it did not. */
  error: string | null;
}

/**
 * A file shared in a group becomes a Brain Knowledge document.
 *
 * Filed in the group's own space — the same space the conversation goes to, so
 * the decision about who may read this group's material was made once, when
 * somebody switched the group on, and this cannot quietly widen it.
 */
export async function ingestGroupAttachment(
  db: SupabaseClient,
  opts: {
    spaceId: string;
    uploadedBy: string;
    groupSubject: string;
    senderName: string;
    filename: string;
    mime: string;
    bytes: Uint8Array;
    sentAt: string;
  },
): Promise<AttachmentIngestResult> {
  if (opts.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return {
      documentId: null,
      error: `That file is larger than ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB, so it was left in WhatsApp.`,
    };
  }
  if (!isIngestibleDocument(opts.mime)) {
    return { documentId: null, error: null };
  }

  try {
    const parsed = await parseDocument(
      Buffer.from(opts.bytes),
      opts.mime.split(';')[0] ?? opts.mime,
    );
    const text = parsed.text.trim();
    if (!text) {
      return {
        documentId: null,
        error: 'That file had no readable text in it — it may be a scan rather than a document.',
      };
    }

    // The provenance is written INTO the text, not only onto the row. A hit on
    // page four of an invoice retrieves a chunk with no row attached to it, and
    // "where did this come from" is the first thing anybody asks about a number
    // that arrived through a group chat.
    const header = [
      `# ${opts.filename}`,
      `Shared by ${opts.senderName} in the WhatsApp group "${opts.groupSubject}" on ${opts.sentAt.slice(0, 10)}.`,
      '',
    ].join('\n');

    const { documentId } = await ingestMarkdown(db, {
      collectionId: opts.spaceId,
      title: `${opts.filename} — WhatsApp · ${opts.groupSubject}`,
      content: `${header}${text}`,
      uploadedBy: opts.uploadedBy,
    });
    return { documentId, error: null };
  } catch (err) {
    return { documentId: null, error: (err as Error).message.slice(0, 300) };
  }
}
