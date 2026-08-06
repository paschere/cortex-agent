'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  assertCanWriteToSpace,
  assessCoverage,
  assessFreshness,
  chunkOffsetMs,
  findConflicts,
  formatOffset,
  getVisibleDocument,
  getVisibleSpace,
  rateHit,
  searchSpaces,
} from '@cortex/agent-tools';
import { ForbiddenError, NotFoundError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import type {
  ActionResult,
  Fragment,
  FragmentPage,
  IntakeKey,
  ProbeConflict,
  ProbeFragment,
  ProbeResult,
  SimpleActionResult,
  SpaceKind,
  SpineBucket,
} from './_components/types';
import { TINY_FRAGMENT_TOKENS } from './_components/types';
import { intakeOf } from './_lib/brain';

const PATH = '/kb';

/**
 * Turns anything thrown by the boundary into a sentence a recruiter can act on.
 * NotFoundError covers both "gone" and "not yours" on purpose — the two must
 * stay indistinguishable, or the error message becomes a way to confirm that
 * someone else's private space exists.
 */
function describe(err: unknown, fallback: string): string {
  if (err instanceof NotFoundError) return 'Eso ya no está en Brain Knowledge.';
  if (err instanceof ForbiddenError) return err.message;
  const message = err instanceof Error ? err.message : '';
  if (/duplicate key|unique/i.test(message)) {
    return 'Ya tienes un espacio con ese nombre.';
  }
  return message && message.length < 160 ? message : fallback;
}

export async function createSpace(
  name: string,
  description: string,
  kind: SpaceKind,
): Promise<SimpleActionResult> {
  const user = await requireSession();
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'Ponle un nombre primero.' };
  if (trimmed.length > 200) return { ok: false, error: 'Ese nombre es muy largo.' };

  // The same gate the admin section uses: role on the session row, nothing else.
  if (kind === 'global' && user.role !== 'org_admin') {
    return {
      ok: false,
      error: 'Solo un administrador puede crear un espacio común.',
    };
  }

  const db = getOrgScopedClient(user.organization.id);
  const { error } = await db.from('kb_collections').insert({
    scope: kind === 'global' ? 'global' : 'user',
    scope_id: kind === 'global' ? null : user.id,
    name: trimmed,
    description: description.trim() || null,
    created_by: user.id,
  });

  if (error) return { ok: false, error: describe(error, 'No se pudo crear el espacio.') };

  revalidatePath(PATH);
  return { ok: true };
}

export async function deleteSpace(spaceId: string): Promise<SimpleActionResult> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  try {
    await assertCanWriteToSpace(db, user.id, spaceId);
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo borrar el espacio.') };
  }

  // Documents and their indexed text go with it — kb_documents and kb_chunks
  // both cascade off the space. The dialog says so before it gets here.
  const { error } = await db.from('kb_collections').delete().eq('id', spaceId);
  if (error) return { ok: false, error: describe(error, 'No se pudo borrar el espacio.') };

  revalidatePath(PATH);
  return { ok: true };
}

export async function moveDocument(
  documentId: string,
  targetSpaceId: string,
): Promise<ActionResult<{ space: string }>> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  try {
    // Both ends are checked. Being able to see a document does not mean being
    // able to take it out of a shared space, and being able to write to a space
    // does not mean being able to pull other people's documents into it.
    const doc = await getVisibleDocument(db, user.id, documentId);
    await assertCanWriteToSpace(db, user.id, doc.space.id);
    const target = await assertCanWriteToSpace(db, user.id, targetSpaceId);

    if (doc.space.id === target.id) return { ok: true, space: target.name };

    const { error } = await db
      .from('kb_documents')
      .update({ collection_id: target.id })
      .eq('id', documentId);
    if (error) throw error;

    revalidatePath(PATH);
    return { ok: true, space: target.name };
  } catch (err) {
    return { ok: false, error: describe(err, 'El documento se quedó donde estaba.') };
  }
}

