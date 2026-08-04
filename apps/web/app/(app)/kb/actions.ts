'use server';

import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  assertCanWriteToSpace,
  getVisibleDocument,
  getVisibleSpace,
  searchSpaces,
} from '@cortex/agent-tools';
import { ForbiddenError, NotFoundError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import type {
  ActionResult,
  SearchResult,
  SimpleActionResult,
  SpaceKind,
} from './_components/types';

const PATH = '/kb';

/**
 * Turns anything thrown by the boundary into a sentence a recruiter can act on.
 * NotFoundError covers both "gone" and "not yours" on purpose — the two must
 * stay indistinguishable, or the error message becomes a way to confirm that
 * someone else's private space exists.
 */
function describe(err: unknown, fallback: string): string {
  if (err instanceof NotFoundError) return 'That is no longer in Brain Knowledge.';
  if (err instanceof ForbiddenError) return err.message;
  const message = err instanceof Error ? err.message : '';
  if (/duplicate key|unique/i.test(message)) {
    return 'You already have a space with that name.';
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
  if (!trimmed) return { ok: false, error: 'Give the space a name first.' };
  if (trimmed.length > 200) return { ok: false, error: 'That name is too long.' };

  // The same gate the admin section uses: role on the session row, nothing else.
  if (kind === 'global' && user.role !== 'org_admin') {
    return {
      ok: false,
      error: 'Only an org admin can create a company-wide space.',
    };
  }

  const db = getSupabaseServiceClient();
  const { error } = await db.from('kb_collections').insert({
    scope: kind === 'global' ? 'global' : 'user',
    scope_id: kind === 'global' ? null : user.id,
    name: trimmed,
    description: description.trim() || null,
    created_by: user.id,
  });

  if (error) return { ok: false, error: describe(error, 'That space could not be created.') };

  revalidatePath(PATH);
  return { ok: true };
}

export async function deleteSpace(spaceId: string): Promise<SimpleActionResult> {
  const user = await requireSession();
  const db = getSupabaseServiceClient();

  try {
    await assertCanWriteToSpace(db, user.id, spaceId);
  } catch (err) {
    return { ok: false, error: describe(err, 'That space could not be deleted.') };
  }

  // Documents and their indexed text go with it — kb_documents and kb_chunks
  // both cascade off the space. The dialog says so before it gets here.
  const { error } = await db.from('kb_collections').delete().eq('id', spaceId);
  if (error) return { ok: false, error: describe(error, 'That space could not be deleted.') };

  revalidatePath(PATH);
  return { ok: true };
}

export async function moveDocument(
  documentId: string,
  targetSpaceId: string,
): Promise<ActionResult<{ space: string }>> {
  const user = await requireSession();
  const db = getSupabaseServiceClient();

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
    return { ok: false, error: describe(err, 'That document stayed where it was.') };
  }
}

export async function deleteDocument(documentId: string): Promise<SimpleActionResult> {
  const user = await requireSession();
  const db = getSupabaseServiceClient();

  try {
    const doc = await getVisibleDocument(db, user.id, documentId);
    if (doc.uploadedBy !== user.id) {
      await assertCanWriteToSpace(db, user.id, doc.space.id);
    }
    const { error } = await db.from('kb_documents').delete().eq('id', documentId);
    if (error) throw error;
  } catch (err) {
    return { ok: false, error: describe(err, 'That document could not be removed.') };
  }

  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Search from the page. Goes through exactly the same `searchSpaces` boundary
 * Cortex uses, so what a person can find here and what their own Cortex can
 * retrieve are the same set by construction, not by two rules kept in step.
 */
export async function searchKnowledge(
  query: string,
  spaceId?: string,
): Promise<ActionResult<{ results: SearchResult[] }>> {
  const user = await requireSession();
  if (!query.trim()) return { ok: true, results: [] };

  const db = getSupabaseServiceClient();
  try {
    if (spaceId) await getVisibleSpace(db, user.id, spaceId);
    const hits = await searchSpaces(db, {
      userId: user.id,
      query,
      ...(spaceId ? { spaceIds: [spaceId] } : {}),
      limit: 12,
    });
    return {
      ok: true,
      results: hits.map((h) => ({
        documentId: h.documentId,
        documentTitle: h.documentTitle,
        space: h.spaceName,
        spaceKind: h.spaceKind,
        chunkIndex: h.chunkIndex,
        content: h.content,
        score: h.score,
      })),
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'The search did not run. Try again in a moment.') };
  }
}
