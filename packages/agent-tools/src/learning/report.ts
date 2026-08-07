/**
 * What the learning page is allowed to show, and to whom.
 *
 * ---------------------------------------------------------------------------
 * IF IT IS NOT VISIBLE IT IS NOT SAFE
 * ---------------------------------------------------------------------------
 * A loop that adjusts retrieval on its own is only defensible if somebody can
 * open a screen and read, in one sitting: what it changed, what evidence it
 * changed it on, what that changed in practice, and how to put it back. This
 * module assembles exactly that, and nothing that is not that.
 *
 * The effect figure is the part worth being careful about. It is not a claim
 * that the adjustment helped — this module measures nothing about answer
 * quality and should not pretend to. It is the plain count of what has been
 * observed about that fragment SINCE the adjustment went in, next to what was
 * observed before. If demoting a fragment was right, the complaints about it
 * stop, because it stops being quoted. If the number keeps climbing, the
 * adjustment is not working and the page says so without editorialising.
 *
 * ---------------------------------------------------------------------------
 * WHOSE KNOWLEDGE IS IT
 * ---------------------------------------------------------------------------
 * Same rule as the turn-context surface, and for the same reason: a fragment
 * can come out of somebody's personal space, which exactly one person is
 * allowed to read. A document title is a quotation from that space —
 * "Renegociación Coltrans — borrador" says plenty on its own — so a reader who
 * cannot see the space gets the numbers and not the name. The verdict, the
 * evidence and the undo button all still work, because none of them quote
 * anybody. This does NOT dissolve for an admin.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { listVisibleSpaces } from '../kb/spaces';
import { listAdjustments, listLearningProposals, listSignalsSince } from './store';
import type {
  AdjustmentKind,
  LearningAdjustment,
  LearningProposal,
  LearningSignalRow,
  ProposalKind,
  ProposalStatus,
  SignalKind,
} from './types';

const DAY_MS = 86_400_000;

/** How a document is named on screen, or refused. */
export interface DocumentLabel {
  documentId: string;
  /** Null when the reader may not see the space this document lives in. */
  title: string | null;
  spaceName: string | null;
  withheld: boolean;
}

/** One live adjustment, as a person reads it. */
export interface AdjustmentView extends LearningAdjustment {
  document: DocumentLabel;
  /** Signals about this fragment recorded BEFORE the adjustment was applied. */
  before: { positive: number; negative: number };
  /** ...and since. The honest measure of whether it is working. */
  since: { positive: number; negative: number };
  /** Days left before it dies on its own. Negative means it already should have. */
  daysLeft: number;
}

export interface ProposalView extends LearningProposal {
  document: DocumentLabel | null;
}

export interface SignalView extends LearningSignalRow {
  document: DocumentLabel;
}

export interface LearningReport {
  active: AdjustmentView[];
  past: AdjustmentView[];
  proposals: ProposalView[];
  decided: ProposalView[];
  recentSignals: SignalView[];
  /** Nothing has happened yet — the page says so rather than drawing empty boxes. */
  quiet: boolean;
}

interface DocumentRow {
  id: string;
  title: string;
  collection_id: string;
}

/**
 * Resolve document ids to names the viewer is allowed to read.
 *
 * One lookup for the whole page, and the visibility check is a single set
 * membership over the spaces this person can see — global spaces are in that
 * set too, so there is no "is it global, or is it mine" branch that could be
 * got wrong in one of the two places.
 */
async function labelDocuments(
  db: SupabaseClient,
  viewerId: string,
  documentIds: readonly string[],
): Promise<Map<string, DocumentLabel>> {
  const labels = new Map<string, DocumentLabel>();
  const ids = [...new Set(documentIds)];
  if (ids.length === 0) return labels;

  const [{ data, error }, spaces] = await Promise.all([
    db.from('kb_documents').select('id, title, collection_id').in('id', ids),
    listVisibleSpaces(db, viewerId),
  ]);
  if (error) throw error;

  const spaceById = new Map(spaces.map((s) => [s.id, s.name]));
  for (const row of (data ?? []) as unknown as DocumentRow[]) {
    const spaceName = spaceById.get(row.collection_id) ?? null;
    labels.set(row.id, {
      documentId: row.id,
      title: spaceName ? row.title : null,
      spaceName,
      withheld: !spaceName,
    });
  }

  // A document that has been deleted since. The adjustment is already dead by
  // cascade, but a past one can still be on screen, and "(el documento ya no
  // está)" is a better answer than an empty row.
  for (const id of ids) {
    if (!labels.has(id)) {
      labels.set(id, { documentId: id, title: null, spaceName: null, withheld: false });
    }
  }
  return labels;
}

function tally(signals: readonly LearningSignalRow[]) {
  let positive = 0;
  let negative = 0;
  for (const s of signals) {
    if (s.polarity === 1) positive += s.weight;
    else negative += s.weight;
  }
  return { positive, negative };
}

