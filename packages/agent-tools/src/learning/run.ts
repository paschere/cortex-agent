/**
 * One pass of the loop: read what happened, decide, apply, propose.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MATERIAL COMES OUT OF `turn_contexts` AND NOT OFF THE CHAT PATH
 * ---------------------------------------------------------------------------
 * Everything needed to notice a bad answer is already written down at the
 * moment of the turn (migration 0080): which fragments were pasted above the
 * question, which ones missed the cut, what retrieval concluded, who asked and
 * when. Deriving from that record rather than from the live chat route buys
 * three things at once. Nothing is added to the path of an answer — not a
 * millisecond, not a write, not a failure mode. The derivation can be re-run,
 * changed and tested against real history instead of only against turns that
 * happen next. And the rules are ordinary pure functions over rows, which is
 * the only way any of this is reviewable.
 *
 * The window is re-read with generous overlap on purpose: a turn that lands
 * near a boundary must not fall between two nights. Re-counting it is prevented
 * in the database, by the unique dedupe key, and not by arithmetic here — two
 * passes running at once would defeat any `if (!exists)`.
 *
 * ---------------------------------------------------------------------------
 * ONE WORKSPACE, ONE HANDLE
 * ---------------------------------------------------------------------------
 * `db` is workspace-scoped, and this function never takes a list of workspaces.
 * A pass that could see two companies at once is the shape of the bug this
 * whole module is most exposed to — learning from one company's usage and
 * answering another with it — so the shape is refused at the door. The cron
 * that fans out one event per workspace is in the web app; each event gets its
 * own scoped handle.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type TurnRecord,
  decideAdjustments,
  deriveBadCutProposals,
  deriveGapProposals,
  deriveTurnSignals,
  summarizeEvidence,
} from './derive';
import {
  applyAdjustment,
  expireAdjustments,
  listAdjustments,
  listSignalsSince,
  purgeSignals,
  raiseProposals,
  recordSignals,
} from './store';
import type { LearningProposalInput, LearningSignalInput } from './types';

const DAY_MS = 86_400_000;

/**
 * How far back each pass re-reads captured turns.
 *
 * Fourteen days rather than one, and it is not only about overlap: after
 * fourteen days `turn_contexts` strips its quoted material (0080 § 3), and this
 * derivation reads only the numbers — which fragment, prepended or not, what
 * retrieval concluded — plus the query, which is stripped along with the rest.
 * Reading inside the detail window is therefore reading the richest version of
 * the record, and reading past it would silently start comparing empty strings.
 */
export const TURN_WINDOW_DAYS = 13;

/** How far back corrections are swept up. Longer: they are rarer and heavier. */
export const CORRECTION_WINDOW_DAYS = 60;

export interface LearningPassResult {
  turnsRead: number;
  signalsRecorded: number;
  adjustmentsApplied: number;
  adjustmentsExpired: number;
  proposalsRaised: number;
}

interface TurnContextRow {
  id: string;
  conversation_id: string;
  user_id: string;
  created_at: string;
  retrieval: {
    ran?: boolean;
    query?: string;
    coverage?: string;
    fragments?: Array<{
      documentId?: string;
      chunkIndex?: number;
      prepended?: boolean;
      verdict?: string;
    }>;
  } | null;
}

const COVERAGES = new Set(['answered', 'thin', 'nothing', 'keyword-only']);

function toTurn(row: TurnContextRow): TurnRecord {
  const retrieval = row.retrieval ?? {};
  const coverage = COVERAGES.has(String(retrieval.coverage))
    ? (retrieval.coverage as TurnRecord['coverage'])
    : 'nothing';
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    createdAt: row.created_at,
    ran: retrieval.ran === true,
    coverage,
    query: retrieval.query ?? '',
    fragments: (retrieval.fragments ?? [])
      .filter(
        (f): f is { documentId: string; chunkIndex: number } & typeof f =>
          typeof f.documentId === 'string' && typeof f.chunkIndex === 'number',
      )
      .map((f) => ({
        documentId: f.documentId,
        chunkIndex: f.chunkIndex,
        prepended: f.prepended === true,
        verdict:
          f.verdict === 'strong' || f.verdict === 'weak'
            ? (f.verdict as 'strong' | 'weak')
            : ('dropped' as const),
      })),
  };
}

