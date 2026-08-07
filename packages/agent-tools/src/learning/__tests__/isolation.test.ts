import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import {
  applyAdjustment,
  forgetAdjustmentCache,
  listAdjustments,
  listLearningProposals,
  listSignalsSince,
  loadActiveAdjustments,
  recordSignals,
  revokeAdjustment,
} from '../store';

/**
 * TWO COMPANIES, ONE DATABASE — and this is the module where getting it wrong
 * would be worst.
 *
 * Everywhere else in the product, a lost workspace filter leaks a row somebody
 * can see is not theirs. Here it would do something quieter and much worse: one
 * customer's usage would reshape the retrieval that answers another customer.
 * Nobody would see a foreign row. They would see their own documents coming
 * back in an order that was decided by a company they have never heard of.
 *
 * The fixture is adversarial in the way that matters: BOTH companies have
 * learned something about a document, and both documents happen to carry the
 * same id string. A query that lost its filter therefore returns something
 * PLAUSIBLE — an adjustment about a document that really exists on this side —
 * rather than something obviously foreign, which is exactly how this class of
 * bug survives a code review.
 *
 * The subject under test is the real store, through the real scoped client.
 */

const POSTAL = 'org-postal';
const ADUANAS = 'org-aduanas';

const ANA = 'user-ana'; // Postal
const CARLA = 'user-carla'; // Aduanas

// The same id on both sides, on purpose. See the header.
const SHARED_DOC = 'doc-tarifas';

const FUTURE = '2027-01-01T00:00:00Z';
const OBSERVED = '2026-08-01T10:00:00Z';

function world() {
  const fake = createFakeSupabase({
    learning_signals: [
      {
        id: 'sig-postal',
        organization_id: POSTAL,
        kind: 'reformulated',
        polarity: -1,
        weight: 2,
        document_id: SHARED_DOC,
        chunk_index: 3,
        actor_user_id: ANA,
        conversation_id: null,
        turn_context_id: null,
        detail: { note: 'Postal' },
        dedupe_key: 'reformulated:t1:doc-tarifas:3',
        observed_at: OBSERVED,
        created_at: OBSERVED,
        purge_at: FUTURE,
      },
      {
        id: 'sig-aduanas',
        organization_id: ADUANAS,
        kind: 'reformulated',
        polarity: -1,
        weight: 2,
        document_id: SHARED_DOC,
        chunk_index: 3,
        actor_user_id: CARLA,
        conversation_id: null,
        turn_context_id: null,
        detail: { note: 'Aduanas' },
        // The same dedupe key as Postal's. It is unique PER WORKSPACE
        // (migration 0083), and the two must not collide.
        dedupe_key: 'reformulated:t1:doc-tarifas:3',
        observed_at: OBSERVED,
        created_at: OBSERVED,
        purge_at: FUTURE,
      },
    ],
    learning_adjustments: [
      {
        id: 'adj-postal',
        organization_id: POSTAL,
        kind: 'demote_fragment',
        document_id: SHARED_DOC,
        chunk_index: 3,
        status: 'active',
        evidence: {},
        created_at: OBSERVED,
        expires_at: FUTURE,
        revoked_at: null,
        revoked_by: null,
        revoked_reason: null,
      },
      {
        id: 'adj-aduanas',
        organization_id: ADUANAS,
        kind: 'prefer_fragment',
        document_id: SHARED_DOC,
        chunk_index: 3,
        status: 'active',
        evidence: {},
        created_at: OBSERVED,
        expires_at: FUTURE,
        revoked_at: null,
        revoked_by: null,
        revoked_reason: null,
      },
    ],
    learning_proposals: [
      {
        id: 'prop-postal',
        organization_id: POSTAL,
        kind: 'unanswered_question',
        document_id: null,
        chunk_index: null,
        headline: 'Falta la política de horas extra',
        detail: 'Postal',
        evidence: {},
        status: 'open',
        decided_at: null,
        decided_by: null,
        decided_note: null,
        dedupe_key: 'unanswered_question:horas extra',
        created_at: OBSERVED,
        updated_at: OBSERVED,
      },
      {
        id: 'prop-aduanas',
        organization_id: ADUANAS,
        kind: 'unanswered_question',
        document_id: null,
        chunk_index: null,
        headline: 'Falta la política de horas extra',
        detail: 'Aduanas',
        evidence: {},
        status: 'open',
        decided_at: null,
        decided_by: null,
        decided_note: null,
        dedupe_key: 'unanswered_question:horas extra',
        created_at: OBSERVED,
        updated_at: OBSERVED,
      },
    ],
  });

  // Fresh caches per world: `loadActiveAdjustments` keeps a short-lived copy
  // per workspace, and a test that inherited another test's copy would be
  // asserting on a fixture that no longer exists.
  forgetAdjustmentCache();

  return {
    tables: fake.tables,
    postal: createOrgScopedClient(fake.client as SupabaseClient, POSTAL),
    aduanas: createOrgScopedClient(fake.client as SupabaseClient, ADUANAS),
  };
}