export async function deleteDocument(documentId: string): Promise<SimpleActionResult> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  try {
    const doc = await getVisibleDocument(db, user.id, documentId);
    if (doc.uploadedBy !== user.id) {
      await assertCanWriteToSpace(db, user.id, doc.space.id);
    }
    const { error } = await db.from('kb_documents').delete().eq('id', documentId);
    if (error) throw error;
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo quitar el documento.') };
  }

  revalidatePath(PATH);
  return { ok: true };
}

/* ------------------------------------------------------------- the bench */

/**
 * How many fragments Cortex is handed for one question.
 *
 * The default on `kb.search`. It is a constant here and not a setting because
 * the bench's whole claim is "this is what actually happens" — a bench with its
 * own window would be a simulation of a different system, and the first time
 * the two disagreed nobody would trust either.
 */
const CORTEX_WINDOW = 5;

/**
 * And how many the bench asks for, so it can show what fell outside that
 * window. Everything past the fifth row is material Cortex never sees; being
 * able to point at it is how "why didn't it know that?" gets answered.
 */
const PROBE_DEPTH = 12;

/** Whoever is speaking in a fragment, when the fragment came from speech. */
function speakerOf(metadata: Record<string, unknown>): string | null {
  const value = metadata.speaker;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Run the real retrieval and show its working, without spending an answer.
 *
 * THE POINT OF THIS. When somebody says "the bot got it wrong", there has never
 * been a way to find out whether retrieval brought back the wrong material or
 * the model misread the right material. This settles it in one screen: the same
 * `searchSpaces` the agent calls, the same relevance cuts, the same conflict
 * check — with every score on show and nothing hidden, including the fragments
 * that were retrieved and then thrown away for being below the floor. Those are
 * usually the answer: the passage was there, it was cut in half, and half of it
 * scored 0.43.
 *
 * It deliberately does NOT count as a retrieval (see `recordRetrieval`), and it
 * deliberately does not call the model. Nothing is generated here. Everything
 * on screen is a row and a number.
 */
export async function probeMemory(
  query: string,
  spaceId?: string,
): Promise<ActionResult<{ probe: ProbeResult }>> {
  const user = await requireSession();
  const trimmed = query.trim();
  if (!trimmed) {
    return { ok: false, error: 'Escribe una pregunta como se la harías a Cortex.' };
  }

  const db = getOrgScopedClient(user.organization.id);
  const started = Date.now();

  try {
    if (spaceId) await getVisibleSpace(db, user.id, spaceId);

    let degraded: string | null = null;
    const hits = await searchSpaces(db, {
      userId: user.id,
      query: trimmed,
      ...(spaceId ? { spaceIds: [spaceId] } : {}),
      limit: PROBE_DEPTH,
      onDegraded: (reason) => {
        degraded = reason;
      },
    });

    // The same verdict the model is handed, produced by the same function. The
    // bench prints it verbatim rather than paraphrasing: what Cortex is told
    // about its own results is itself a thing worth being able to read.
    const verdict = assessCoverage(hits, {
      query: trimmed,
      degraded: Boolean(degraded),
      // Which model's scale these cosines are on. The thresholds differ per
      // embedding model, and judging a score against another model's cuts is
      // the bug this bench exists to make visible — see relevance.ts.
      embeddingModel: hits.find((h) => h.embeddingModel)?.embeddingModel ?? null,
    });
    const scale = verdict.calibration;

    const ids = [...new Set(hits.map((h) => h.documentId))];
    const sourceOf = new Map<string, IntakeKey>();
    if (ids.length > 0) {
      const { data: rows } = await db
        .from('kb_documents')
        .select('id, source, media_kind')
        .in('id', ids);
      for (const row of rows ?? []) {
        sourceOf.set(
          row.id as string,
          intakeOf({ source: row.source as string, media_kind: row.media_kind as string | null }),
        );
      }
    }

    const now = new Date();
    const fragments: ProbeFragment[] = hits.map((h, rank) => {
      const freshness = assessFreshness({
        datedAt: h.datedAt,
        validUntil: h.validUntil,
        supersededByTitle: h.supersededByTitle,
        now,
      });
      const offsetMs = chunkOffsetMs(h.metadata);
      return {
        chunkId: h.chunkId,
        documentId: h.documentId,
        documentTitle: h.documentTitle,
        spaceId: h.spaceId,
        spaceName: h.spaceName,
        spaceKind: h.spaceKind,
        source: sourceOf.get(h.documentId) ?? 'upload',
        chunkIndex: h.chunkIndex,
        content: h.content,
        cosine: h.semanticScore,
        keyword: h.keywordScore,
        blended: h.score,
        verdict: rateHit(h, scale) ?? 'dropped',
        age: freshness.label || null,
        freshness: freshness.status,
        spokenAt: offsetMs === null ? null : formatOffset(offsetMs),
        speaker: speakerOf(h.metadata),
        inWindow: rank < CORTEX_WINDOW,
      };
    });

    // Same rule the tool follows: only what is worth defending gets a second
    // opinion, and only from what would really have reached the model.
    const strong = hits
      .filter((h, rank) => rank < CORTEX_WINDOW && rateHit(h, scale) === 'strong')
      .map((h) => ({
        chunkId: h.chunkId,
        documentId: h.documentId,
        documentTitle: h.documentTitle,
        chunkIndex: h.chunkIndex,
        datedAt: h.datedAt,
        content: h.content,
      }));

    const conflicts: ProbeConflict[] =
      strong.length === 0
        ? []
        : (await findConflicts(db, { userId: user.id, hits: strong, now })).map((c) => ({
            note: c.note,
            documentTitle: c.hit.documentTitle,
            otherDocumentTitle: c.rival.documentTitle,
            otherSpace: c.rival.spaceName,
            otherContent: c.rival.content,
            moreRecent: c.newer === 'hit' ? ('this' as const) : ('other' as const),
            similarity: c.similarity,
          }));

    return {
      ok: true,
      probe: {
        query: trimmed,
        coverage: verdict.coverage,
        summary: verdict.summary,
        fragments,
        window: CORTEX_WINDOW,
        conflicts,
        degraded,
        elapsedMs: Date.now() - started,
        scale: {
          modelId: scale.modelId,
          strongMatch: scale.strongMatch,
          weakFloor: scale.weakFloor,
          railCeiling: scale.railCeiling,
          measured: scale.measured,
          measuredOn: scale.measuredOn,
          note: scale.note,
        },
      },
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'La prueba no corrió. Inténtalo en un momento.') };
  }
}