async function readTurns(db: SupabaseClient, since: string): Promise<TurnRecord[]> {
  const { data, error } = await db
    .from('turn_contexts')
    .select('id, conversation_id, user_id, created_at, retrieval')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(5000);
  if (error) throw error;
  return ((data ?? []) as unknown as TurnContextRow[]).map(toTurn);
}

interface CorrectionRow {
  id: string;
  extraction_id: string | null;
  doc_type: string | null;
  field_key: string;
  proposed_display: string | null;
  corrected_display: string | null;
  outcome: 'corrected' | 'rejected';
  corrected_by: string | null;
  corrected_at: string;
}

/**
 * The gold seam: fields a human read and fixed (migration 0076).
 *
 * Two things come out of the same rows, and they land on opposite sides of the
 * line this module is built around.
 *
 *   A SIGNAL against the document, because somebody looked at the passage and
 *   said it does not mean what we read into it. That is evidence about how much
 *   this material can be trusted, it is reversible, and enough of it makes the
 *   document rank last among its equals. Safe to apply.
 *
 *   A PROPOSAL when the same field of the same document keeps being corrected
 *   to the same new value. That is not a ranking observation, it is "the
 *   document says the wrong thing" — a claim about the world, and acting on it
 *   would mean rewriting the corpus. Never applied, always shown.
 */
async function readCorrections(
  db: SupabaseClient,
  since: string,
): Promise<{ signals: LearningSignalInput[]; proposals: LearningProposalInput[] }> {
  const { data, error } = await db
    .from('document_field_corrections')
    .select(
      'id, extraction_id, doc_type, field_key, proposed_display, corrected_display, outcome, corrected_by, corrected_at',
    )
    .gte('corrected_at', since)
    .limit(2000);
  if (error) throw error;
  const rows = (data ?? []) as unknown as CorrectionRow[];
  if (rows.length === 0) return { signals: [], proposals: [] };

  // Resolve extraction → document with a second scoped read rather than an
  // embedded join: two indexed lookups are cheap, and a PostgREST join here
  // would be one more place where a filter could be lost.
  const extractionIds = [
    ...new Set(rows.map((r) => r.extraction_id).filter((v): v is string => !!v)),
  ];
  const documentOf = new Map<string, string>();
  if (extractionIds.length > 0) {
    const { data: extractions, error: exErr } = await db
      .from('document_extractions')
      .select('id, document_id')
      .in('id', extractionIds);
    if (exErr) throw exErr;
    for (const e of (extractions ?? []) as unknown as Array<{ id: string; document_id: string }>) {
      documentOf.set(e.id, e.document_id);
    }
  }

  const signals: LearningSignalInput[] = [];
  const votes = new Map<
    string,
    {
      documentId: string;
      fieldKey: string;
      docType: string | null;
      proposed: string | null;
      corrected: string;
      count: number;
      actors: Set<string>;
    }
  >();

  for (const row of rows) {
    const documentId = row.extraction_id ? documentOf.get(row.extraction_id) : undefined;
    if (!documentId) continue;
    signals.push({
      kind: 'field_corrected',
      polarity: -1,
      weight: 3,
      documentId,
      // Document level: "we read this wrong" is a statement about the paper, not
      // about where the chunker happened to cut it.
      chunkIndex: -1,
      actorUserId: row.corrected_by,
      detail: {
        kind: 'field_corrected',
        field: row.field_key,
        proposed: row.proposed_display,
        corrected: row.corrected_display,
        outcome: row.outcome,
        note:
          row.outcome === 'rejected'
            ? 'Alguien descartó por completo lo que Cortex leyó de este documento.'
            : 'Alguien corrigió a mano un dato que Cortex leyó de este documento.',
      },
      dedupeKey: `field_corrected:${row.id}`,
      observedAt: row.corrected_at,
    });

    if (row.outcome !== 'corrected' || !row.corrected_display) continue;
    const key = `${documentId}:${row.field_key}:${row.corrected_display}`;
    let vote = votes.get(key);
    if (!vote) {
      vote = {
        documentId,
        fieldKey: row.field_key,
        docType: row.doc_type,
        proposed: row.proposed_display,
        corrected: row.corrected_display,
        count: 0,
        actors: new Set(),
      };
      votes.set(key, vote);
    }
    vote.count += 1;
    if (row.corrected_by) vote.actors.add(row.corrected_by);
  }

  const proposals: LearningProposalInput[] = [];
  for (const vote of votes.values()) {
    if (vote.count < 2 || vote.actors.size < 2) continue;
    proposals.push({
      kind: 'contradicted_value',
      documentId: vote.documentId,
      chunkIndex: null,
      headline: `«${vote.fieldKey}» dice ${vote.proposed ?? '—'} y lo corrigen a ${vote.corrected}`,
      detail:
        `${vote.count} veces, entre ${vote.actors.size} personas, alguien cambió a mano este dato al mismo valor. ` +
        'Lo más probable es que el documento esté desactualizado o que diga algo distinto de lo que parece. ' +
        'Cortex no lo cambia solo: eso sería reescribir lo que la empresa da por cierto a partir de cómo se usa el producto, ' +
        'y un dato mal aprendido no se ve por ninguna parte hasta que ya está en veinte respuestas. Revísalo y corrige el documento si toca.',
      evidence: {
        field: vote.fieldKey,
        docType: vote.docType,
        proposed: vote.proposed,
        corrected: vote.corrected,
        times: vote.count,
        actors: vote.actors.size,
      },
      // The corrected value is in the key on purpose: dismissing "lo corrigen a
      // 3.450.000" must not silence a later "lo corrigen a 3.900.000", which is
      // a different finding about the same field.
      dedupeKey: `contradicted_value:${vote.documentId}:${vote.fieldKey}:${vote.corrected}`,
    });
  }

  return { signals, proposals };
}

