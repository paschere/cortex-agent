/**
 * Turning what happened into what to do about it — all of it pure.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SIGNALS ARE THESE ONES
 * ---------------------------------------------------------------------------
 * Nobody is asked to rate an answer. Rating widgets collect the opinions of the
 * two people in the company who enjoy clicking widgets, on the days they feel
 * like it, and they collect nothing at all about the ninety-eight per cent of
 * bad answers that get silently worked around. Every signal below is a
 * by-product of work somebody was doing anyway:
 *
 *   THEY ASKED AGAIN. The strongest available reading of "that did not answer
 *   me" is that the same person rephrased the same question within a couple of
 *   minutes. It costs nothing to detect, it cannot be gamed by accident, and
 *   the fragments that were pasted above the FIRST attempt are exactly the ones
 *   that failed.
 *
 *   THEY MOVED ON. The counterweight, and it is not decoration. A loop that can
 *   only ever demote drifts towards demoting everything, and the drift is
 *   invisible from inside — every individual step looks like evidence. So the
 *   next question being about something else entirely is recorded as evidence
 *   FOR what was just used.
 *
 *   THEY LEFT WHILE IT WAS FLOUNDERING. Weak on purpose. People also leave
 *   because they got what they wanted, so this only counts when retrieval
 *   itself already said the material was thin or absent.
 *
 *   THEY CORRECTED SOMETHING. The gold, and it is already being captured
 *   elsewhere: a due date read out of a document and then fixed by hand
 *   (`commitments`, 0069), a field the extractor got wrong (0076). Somebody
 *   sat down, read the passage, and told us it does not say what we thought.
 *   Nothing derived from behaviour is worth as much, which is why these weigh
 *   three and everything else weighs one or two.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GATES ARE WHERE THEY ARE
 * ---------------------------------------------------------------------------
 * The failure this module has to survive is not a hostile attacker — it is one
 * frustrated person on one bad afternoon quietly reshaping the assistant for
 * everybody else. So evidence has to come from more than one person, or else
 * from one person over more than one day, before anything moves. `MIN_ACTORS`
 * and the `SOLO_*` pair are that rule, and they are the reason a small
 * workspace with a single heavy user is not simply frozen out of learning.
 */

import type {
  AdjustmentEvidence,
  LearningProposalInput,
  LearningSignalInput,
  SignalKind,
} from './types';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Comparing two questions
// ---------------------------------------------------------------------------

/**
 * Words that carry no topic. Kept deliberately short: an aggressive stop list
 * turns two different questions into the same three nouns, and a false
 * "reformulated" is a demotion of material that was fine.
 */
const STOPWORDS = new Set([
  'a',
  'al',
  'algo',
  'ahora',
  'como',
  'con',
  'cual',
  'cuales',
  'cuando',
  'cuanto',
  'de',
  'del',
  'desde',
  'donde',
  'el',
  'ella',
  'ellos',
  'en',
  'entre',
  'era',
  'es',
  'esa',
  'ese',
  'eso',
  'esta',
  'este',
  'esto',
  'estos',
  'fue',
  'ha',
  'hay',
  'hace',
  'la',
  'las',
  'le',
  'les',
  'lo',
  'los',
  'me',
  'mi',
  'muy',
  'no',
  'nos',
  'o',
  'para',
  'pero',
  'por',
  'porque',
  'que',
  'se',
  'ser',
  'si',
  'sin',
  'sobre',
  'son',
  'su',
  'sus',
  'tal',
  'te',
  'tiene',
  'todo',
  'un',
  'una',
  'uno',
  'unos',
  'y',
  'ya',
  'yo',
  'the',
  'and',
  'for',
  'with',
  'what',
  'when',
  'which',
  'who',
  'how',
  'is',
  'are',
  'was',
  'of',
  'to',
  'in',
  'on',
  'it',
  'that',
  'this',
]);

/** Lowercase, unaccented, punctuation-free content words, deduplicated. */
export function topicWords(text: string): Set<string> {
  const normalized = text
    .normalize('NFD')
    // Combining diacritical marks. Written by codepoint rather than as literal
    // characters so the expression survives a copy-paste through anything that
    // normalises source files.
    // biome-ignore lint/suspicious/noMisleadingCharacterClass: stripping combining marks is the intent
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ');
  const out = new Set<string>();
  for (const word of normalized.split(/\s+/)) {
    if (word.length < 3) continue;
    if (STOPWORDS.has(word)) continue;
    out.add(word);
  }
  return out;
}

