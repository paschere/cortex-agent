'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  assertCanAdminSpace,
  assertCanWriteToSpace,
  assessCoverage,
  assessFreshness,
  chunkOffsetMs,
  findConflicts,
  formatOffset,
  getVisibleDocument,
  getVisibleSpace,
  grantSpaceAccess,
  listSpaceAccess,
  rateHit,
  removeFiles,
  revokeSpaceAccess,
  searchSpaces,
} from '@cortex/agent-tools';
import { ForbiddenError, NotFoundError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import type {
  AccessRow,
  ActionResult,
  Candidate,
  Fragment,
  FragmentPage,
  IntakeKey,
  ProbeConflict,
  ProbeFragment,
  ProbeResult,
  SimpleActionResult,
  SpaceKind,
  SpaceLevel,
  SpineBucket,
} from './_components/types';
import { TINY_FRAGMENT_TOKENS } from './_components/types';
import { intakeOf } from './_lib/brain';
import { KB_BUCKET, blobPathsOf, normalizeBatchIds } from './_lib/deletion';
import type { BatchDeleteResult, BatchRejection } from './_lib/deletion';

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

/**
 * Crear un espacio.
 *
 * `everyone` sólo tiene sentido en un espacio de la empresa, y es la decisión de
 * verdad: un espacio común nace abierto, uno repartido nace cerrado y se abre a
 * mano desde el panel de acceso. Nace cerrado y no al revés porque abrir es
 * reversible y publicar no — las respuestas que ya dio Cortex con ese material
 * no se pueden recoger.
 */
export async function createSpace(
  name: string,
  description: string,
  kind: SpaceKind,
  everyone = true,
): Promise<SimpleActionResult> {
  const user = await requireSession();
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'Ponle un nombre primero.' };
  if (trimmed.length > 200) return { ok: false, error: 'Ese nombre es muy largo.' };

  const orgOwned = kind !== 'personal';

  // The same gate the admin section uses: role on the session row, nothing else.
  if (orgOwned && user.role !== 'org_admin') {
    return {
      ok: false,
      error: 'Solo un administrador puede crear un espacio de la empresa.',
    };
  }

  const db = getOrgScopedClient(user.organization.id);
  const { data, error } = await db
    .from('kb_collections')
    .insert({
      scope: orgOwned ? 'global' : 'user',
      scope_id: orgOwned ? null : user.id,
      name: trimmed,
      description: description.trim() || null,
      created_by: user.id,
    })
    .select('id')
    .single();

  if (error || !data) return { ok: false, error: describe(error, 'No se pudo crear el espacio.') };

  // «Lo ve toda la empresa» es una concesión desde la 0123, no una propiedad del
  // scope, así que un espacio común hay que abrirlo explícitamente. Si esto
  // fallara, el espacio queda creado y cerrado — que es el lado prudente del
  // fallo — y se puede abrir desde el panel de acceso.
  if (orgOwned && everyone) {
    try {
      await grantSpaceAccess(
        db,
        user.id,
        (data as { id: string }).id,
        { kind: 'everyone' },
        'view',
      );
    } catch (err) {
      revalidatePath(PATH);
      return {
        ok: false,
        error: `Se creó «${trimmed}», pero no se pudo abrir a toda la empresa: ${describe(err, 'inténtalo desde «Quién lo ve».')}`,
      };
    }
  }

  revalidatePath(PATH);
  return { ok: true };
}

/**
 * ===========================================================================
 * QUIÉN LO VE
 * ===========================================================================
 * Las cuatro acciones del panel de acceso. Ninguna comprueba permisos por su
 * cuenta: las cuatro delegan en `kb/spaces.ts`, que a su vez delega en la base
 * de datos. Es la misma frontera que usa la búsqueda, y por eso no puede
 * conceder algo que la búsqueda no respete.
 */

export async function readSpaceAccess(
  spaceId: string,
): Promise<ActionResult<{ rows: AccessRow[] }>> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  try {
    const grants = await listSpaceAccess(db, user.id, spaceId);
    return {
      ok: true,
      rows: grants.map((g) => ({
        id: g.id,
        subjectKind: g.subjectKind,
        subjectId: g.subjectId,
        subjectName: g.subjectName,
        level: g.level,
      })),
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo leer quién ve este espacio.') };
  }
}

/**
 * A quién se le puede dar acceso: los equipos y la gente de este espacio de
 * trabajo. Va detrás del mismo permiso que el panel — la lista de personas de
 * una empresa no es pública dentro del producto sólo porque quepa en un menú.
 */
export async function accessCandidates(
  spaceId: string,
): Promise<ActionResult<{ candidates: Candidate[] }>> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  try {
    await assertCanAdminSpace(db, user.id, spaceId);
  } catch (err) {
    return { ok: false, error: describe(err, 'No puedes repartir este espacio.') };
  }

  const [teams, people] = await Promise.all([
    db.from('teams').select('id, name').order('name'),
    db.from('users').select('id, name, email').order('email'),
  ]);

  const candidates: Candidate[] = [
    ...((teams.data ?? []) as Array<{ id: string; name: string }>).map((t) => ({
      id: t.id,
      name: t.name,
      kind: 'team' as const,
    })),
    ...((people.data ?? []) as Array<{ id: string; name: string | null; email: string }>)
      // Uno mismo no: administrar ya implica ver, y ofrecerse a sí mismo en la
      // lista es la manera de que alguien crea que se quitó el acceso.
      .filter((p) => p.id !== user.id)
      .map((p) => ({
        id: p.id,
        name: p.name?.trim() || p.email,
        kind: 'user' as const,
        hint: p.email,
      })),
  ];
  return { ok: true, candidates };
}

