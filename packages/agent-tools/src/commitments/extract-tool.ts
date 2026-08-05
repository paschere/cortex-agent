import { z } from 'zod';
import { registerTool } from '../index';
import { getVisibleDocument } from '../kb/spaces';
import { type DocumentChunk, proposeCommitments, verifyCandidates } from './extract';
import {
  COMMITMENT_KINDS,
  type CommitmentKind,
  bogotaToday,
  daysUntilDue,
  plural,
  whenPhrase,
} from './shape';
import { createCommitment } from './store';

/**
 * Read a document in Brain Knowledge and PROPOSE the dated commitments in it.
 *
 * Everything this writes lands as `review_state='pending'`: invisible to the
 * watcher, absent from `commitments.due_soon`, no mail, no calendar. It is a
 * queue of proposals, and the tool's own description says so, because a model
 * that believes it just registered a deadline will tell the user it did.
 *
 * VISIBILITY GOES THROUGH SPACES. `getVisibleDocument` decides whether this
 * person may read this document at all — a document id is handed out by every
 * search hit, and without that check it would be enough to pull the text of a
 * colleague's personal space out through this tool.
 *
 * The filter that discards most of what the model proposes lives in
 * `extract.ts`; read the header there for what it rejects and why.
 */

const KINDS = new Set<string>(COMMITMENT_KINDS);

export const commitmentsExtractFromDocument = registerTool({
  id: 'commitments.extract_from_document',
  description:
    'Read a document already in Brain Knowledge — a contract, a policy, a customs filing — and propose the dated commitments it contains, each with the exact sentence its date was read from. NOTHING here starts being watched: every proposal goes to the review queue and needs a person to confirm it (commitments.pending_review, then commitments.confirm_extracted). Proposals whose quoted sentence is not literally in the document, or whose date had to be calculated rather than read, are discarded automatically and reported as discarded. Requires confirmation.',
  inputSchema: z.object({
    documentId: z.string().uuid().describe('A document id from a Brain Knowledge search hit'),
    defaultKind: z
      .enum(COMMITMENT_KINDS)
      .optional()
      .describe('Fallback kind when the document does not make it obvious'),
  }),
  outputSchema: z.object({
    documentTitle: z.string(),
    proposed: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        kind: z.string(),
        dueOn: z.string(),
        daysLeft: z.number(),
        quote: z.string().describe('Verified to appear verbatim in the document'),
      }),
    ),
    discarded: z.array(z.object({ title: z.string(), dueOn: z.string(), reason: z.string() })),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  // A model call over a whole document. Slow and not something to loop on.
  rateLimit: { perMinute: 5 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    // Throws NotFoundError when the document belongs to a space this person
    // cannot see — which reads as "it does not exist", which is correct.
    const document = await getVisibleDocument(ctx.db, ctx.userId, input.documentId);

    const { data, error } = await ctx.db
      .from('kb_chunks')
      .select('id, chunk_index, content')
      .eq('document_id', input.documentId)
      .order('chunk_index', { ascending: true })
      .limit(200);
    if (error) throw error;
    const chunks = (data ?? []) as DocumentChunk[];

    if (chunks.length === 0) {
      return {
        documentTitle: document.title,
        proposed: [],
        discarded: [],
        guidance: `"${document.title}" todavía no tiene texto indexado, así que no hay nada que leer. Espera a que termine de procesarse.`,
      };
    }

    const candidates = await proposeCommitments(chunks);
    const { accepted, rejected } = verifyCandidates(candidates, chunks, today);

    const proposed: Array<{
      id: string;
      title: string;
      kind: string;
      dueOn: string;
      daysLeft: number;
      quote: string;
    }> = [];

    for (const c of accepted) {
      const kind: CommitmentKind = KINDS.has(c.kind)
        ? (c.kind as CommitmentKind)
        : (input.defaultKind ?? 'other');
      const row = await createCommitment(ctx.db, {
        title: c.title,
        detail: `Propuesto a partir de "${document.title}".`,
        kind,
        dueOn: c.dueOn,
        counterparty: c.counterparty ?? null,
        amountCop: c.amountCop ?? null,
        ownerUserId: ctx.userId,
        // A contract states one date. It does not state every future one, so
        // the successor of a document-sourced commitment goes back to review.
        recurrence: 'none',
        source: {
          kind: 'document',
          documentId: input.documentId,
          chunkId: c.chunkId,
          quote: c.quote,
        },
        createdBy: ctx.userId,
      });
      proposed.push({
        id: row.id,
        title: row.title,
        kind: row.kind,
        dueOn: row.due_on,
        daysLeft: daysUntilDue(row.due_on, today),
        quote: c.quote,
      });
    }

    const discarded = rejected.map((r) => ({
      title: r.candidate.title,
      dueOn: r.candidate.dueOn,
      reason: r.reason,
    }));

    return {
      documentTitle: document.title,
      proposed,
      discarded,
      guidance: report(document.title, proposed, discarded),
    };
  },
});

function report(
  documentTitle: string,
  proposed: Array<{ title: string; dueOn: string; daysLeft: number; quote: string }>,
  discarded: Array<{ title: string; dueOn: string; reason: string }>,
): string {
  const lines: string[] = [];
  if (proposed.length === 0) {
    lines.push(`No saqué ninguna fecha verificable de "${documentTitle}".`);
  } else {
    lines.push(
      `De "${documentTitle}" salieron ${plural(proposed.length, 'propuesta')}, todas PENDIENTES DE CONFIRMAR — no se están vigilando:`,
    );
    for (const p of proposed) {
      lines.push(`- ${p.title}: ${p.dueOn} (${whenPhrase(p.daysLeft)}) — «${p.quote}»`);
    }
  }
  if (discarded.length > 0) {
    lines.push(
      `Descarté ${plural(discarded.length, 'candidata')} porque no pasaron la verificación: ${discarded
        .map((d) => `${d.title} (${d.reason})`)
        .join('; ')}.`,
    );
  }
  lines.push(
    'Muéstrale a la persona la cita de cada una y pregúntale cuáles confirma. Hasta que alguien confirme, ninguna avisa nada.',
  );
  return lines.join('\n');
}