/**
 * Everything the learning page draws, in one round of reads.
 *
 * `viewerId` is not optional and is not the workspace: the workspace decides
 * which rows exist, the viewer decides which document names they may be shown
 * next to. Two different questions, and collapsing them is how a diagnostics
 * screen turns into a way to enumerate a colleague's private notes.
 */
export async function buildLearningReport(
  db: SupabaseClient,
  opts: { viewerId: string; now?: Date },
): Promise<LearningReport> {
  const now = opts.now ?? new Date();

  const [active, past, open, decided, signals] = await Promise.all([
    listAdjustments(db, { status: 'active', limit: 200 }),
    listAdjustments(db, { status: 'past', limit: 60 }),
    listLearningProposals(db, { status: 'open', limit: 60 }),
    listLearningProposals(db, { limit: 60 }),
    listSignalsSince(db, new Date(now.getTime() - 90 * DAY_MS).toISOString(), 3000),
  ]);

  const documentIds = [
    ...active.map((a) => a.documentId),
    ...past.map((a) => a.documentId),
    ...open.map((p) => p.documentId),
    ...decided.map((p) => p.documentId),
    ...signals.map((s) => s.documentId),
  ].filter((id): id is string => Boolean(id));

  const labels = await labelDocuments(db, opts.viewerId, documentIds);
  const unknownDocument: DocumentLabel = {
    documentId: '',
    title: null,
    spaceName: null,
    withheld: false,
  };

  const byFragment = new Map<string, LearningSignalRow[]>();
  for (const s of signals) {
    const key = `${s.documentId}:${s.chunkIndex}`;
    const list = byFragment.get(key);
    if (list) list.push(s);
    else byFragment.set(key, [s]);
  }

  const view = (a: LearningAdjustment): AdjustmentView => {
    const mine = byFragment.get(`${a.documentId}:${a.chunkIndex}`) ?? [];
    return {
      ...a,
      document: labels.get(a.documentId) ?? unknownDocument,
      before: tally(mine.filter((s) => s.observedAt < a.createdAt)),
      since: tally(mine.filter((s) => s.observedAt >= a.createdAt)),
      daysLeft: Math.round((new Date(a.expiresAt).getTime() - now.getTime()) / DAY_MS),
    };
  };

  const proposalView = (p: LearningProposal): ProposalView => ({
    ...p,
    document: p.documentId ? (labels.get(p.documentId) ?? null) : null,
  });

  return {
    active: active.map(view),
    past: past.map(view),
    proposals: open.map(proposalView),
    decided: decided.filter((p) => p.status !== 'open').map(proposalView),
    recentSignals: signals.slice(0, 40).map((s) => ({
      ...s,
      document: labels.get(s.documentId) ?? unknownDocument,
    })),
    quiet: active.length === 0 && open.length === 0 && signals.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Words, in one place
// ---------------------------------------------------------------------------
//
// On screen this product speaks Colombian Spanish, plainly. These live here
// rather than in the component so the same phrasing is used by anything else
// that ever has to explain an adjustment — and so a reviewer can read the
// entire vocabulary of the module in twenty lines and check that none of it
// overstates what actually happened.

export const ADJUSTMENT_LABELS: Readonly<Record<AdjustmentKind, string>> = {
  prefer_fragment: 'Se usa primero',
  demote_fragment: 'Se deja de último',
  stale_document: 'Documento en duda',
};

export const ADJUSTMENT_EXPLANATIONS: Readonly<Record<AdjustmentKind, string>> = {
  prefer_fragment:
    'Entre los fragmentos que ya pasaron el umbral de relevancia, este va primero. No lo hace más relevante ni lo mete donde no calificaba.',
  demote_fragment:
    'Entre los fragmentos que ya pasaron el umbral, este va de último y es el primero que se cae si no caben todos. Si es el único que sirve, se sigue usando.',
  stale_document:
    'Los fragmentos de este documento van de últimos entre sus iguales. No se borra, no se oculta y no se le cambia ni una palabra: solo deja de ser lo primero que se cita.',
};

export const SIGNAL_LABELS: Readonly<Record<SignalKind, string>> = {
  reformulated: 'Volvieron a preguntar lo mismo',
  abandoned: 'Se acabó la conversación ahí',
  moved_on: 'Siguieron con otro tema',
  fragment_copied: 'Copiaron el fragmento',
  extraction_corrected: 'Corrigieron a mano una fecha',
  extraction_rejected: 'Descartaron lo que se leyó',
  extraction_confirmed: 'Confirmaron lo que se leyó',
  field_corrected: 'Corrigieron a mano un dato',
};

export const PROPOSAL_LABELS: Readonly<Record<ProposalKind, string>> = {
  contradicted_value: 'El documento dice algo que la gente corrige',
  badly_cut_fragment: 'Un fragmento quedó mal cortado',
  unanswered_question: 'Falta escribir una respuesta',
};

export const PROPOSAL_STATUS_LABELS: Readonly<Record<ProposalStatus, string>> = {
  open: 'Sin revisar',
  accepted: 'Alguien se hizo cargo',
  dismissed: 'Se descartó',
};