/**
 * How much two questions are about the same thing. 1 is the same subject, 0 is
 * nothing in common.
 *
 * Shared words over the SHORTER question's word count, not over the union.
 * Jaccard was the first thing tried and it is wrong for this job: rephrasing is
 * mostly people swapping one word and adding two, so "¿cuánto cobramos por
 * bodegaje en Cartagena?" against "la tarifa de bodegaje en Cartagena cuánto
 * es" scores 0,50 on Jaccard — below any threshold that also rejects genuinely
 * different questions — while being the textbook case this exists to catch. The
 * asymmetry is deliberate and correct here: a second question that is a subset
 * of the first is somebody narrowing down, which is exactly a second attempt.
 *
 * The over-triggering risk (a one-word follow-up scoring 1) is handled by
 * refusing to compare questions with fewer than `MIN_TOPIC_WORDS` content words
 * at all, rather than by picking a bigger number here.
 */
export function topicOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * A stable name for "this question, roughly". Used to group the times nobody
 * could be answered — the sorted content words, which makes word order and
 * politeness irrelevant while keeping two genuinely different questions apart.
 */
export function topicSignature(text: string): string {
  return [...topicWords(text)].sort().join(' ');
}

// ---------------------------------------------------------------------------
// The input: turns, as they were captured
// ---------------------------------------------------------------------------

/** One captured turn, reduced to what the derivation needs. */
export interface TurnRecord {
  id: string;
  conversationId: string;
  userId: string;
  createdAt: string;
  /** False when retrieval never ran; such a turn says nothing about a fragment. */
  ran: boolean;
  coverage: 'answered' | 'thin' | 'nothing' | 'keyword-only';
  query: string;
  fragments: Array<{
    documentId: string;
    chunkIndex: number;
    prepended: boolean;
    verdict: 'strong' | 'weak' | 'dropped';
  }>;
}

/**
 * Same question again, in other words. Two thirds of the shorter question's
 * content words in common — which "tarifa de bodegaje en Cartagena" and
 * "cuánto cobramos por bodegaje en Cartagena" clear, and "tarifa de bodegaje en
 * Cartagena" and "tarifa de transporte en Medellín" do not.
 */
const REFORMULATION_OVERLAP = 0.6;
/** A different subject entirely. Between the two is a follow-up: says nothing. */
const NEW_SUBJECT_OVERLAP = 0.2;
/** Beyond this the second question is a new session, not a second attempt. */
const REFORMULATION_WINDOW_MS = 8 * MINUTE_MS;
/** Below this a question has too few content words to compare honestly. */
const MIN_TOPIC_WORDS = 3;
/** A conversation younger than this may simply not have been finished yet. */
const ABANDON_SETTLE_MS = 12 * 60 * MINUTE_MS;

function detailFor(kind: SignalKind, extra: Record<string, unknown> = {}) {
  return { kind, ...extra };
}

/**
 * Read a window of captured turns and say what they imply about fragments.
 *
 * Idempotent by construction: every signal's dedupe key names the turn it came
 * from, so re-reading an overlapping window — which the nightly pass does on
 * purpose, so a turn near a boundary is never missed — produces the same rows
 * and the database drops the repeats.
 *
 * `turns` need not be sorted; this groups and orders them itself, because the
 * caller reading them out of Postgres should not have to know that the order
 * matters.
 */