/**
 * Run the loop once for one workspace.
 *
 * Order matters in one place only: expiry runs FIRST, so an adjustment whose
 * evidence has dried up is already gone before this pass decides whether the
 * current evidence justifies putting it back. Doing it the other way round
 * would let a stale verdict be refreshed by its own inertia.
 */
export async function runLearningPass(
  db: SupabaseClient,
  opts: { organizationId: string; now?: Date },
): Promise<LearningPassResult> {
  const now = opts.now ?? new Date();
  const org = opts.organizationId;

  const adjustmentsExpired = await expireAdjustments(db, org, now);

  const turns = await readTurns(
    db,
    new Date(now.getTime() - TURN_WINDOW_DAYS * DAY_MS).toISOString(),
  );
  const corrections = await readCorrections(
    db,
    new Date(now.getTime() - CORRECTION_WINDOW_DAYS * DAY_MS).toISOString(),
  );

  const fresh = [...deriveTurnSignals(turns, now), ...corrections.signals];
  const signalsRecorded = await recordSignals(db, org, fresh);

  // Read the evidence back out of the table rather than using what was just
  // derived. The window that gates an adjustment is ninety days and the window
  // this pass reads is thirteen — a verdict must be reached on everything known,
  // not only on what happened this fortnight.
  const window = new Date(now.getTime() - 90 * DAY_MS).toISOString();
  const known = await listSignalsSince(db, window);
  const decisions = decideAdjustments(summarizeEvidence(known, now));

  // What is already in force, so a verdict that has not changed is left alone.
  //
  // WITHOUT THIS THE HISTORY IS WORTHLESS. A pass that re-created every standing
  // adjustment nightly would produce a page of two hundred identical entries a
  // week, and — worse — every one of them would carry a fresh ninety-day
  // expiry. That is the inertia the expiry exists to prevent: an adjustment
  // would outlive its evidence indefinitely simply by being re-decided from a
  // window that still contains the same old rows. Leaving it untouched means it
  // reaches its original deadline, dies, and is only re-created if the evidence
  // for it is still there on that night.
  const active = await listAdjustments(db, { status: 'active' });
  const inForce = new Map(active.map((a) => [`${a.documentId}:${a.chunkIndex}`, a.kind]));

  let adjustmentsApplied = 0;
  for (const decision of decisions) {
    const current = inForce.get(`${decision.documentId}:${decision.chunkIndex}`);
    // Same verdict, already applied. Only a CHANGE of mind is written down.
    if (current === decision.kind) continue;
    await applyAdjustment(
      db,
      org,
      {
        kind: decision.kind,
        documentId: decision.documentId,
        chunkIndex: decision.chunkIndex,
        evidence: decision.evidence,
      },
      now,
    );
    adjustmentsApplied += 1;
  }

  const proposalsRaised = await raiseProposals(db, org, [
    ...deriveGapProposals(turns),
    ...deriveBadCutProposals(turns),
    ...corrections.proposals,
  ]);

  await purgeSignals(db, now);

  return {
    turnsRead: turns.length,
    signalsRecorded,
    adjustmentsApplied,
    adjustmentsExpired,
    proposalsRaised,
  };
}
