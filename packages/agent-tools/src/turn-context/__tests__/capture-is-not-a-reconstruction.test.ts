import { describe, expect, it, vi } from 'vitest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import type { RetrievalObservation } from '../../types';
import { TurnContextRecorder, familiesFrom, fragmentKey } from '../recorder';

/**
 * THE TEST THIS WHOLE FEATURE STANDS OR FALLS ON.
 *
 * The surface is only worth having if it shows what was really sent. The moment
 * it recomputes anything, it starts agreeing with the truth on every turn
 * EXCEPT the ones somebody opened it for — because the reason you open it is
 * that something changed, and the things that change are exactly the inputs a
 * recomputation would use: the relevance thresholds, the corpus, the embedding
 * model, the tool descriptions.
 *
 * So these tests do not check that the numbers are right. They check that the
 * numbers are the ones they were HANDED, by making the world disagree with the
 * capture and asserting the capture does not budge.
 */

const ORG = 'org-acme';

function scoped(tables: Record<string, Record<string, unknown>[]> = {}) {
  const fake = createFakeSupabase({ turn_contexts: [], ...tables });
  return { fake, db: createOrgScopedClient(fake.client, ORG) };
}

function recorder() {
  return new TurnContextRecorder({
    organizationId: ORG,
    conversationId: 'conv-1',
    userId: 'user-1',
    agentId: 'agent-1',
    model: 'anthropic:claude-opus-5',
  });
}

/**
 * A retrieval carrying thresholds that are NOT the ones this deployment runs,
 * and a verdict that disagrees with what those thresholds would say today. If
 * anything downstream re-judged the hit, this fixture would expose it.
 */
const OBSERVATION: RetrievalObservation = {
  query: 'plan de arranque',
  limit: 3,
  coverage: 'answered',
  summary: 'Encontré material que responde a esto en Brain Knowledge.',
  cuts: {
    // Deliberately a model with no entry in CALIBRATIONS, and cuts that match
    // no calibration in the file.
    modelId: 'voyage:voyage-from-last-year',
    strongMatch: 0.91,
    weakFloor: 0.88,
    railCeiling: 0.99,
    measured: true,
  },
  hits: [
    {
      chunkId: 'chunk-a',
      documentId: 'doc-1',
      documentTitle: 'Plan de arranque',
      spaceId: 'space-global',
      spaceName: 'Compañía',
      spaceKind: 'global',
      chunkIndex: 0,
      content: 'El plan de arranque tiene tres fases.',
      cosine: 0.489,
      keyword: 0,
      blended: 0.34,
      // 0.489 is FAR below the 0.91 strongMatch above. Today's real thresholds
      // would call this 'strong'. The capture must keep what it was told.
      verdict: 'strong',
    },
    {
      chunkId: 'chunk-b',
      documentId: 'doc-2',
      documentTitle: 'Acta de comité',
      spaceId: 'space-global',
      spaceName: 'Compañía',
      spaceKind: 'global',
      chunkIndex: 4,
      content: 'Se aprobó el presupuesto.',
      cosine: 0.441,
      keyword: 0,
      blended: 0.31,
      verdict: 'dropped',
    },
  ],
};