export async function shareSpace(
  spaceId: string,
  subject: { kind: 'everyone' | 'team' | 'user'; id?: string | null },
  level: SpaceLevel,
): Promise<SimpleActionResult> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  try {
    await grantSpaceAccess(db, user.id, spaceId, subject, level);
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo dar el acceso.') };
  }
  revalidatePath(PATH);
  return { ok: true };
}

export async function unshareSpace(
  spaceId: string,
  subject: { kind: 'everyone' | 'team' | 'user'; id?: string | null },
): Promise<SimpleActionResult> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  try {
    await revokeSpaceAccess(db, user.id, spaceId, subject);
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo quitar el acceso.') };
  }
  revalidatePath(PATH);
  return { ok: true };
}

export async function deleteSpace(spaceId: string): Promise<SimpleActionResult> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  try {
    // Administrar, no aportar: desde la 0123 alguien puede tener permiso para
    // guardar documentos en un espacio sin tenerlo para borrarlo con todo lo
    // que hay dentro.
    await assertCanAdminSpace(db, user.id, spaceId);
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

/**
 * Borra un documento tras la misma regla que la acción pública: lo subió esta
 * persona, o puede escribir en el espacio donde vive. Devuelve las rutas de
 * 'kb-uploads' que la fila dejaba huérfanas, para que el caller las barra.
 *
 * La ruta del binario se lee ANTES de borrar la fila — después ya no hay
 * quién la recuerde.
 */
async function destroyDocument(
  db: ReturnType<typeof getOrgScopedClient>,
  userId: string,
  documentId: string,
): Promise<{ ok: true; blobPaths: string[] } | { ok: false; reason: string }> {
  try {
    const doc = await getVisibleDocument(db, userId, documentId);
    if (doc.uploadedBy !== userId) {
      await assertCanWriteToSpace(db, userId, doc.space.id);
    }
    const { data: row, error: readError } = await db
      .from('kb_documents')
      .select('source, source_ref, media_path')
      .eq('id', documentId)
      .maybeSingle();
    const { error } = await db.from('kb_documents').delete().eq('id', documentId);
    if (error) throw error;
    // Si la lectura de la ruta falló, lo único que se pierde es la limpieza
    // del blob — que ya es best-effort. La suerte del documento la decide el
    // delete de arriba, no esta lectura.
    return {
      ok: true,
      blobPaths: !readError && row ? blobPathsOf(row as Parameters<typeof blobPathsOf>[0]) : [],
    };
  } catch (err) {
    return { ok: false, reason: describe(err, 'No se pudo quitar el documento.') };
  }
}

/**
 * Limpieza best-effort de los binarios de documentos YA borrados. Si esto
 * falla, el borrado no se revierte y el caller no se entera: un blob huérfano
 * es basura inofensiva que una pasada posterior puede barrer; un documento
 * medio borrado es un estado mentiroso que alguien tendría que explicar.
 */
async function sweepBlobs(
  db: ReturnType<typeof getOrgScopedClient>,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  try {
    await removeFiles(db, KB_BUCKET, paths);
  } catch {
    // Documentado arriba: el huérfano se queda, el borrado ya contó.
  }
}

export async function deleteDocument(documentId: string): Promise<SimpleActionResult> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const result = await destroyDocument(db, user.id, documentId);
  if (!result.ok) return { ok: false, error: result.reason };

  await sweepBlobs(db, result.blobPaths);
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Borrado en lote, parcial y honesto: cada documento se juzga con la misma
 * regla que el borrado individual, los permitidos se borran y los demás
 * vuelven con su razón. Nunca todo-o-nada — que dos documentos ajenos colados
 * en la selección cancelen los ocho tuyos sería castigar al que sí podía.
 */
export async function deleteDocuments(
  documentIds: string[],
): Promise<BatchDeleteResult | { ok: false; error: string }> {
  const user = await requireSession();
  const batch = normalizeBatchIds(documentIds);
  if (!batch.ok) return batch;

  const db = getOrgScopedClient(user.organization.id);
  const rechazados: BatchRejection[] = [];
  const blobPaths: string[] = [];
  let borrados = 0;

  for (const id of batch.ids) {
    const result = await destroyDocument(db, user.id, id);
    if (result.ok) {
      borrados += 1;
      blobPaths.push(...result.blobPaths);
    } else {
      rechazados.push({ id, reason: result.reason });
    }
  }

  // Una sola barrida y una sola revalidación al final: cien revalidaciones de
  // la misma ruta no dicen nada que una no diga.
  await sweepBlobs(db, blobPaths);
  if (borrados > 0) revalidatePath(PATH);
  return { ok: true, borrados, rechazados };
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
        verdict: rateHit(h, scale, trimmed) ?? 'dropped',
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
      .filter((h, rank) => rank < CORTEX_WINDOW && rateHit(h, scale, trimmed) === 'strong')
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