/* ----------------------------------------------------------- the fragments */

/** Fragments per request. One screenful and a bit, so scrolling never waits. */
const PAGE = 30;

/**
 * The ribbon is a few hundred pixels wide, so this is how many fragments it can
 * measure exactly before it starts summarising. Past it the ribbon still draws
 * the whole document, from a sample, and says so.
 */
const SPINE_CAP = 4000;
const SPINE_BUCKETS = 180;

/** The written text stops, but the sentence does not. See migration 0073 § 3. */
const ENDS_CLEANLY = /[.!?…:;")»][")\]»]*\s*$/;

function toFragment(
  row: {
    id: string;
    chunk_index: number;
    content: string;
    tokens: number;
    retrieval_count: number | null;
    last_retrieved_at: string | null;
    metadata: Record<string, unknown> | null;
  },
  lastIndex: number,
): Fragment {
  const meta = row.metadata ?? {};
  const startMs = typeof meta.startMs === 'number' ? meta.startMs : null;
  const pages = typeof meta.pages === 'number' ? meta.pages : null;
  return {
    chunkId: row.id,
    chunkIndex: row.chunk_index,
    content: row.content,
    tokens: row.tokens,
    retrievalCount: row.retrieval_count ?? 0,
    lastRetrievedAt: row.last_retrieved_at,
    speaker: speakerOf(meta),
    startMs,
    endMs: typeof meta.endMs === 'number' ? meta.endMs : null,
    pages,
    // Speech is exempt for the reason 0073 gives at length: a speech turn ends
    // where somebody stopped talking and transcription does not punctuate, so
    // the written-text rule would flag the entire audio corpus.
    // Same three exemptions the analysis applies, in the same order: speech is
    // exempt (a turn ends where the speaker stopped), importer-written headers
    // are exempt, and a scrap is a scrap rather than a truncated sentence.
    cutOff:
      startMs === null &&
      !('kind' in meta) &&
      row.tokens >= TINY_FRAGMENT_TOKENS &&
      row.chunk_index < lastIndex &&
      !ENDS_CLEANLY.test(row.content),
  };
}