describe('a captured turn is a record, not a re-derivation', () => {
  it('keeps the scores, cuts and verdicts it was handed, however wrong they look now', () => {
    const rec = recorder();
    rec.retrieved(OBSERVATION, new Set([fragmentKey('doc-1', 0)]));

    const { retrieval } = rec.capture();

    // The cuts travel verbatim. Nothing consulted relevance.ts, which is the
    // point: those numbers have been recalibrated twice and would put the bar
    // in the wrong place on an old turn.
    expect(retrieval.cuts.modelId).toBe('voyage:voyage-from-last-year');
    expect(retrieval.cuts.strongMatch).toBe(0.91);
    expect(retrieval.cuts.weakFloor).toBe(0.88);

    // The verdict is the one that was applied at the time, not the one today's
    // arithmetic would produce from the same cosine and the same cuts.
    expect(retrieval.fragments[0]?.verdict).toBe('strong');
    expect(retrieval.fragments[0]?.cosine).toBe(0.489);
    expect(retrieval.fragments[1]?.verdict).toBe('dropped');
  });

  it('keeps the fragments that lost — the ones the model was never shown', () => {
    const rec = recorder();
    rec.retrieved(OBSERVATION, new Set([fragmentKey('doc-1', 0)]));

    const { retrieval } = rec.capture();
    expect(retrieval.fragments).toHaveLength(2);

    const dropped = retrieval.fragments.find((f) => f.documentId === 'doc-2');
    // It came back, it was ranked, it never reached the model — and it is on
    // the record with its score. That is usually the answer to "why did it say
    // that", and it exists nowhere else once kb.search has returned.
    expect(dropped?.prepended).toBe(false);
    expect(dropped?.cosine).toBe(0.441);
    expect(dropped?.excerpt).toContain('presupuesto');
  });

  it('takes "was it prepended" from the caller, never from the score', () => {
    const rec = recorder();
    // Nothing was prepended, even though one hit is rated 'strong'. A capture
    // that inferred the answer from the verdict would get this backwards — and
    // this is a real state: the limit can be zero, or the block can fail to
    // build after the search succeeded.
    rec.retrieved(OBSERVATION, new Set());

    const { retrieval } = rec.capture();
    expect(retrieval.fragments.every((f) => !f.prepended)).toBe(true);
    expect(retrieval.fragments[0]?.verdict).toBe('strong');
  });

  it('weighs the parts on the exact strings that were sent', () => {
    const rec = recorder();
    rec.part('instructions', 'x'.repeat(700));
    rec.part('knowledge', 'y'.repeat(300));

    const { parts } = rec.capture();
    const instructions = parts.find((p) => p.key === 'instructions');
    const knowledge = parts.find((p) => p.key === 'knowledge');

    // Characters are a measurement of the real string. Nothing is rounded, and
    // nothing is a model of what "a prompt like this" usually weighs.
    expect(instructions?.chars).toBe(700);
    expect(knowledge?.chars).toBe(300);
    // Empty parts are absent rather than present at zero.
    expect(parts.find((p) => p.key === 'memory')).toBeUndefined();
  });

  it("records the provider's real token count alongside the estimate", () => {
    const rec = recorder();
    rec.part('instructions', 'x'.repeat(700));

    const capture = rec.capture({ promptTokens: 4321, completionTokens: 120 });
    // The true figure is stored as itself and never reconciled against the
    // estimate — a page that quietly adjusted one to match the other would be
    // hiding the only honest signal it has about its own precision.
    expect(capture.promptTokens).toBe(4321);
    expect(capture.parts[0]?.tokens).toBe(200);
  });

  it('stores the ranking that produced the tool list, losers included', () => {
    const families = familiesFrom({
      scores: [
        { family: 'hubspot', score: 0.52 },
        { family: 'vehicles', score: 0.44 },
        { family: 'gmail', score: 0.19 },
      ],
      alwaysFamilies: ['kb'],
      selected: ['hubspot'],
      unranked: ['mcp:new-server'],
      muted: [],
    });

    const hubspot = families.find((f) => f.family === 'hubspot');
    const vehicles = families.find((f) => f.family === 'vehicles');
    const unindexed = families.find((f) => f.family === 'mcp:new-server');

    expect(hubspot).toMatchObject({ offered: true, reason: 'ranked', score: 0.52 });
    // The near miss, with its number. "It never called the fleet tool because
    // that family scored 0,44" is an explanation; without the score it is a
    // shrug.
    expect(vehicles).toMatchObject({ offered: false, reason: 'below-cut', score: 0.44 });
    // A family nobody has embedded yet is OFFERED, and says why. Same rule as
    // tool-selection itself: failure opens, never closes.
    expect(unindexed).toMatchObject({ offered: true, reason: 'unindexed' });
    expect(families.find((f) => f.family === 'kb')).toMatchObject({ reason: 'always' });
  });

  it('marks a muted family as muted, and still keeps what it would have scored', () => {
    const families = familiesFrom({
      scores: [{ family: 'hubspot', score: 0.61 }],
      alwaysFamilies: [],
      selected: ['hubspot'],
      unranked: [],
      muted: ['hubspot'],
    });

    // The score survives the muting on purpose: "you turned this off and it was
    // the best match on this turn" is the sentence that lets somebody undo a
    // decision they no longer remember making.
    expect(families[0]).toMatchObject({ family: 'hubspot', offered: false, reason: 'muted' });
    expect(families[0]?.score).toBe(0.61);
  });

  it('writes exactly what it accumulated, with both retention dates on the row', async () => {
    const { fake, db } = scoped();
    const rec = recorder();
    rec.retrieved(OBSERVATION, new Set([fragmentKey('doc-1', 0)]));
    rec.part('knowledge', 'z'.repeat(120));

    await rec.save(db, { messageId: 'msg-1', usage: { promptTokens: 900 } });

    const row = fake.tables.turn_contexts?.[0] as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.organization_id).toBe(ORG);
    expect(row.message_id).toBe('msg-1');
    expect(row.prompt_tokens).toBe(900);
    // A row states its own deadlines, so a later change to the policy cannot
    // retroactively re-date history.
    expect(typeof row.detail_until).toBe('string');
    expect(typeof row.purge_at).toBe('string');
    expect(new Date(row.purge_at as string).getTime()).toBeGreaterThan(
      new Date(row.detail_until as string).getTime(),
    );
  });
});

describe('the capture never costs an answer', () => {
  it('swallows a database failure instead of throwing into the turn', async () => {
    const failing = {
      from: () => {
        throw new Error('la base se cayó');
      },
    } as unknown as Parameters<TurnContextRecorder['save']>[0];

    const rec = recorder();
    // The turn has already been streamed to the person by the time this runs.
    // There is no failure here that is worth surfacing, and nothing a caller
    // could branch on — which is why `save` returns void.
    await expect(rec.save(failing, { messageId: null })).resolves.toBeUndefined();
  });

  it('accumulates without touching the database at all', () => {
    const rec = recorder();
    const db = { from: vi.fn(), rpc: vi.fn() };

    rec.part('instructions', 'hola');
    rec.basePrompt('hola');
    rec.memory([{ id: 'm1', text: 'siempre en español' }]);
    rec.retrieved(OBSERVATION, new Set());
    rec.toolOffer({ reason: 'semantic', candidates: 60, offered: ['kb.search'], families: [] });
    rec.adjusted(true);
    rec.capture();

    // Everything above happens while the person is waiting for their answer.
    // If any of it could reach the database, the diagnostics would be on the
    // critical path of the reply — which is the one thing this must never be.
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