export function deriveTurnSignals(turns: readonly TurnRecord[], now: Date): LearningSignalInput[] {
  const byConversation = new Map<string, TurnRecord[]>();
  for (const turn of turns) {
    const list = byConversation.get(turn.conversationId);
    if (list) list.push(turn);
    else byConversation.set(turn.conversationId, [turn]);
  }

  const signals: LearningSignalInput[] = [];

  for (const conversation of byConversation.values()) {
    conversation.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (let i = 0; i < conversation.length; i += 1) {
      const turn = conversation[i];
      if (!turn) continue;
      const prepended = turn.fragments.filter((f) => f.prepended);
      // A turn that prepended nothing cannot be evidence about a fragment. It
      // may still be evidence about a GAP — that is `deriveGapProposals`.
      if (!turn.ran || prepended.length === 0) continue;

      const next = conversation[i + 1];
      const words = topicWords(turn.query);

      if (next && words.size >= MIN_TOPIC_WORDS) {
        const gap = new Date(next.createdAt).getTime() - new Date(turn.createdAt).getTime();
        const nextWords = topicWords(next.query || '');
        const overlap = topicOverlap(words, nextWords);

        if (
          gap >= 0 &&
          gap <= REFORMULATION_WINDOW_MS &&
          nextWords.size >= MIN_TOPIC_WORDS &&
          overlap >= REFORMULATION_OVERLAP
        ) {
          for (const f of prepended) {
            signals.push({
              kind: 'reformulated',
              polarity: -1,
              weight: 2,
              documentId: f.documentId,
              chunkIndex: f.chunkIndex,
              actorUserId: turn.userId,
              conversationId: turn.conversationId,
              turnContextId: turn.id,
              detail: detailFor('reformulated', {
                asked: turn.query,
                askedAgain: next.query,
                overlap: Number(overlap.toFixed(2)),
                note: 'La misma pregunta, con otras palabras, un minuto después.',
              }),
              dedupeKey: `reformulated:${turn.id}:${f.documentId}:${f.chunkIndex}`,
              observedAt: next.createdAt,
            });
          }
          continue;
        }

        if (overlap <= NEW_SUBJECT_OVERLAP && nextWords.size >= MIN_TOPIC_WORDS) {
          for (const f of prepended) {
            signals.push({
              kind: 'moved_on',
              polarity: 1,
              weight: 1,
              documentId: f.documentId,
              chunkIndex: f.chunkIndex,
              actorUserId: turn.userId,
              conversationId: turn.conversationId,
              turnContextId: turn.id,
              detail: detailFor('moved_on', {
                asked: turn.query,
                note: 'Después de esta respuesta se pasó a otro tema.',
              }),
              dedupeKey: `moved_on:${turn.id}:${f.documentId}:${f.chunkIndex}`,
              observedAt: next.createdAt,
            });
          }
        }
        continue;
      }

      // Last turn of the conversation. Only counts against the material when
      // retrieval had already admitted it was struggling — leaving after a good
      // answer is what a good answer looks like.
      const isLast = !next;
      const settled = now.getTime() - new Date(turn.createdAt).getTime() >= ABANDON_SETTLE_MS;
      if (
        isLast &&
        settled &&
        conversation.length >= 2 &&
        (turn.coverage === 'thin' || turn.coverage === 'nothing')
      ) {
        for (const f of prepended) {
          signals.push({
            kind: 'abandoned',
            polarity: -1,
            weight: 1,
            documentId: f.documentId,
            chunkIndex: f.chunkIndex,
            actorUserId: turn.userId,
            conversationId: turn.conversationId,
            turnContextId: turn.id,
            detail: detailFor('abandoned', {
              asked: turn.query,
              coverage: turn.coverage,
              note: 'La conversación se acabó ahí, y la búsqueda ya había dicho que traía poco.',
            }),
            dedupeKey: `abandoned:${turn.id}:${f.documentId}:${f.chunkIndex}`,
            observedAt: turn.createdAt,
          });
        }
      }
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// From observations to a verdict
// ---------------------------------------------------------------------------

/** How far back evidence counts towards an adjustment. */
export const EVIDENCE_WINDOW_DAYS = 90;
/** Weight, signed, needed to move anything. */
export const MIN_NET = 4;
/** ...and it has to come from at least this many different people. */
export const MIN_ACTORS = 2;
/** Unless one person produced this much... */
export const SOLO_NET = 6;
/** ...spread over at least this many different days. */
export const SOLO_DAYS = 3;

export interface FragmentEvidence extends AdjustmentEvidence {
  documentId: string;
  chunkIndex: number;
}

interface Accumulator {
  documentId: string;
  chunkIndex: number;
  positive: number;
  negative: number;
  actors: Set<string>;
  days: Set<string>;
  byKind: Partial<Record<SignalKind, number>>;
  firstSeen: string;
  lastSeen: string;
}

/**
 * Add the evidence up, one bucket per fragment.
 *
 * A signal with no actor (the person left the company; the row's user was
 * nulled) still counts towards the weight but towards nobody's headcount. That
 * is the conservative reading: it cannot help clear the "more than one person"
 * gate, which is the gate that matters.
 */
export function summarizeEvidence(
  signals: readonly LearningSignalInput[],
  now: Date,
): FragmentEvidence[] {
  const cutoff = now.getTime() - EVIDENCE_WINDOW_DAYS * DAY_MS;
  const buckets = new Map<string, Accumulator>();

  for (const s of signals) {
    const at = new Date(s.observedAt).getTime();
    if (!Number.isFinite(at) || at < cutoff) continue;
    const key = `${s.documentId}:${s.chunkIndex}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        documentId: s.documentId,
        chunkIndex: s.chunkIndex,
        positive: 0,
        negative: 0,
        actors: new Set(),
        days: new Set(),
        byKind: {},
        firstSeen: s.observedAt,
        lastSeen: s.observedAt,
      };
      buckets.set(key, bucket);
    }
    if (s.polarity === 1) bucket.positive += s.weight;
    else bucket.negative += s.weight;
    if (s.actorUserId) bucket.actors.add(s.actorUserId);
    bucket.days.add(s.observedAt.slice(0, 10));
    bucket.byKind[s.kind] = (bucket.byKind[s.kind] ?? 0) + 1;
    if (s.observedAt < bucket.firstSeen) bucket.firstSeen = s.observedAt;
    if (s.observedAt > bucket.lastSeen) bucket.lastSeen = s.observedAt;
  }

  return [...buckets.values()].map((b) => ({
    documentId: b.documentId,
    chunkIndex: b.chunkIndex,
    net: b.positive - b.negative,
    positive: b.positive,
    negative: b.negative,
    actors: b.actors.size,
    days: b.days.size,
    byKind: b.byKind,
    firstSeen: b.firstSeen,
    lastSeen: b.lastSeen,
  }));
}

/**
 * Is this enough to act on?
 *
 * Two ways through, and the second exists because the first would otherwise
 * freeze learning entirely in a five-person company where one person asks most
 * of the questions. What neither way permits is one person, one sitting: the
 * solo path needs the same behaviour on three separate days.
 */
export function isDecisive(evidence: AdjustmentEvidence): boolean {
  const magnitude = Math.abs(evidence.net);
  if (magnitude >= MIN_NET && evidence.actors >= MIN_ACTORS) return true;
  return magnitude >= SOLO_NET && evidence.days >= SOLO_DAYS;
}

export interface AdjustmentDecision {
  kind: 'prefer_fragment' | 'demote_fragment' | 'stale_document';
  documentId: string;
  chunkIndex: number;
  evidence: AdjustmentEvidence;
}

/**
 * What to apply.
 *
 * Fragment-level evidence produces a fragment verdict. Document-level evidence
 * — which is where the corrections land, because "the extractor read this
 * wrong" is a statement about a document and not about a chunk boundary — can
 * only ever produce `stale_document`, and only in the negative direction. There
 * is no such thing as auto-promoting a whole document: a document nobody has
 * ever complained about is the normal case, not an achievement.
 */
export function decideAdjustments(evidence: readonly FragmentEvidence[]): AdjustmentDecision[] {
  const out: AdjustmentDecision[] = [];
  for (const e of evidence) {
    if (!isDecisive(e)) continue;
    const { documentId, chunkIndex, ...rest } = e;
    if (chunkIndex < 0) {
      if (e.net >= 0) continue;
      out.push({ kind: 'stale_document', documentId, chunkIndex: -1, evidence: rest });
      continue;
    }
    out.push({
      kind: e.net > 0 ? 'prefer_fragment' : 'demote_fragment',
      documentId,
      chunkIndex,
      evidence: rest,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The half that may never be applied
// ---------------------------------------------------------------------------

/** How many times a question has to go unanswered before it is worth raising. */
export const GAP_MIN_ASKS = 3;
/** ...and by how many different people. */
export const GAP_MIN_ACTORS = 2;
/** How often a fragment has to lose next to its own neighbour. */
export const CUT_MIN_TURNS = 3;

/**
 * Questions Brain Knowledge holds nothing about, asked over and over.
 *
 * There is no retrieval fix for this and no adjustment that could help: the
 * answer is not in the corpus in any order. Somebody has to write it down. So
 * this is a proposal — a to-do list with the evidence attached — and it is
 * arguably the most valuable thing the loop produces, because it is the only
 * output that tells a company what it has failed to write down.
 */
export function deriveGapProposals(turns: readonly TurnRecord[]): LearningProposalInput[] {
  const groups = new Map<string, { asks: number; actors: Set<string>; examples: string[] }>();
  for (const turn of turns) {
    if (!turn.ran || turn.coverage !== 'nothing') continue;
    const signature = topicSignature(turn.query);
    if (signature.split(' ').filter(Boolean).length < MIN_TOPIC_WORDS) continue;
    let group = groups.get(signature);
    if (!group) {
      group = { asks: 0, actors: new Set(), examples: [] };
      groups.set(signature, group);
    }
    group.asks += 1;
    group.actors.add(turn.userId);
    if (group.examples.length < 3 && !group.examples.includes(turn.query)) {
      group.examples.push(turn.query);
    }
  }

  const out: LearningProposalInput[] = [];
  for (const [signature, group] of groups) {
    if (group.asks < GAP_MIN_ASKS || group.actors.size < GAP_MIN_ACTORS) continue;
    out.push({
      kind: 'unanswered_question',
      documentId: null,
      chunkIndex: null,
      headline: `Nadie ha escrito la respuesta a: «${group.examples[0] ?? signature}»`,
      detail:
        `Esto se preguntó ${group.asks} veces, entre ${group.actors.size} personas, y Brain Knowledge no tiene nada guardado al respecto. ` +
        'Cortex contestó bien al decir que no sabe, pero eso se va a repetir hasta que alguien lo escriba. ' +
        (group.examples.length > 1
          ? `Otras formas en que lo preguntaron: ${group.examples
              .slice(1)
              .map((e) => `«${e}»`)
              .join(', ')}.`
          : ''),
      evidence: { asks: group.asks, actors: group.actors.size, examples: group.examples },
      dedupeKey: `unanswered_question:${signature}`,
    });
  }
  return out;
}

/**
 * Fragments that keep landing just under the floor while the chunk next door
 * gets used — a boundary drawn through the middle of the answer.
 *
 * NOT AUTO-APPLIED, and the reason is worth stating precisely: the ordering
 * adjustments in this module genuinely cannot help. A fragment below the
 * relevance floor stays below it — that is the guarantee `apply.ts` is built
 * on, and weakening it here to rescue a near-miss would hand learning the power
 * to put material in front of the model that the thresholds rejected. The only
 * real fix is to re-chunk and re-embed the document, which rewrites the index
 * and cannot be undone by flipping a column. So it gets said, with the numbers,
 * and a person decides.
 */
export function deriveBadCutProposals(turns: readonly TurnRecord[]): LearningProposalInput[] {
  const near = new Map<
    string,
    { documentId: string; chunkIndex: number; turns: number; neighbours: Set<number> }
  >();

  for (const turn of turns) {
    if (!turn.ran) continue;
    const prepended = new Set(
      turn.fragments.filter((f) => f.prepended).map((f) => `${f.documentId}:${f.chunkIndex}`),
    );
    if (prepended.size === 0) continue;
    for (const f of turn.fragments) {
      if (f.prepended) continue;
      const neighbours = [f.chunkIndex - 1, f.chunkIndex + 1].filter((i) =>
        prepended.has(`${f.documentId}:${i}`),
      );
      if (neighbours.length === 0) continue;
      const key = `${f.documentId}:${f.chunkIndex}`;
      let entry = near.get(key);
      if (!entry) {
        entry = {
          documentId: f.documentId,
          chunkIndex: f.chunkIndex,
          turns: 0,
          neighbours: new Set(),
        };
        near.set(key, entry);
      }
      entry.turns += 1;
      for (const n of neighbours) entry.neighbours.add(n);
    }
  }

  const out: LearningProposalInput[] = [];
  for (const entry of near.values()) {
    if (entry.turns < CUT_MIN_TURNS) continue;
    const neighbours = [...entry.neighbours].sort((a, b) => a - b);
    out.push({
      kind: 'badly_cut_fragment',
      documentId: entry.documentId,
      chunkIndex: entry.chunkIndex,
      headline: `El fragmento ${entry.chunkIndex} parece cortado por la mitad`,
      detail:
        `En ${entry.turns} búsquedas este fragmento se quedó por debajo del umbral mientras el de al lado ` +
        `(${neighbours.join(' y ')}) sí se usó para contestar. Eso suele querer decir que el corte partió la respuesta en dos. ` +
        'Cortex no lo arregla solo: subirlo a la fuerza sería pasar por encima del umbral de relevancia, y volver a cortar el documento ' +
        'reescribe el índice y no se puede deshacer con un clic. Si el documento sigue siendo importante, vuelve a subirlo para que se corte de nuevo.',
      evidence: { turns: entry.turns, neighbours },
      dedupeKey: `badly_cut_fragment:${entry.documentId}:${entry.chunkIndex}`,
    });
  }
  return out;
}