/**
 * A window of a document's real fragments, plus the whole document at ribbon
 * resolution.
 *
 * WHY IT IS PAGED. A serious space holds tens of thousands of fragments and a
 * single transcript can hold a couple of thousand. Sending them all so the
 * browser can decide what to show is how a page that looks fine on a test
 * corpus locks up on a real one. Thirty rows go over the wire; the ribbon that
 * lets somebody jump anywhere in the document costs three integers per bucket
 * and is computed here, once, rather than from fragment bodies in the browser.
 */
export async function readFragments(
  documentId: string,
  from = 0,
  count = PAGE,
): Promise<ActionResult<{ page: FragmentPage }>> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  try {
    // Being handed a document id is not permission to read it. Without this,
    // one guessed uuid is the full text of somebody else's private notes.
    const doc = await getVisibleDocument(db, user.id, documentId);

    const start = Math.max(0, Math.floor(from));
    const size = Math.max(1, Math.min(100, Math.floor(count)));

    const { count: total } = await db
      .from('kb_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('document_id', documentId);
    const totalCount = total ?? 0;

    const { data, error } = await db
      .from('kb_chunks')
      .select('id, chunk_index, content, tokens, metadata, retrieval_count, last_retrieved_at')
      .eq('document_id', documentId)
      .order('chunk_index', { ascending: true })
      .range(start, start + size - 1);
    if (error) throw error;

    const lastIndex = Math.max(0, totalCount - 1);
    const fragments = (data ?? []).map((row) =>
      toFragment(row as Parameters<typeof toFragment>[0], lastIndex),
    );

    return {
      ok: true,
      page: {
        documentId,
        documentTitle: doc.title,
        spaceId: doc.space.id,
        spaceName: doc.space.name,
        total: totalCount,
        from: start,
        fragments,
        spine: await readSpine(db, documentId, totalCount),
        spineSampled: totalCount > SPINE_CAP,
      },
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron leer los fragmentos.') };
  }
}

/**
 * The whole document as a few hundred buckets: how substantial its fragments
 * are along its length, and which stretches have never been used.
 *
 * Reads only three small columns — never `content`, and never `embedding`,
 * which is four kilobytes a row and would turn this into megabytes of transfer
 * for a picture two hundred pixels wide.
 */
async function readSpine(
  db: ReturnType<typeof getOrgScopedClient>,
  documentId: string,
  total: number,
): Promise<SpineBucket[]> {
  if (total === 0) return [];
  const { data } = await db
    .from('kb_chunks')
    .select('chunk_index, tokens, retrieval_count')
    .eq('document_id', documentId)
    .order('chunk_index', { ascending: true })
    .range(0, SPINE_CAP - 1);

  const rows = (data ?? []) as Array<{
    chunk_index: number;
    tokens: number;
    retrieval_count: number | null;
  }>;
  if (rows.length === 0) return [];

  const buckets = Math.min(SPINE_BUCKETS, rows.length);
  const per = rows.length / buckets;
  const out: SpineBucket[] = [];
  for (let b = 0; b < buckets; b += 1) {
    const slice = rows.slice(
      Math.floor(b * per),
      Math.max(Math.floor((b + 1) * per), Math.floor(b * per) + 1),
    );
    if (slice.length === 0) continue;
    let tokens = 0;
    let never = 0;
    let retrievals = 0;
    for (const row of slice) {
      tokens += row.tokens;
      const used = row.retrieval_count ?? 0;
      retrievals += used;
      if (used === 0) never += 1;
    }
    out.push({
      from: slice[0]?.chunk_index ?? 0,
      to: slice[slice.length - 1]?.chunk_index ?? 0,
      tokens: Math.round(tokens / slice.length),
      never,
      retrievals,
    });
  }
  return out;
}