describe('what one workspace learned never reaches another', () => {
  it('serves only this workspace’s adjustments to retrieval', async () => {
    const w = world();

    const postal = await loadActiveAdjustments(w.postal, POSTAL);
    expect(postal).toHaveLength(1);
    expect(postal[0]?.kind).toBe('demote_fragment');

    const aduanas = await loadActiveAdjustments(w.aduanas, ADUANAS);
    expect(aduanas).toHaveLength(1);
    // The opposite verdict about a document with the same id. If the filter
    // were lost, one of these two companies would be quoting its own tarifas in
    // an order the other one decided.
    expect(aduanas[0]?.kind).toBe('prefer_fragment');
  });

  it('caches per workspace, never across', async () => {
    const w = world();
    await loadActiveAdjustments(w.postal, POSTAL);
    const aduanas = await loadActiveAdjustments(w.aduanas, ADUANAS);
    expect(aduanas[0]?.kind).toBe('prefer_fragment');
  });

  it('lists only this workspace’s signals, adjustments and proposals', async () => {
    const w = world();

    const signals = await listSignalsSince(w.postal, '2026-01-01T00:00:00Z');
    expect(signals.map((s) => s.id)).toEqual(['sig-postal']);

    const adjustments = await listAdjustments(w.aduanas);
    expect(adjustments.map((a) => a.id)).toEqual(['adj-aduanas']);

    const proposals = await listLearningProposals(w.postal);
    expect(proposals.map((p) => p.id)).toEqual(['prop-postal']);
  });

  it('cannot undo another workspace’s adjustment even with its id in hand', async () => {
    const w = world();

    const undone = await revokeAdjustment(w.postal, POSTAL, {
      id: 'adj-aduanas',
      userId: ANA,
    });
    expect(undone).toBe(false);

    const theirs = w.tables.learning_adjustments?.find((r) => r.id === 'adj-aduanas');
    expect(theirs?.status).toBe('active');
  });

  it('stamps every new observation with the workspace that wrote it', async () => {
    const w = world();
    await recordSignals(w.aduanas, ADUANAS, [
      {
        kind: 'fragment_copied',
        polarity: 1,
        weight: 2,
        documentId: SHARED_DOC,
        chunkIndex: 5,
        actorUserId: CARLA,
        dedupeKey: 'fragment_copied:carla',
        observedAt: OBSERVED,
      },
    ]);

    const written = w.tables.learning_signals?.find(
      (r) => r.dedupe_key === 'fragment_copied:carla',
    );
    expect(written?.organization_id).toBe(ADUANAS);
    expect(await listSignalsSince(w.postal, '2026-01-01T00:00:00Z')).toHaveLength(1);
  });

  it('stamps a newly applied adjustment, and retires only its own predecessor', async () => {
    const w = world();

    await applyAdjustment(w.aduanas, ADUANAS, {
      kind: 'demote_fragment',
      documentId: SHARED_DOC,
      chunkIndex: 3,
      evidence: {
        net: -6,
        positive: 0,
        negative: 6,
        actors: 2,
        days: 2,
        byKind: {},
        firstSeen: OBSERVED,
        lastSeen: OBSERVED,
      },
    });

    const rows = w.tables.learning_adjustments ?? [];
    // Aduanas changed its own mind...
    expect(rows.find((r) => r.id === 'adj-aduanas')?.status).toBe('expired');
    // ...and Postal's identically-keyed verdict is untouched.
    expect(rows.find((r) => r.id === 'adj-postal')?.status).toBe('active');
    expect(rows.find((r) => r.organization_id === ADUANAS && r.status === 'active')?.kind).toBe(
      'demote_fragment',
    );
  });
});
