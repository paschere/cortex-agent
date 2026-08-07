/**
 * Writing and reading a run through the workspace-scoped handle.
 *
 * WHY THIS IS NOT A UNIT TEST OF `saveRun`. The interesting property is not that
 * the function builds the right object literal — it is that the two tables obey
 * the tenancy contract they were registered under. `evaluation_runs` is tenant,
 * so a read from one workspace must not see another's run even when both ran the
 * identical suite and their rows are indistinguishable by content. That is the
 * shape of leak this schema is most exposed to: the corpus and the questions are
 * the same everywhere, so a missing filter does not return something obviously
 * foreign, it returns a plausible number from somebody else's deployment.
 *
 * `evaluation_case_results` is derived, so every read of it has to name a run,
 * and the scoped client throws when one does not. That refusal is asserted here
 * rather than trusted, because it is the only thing standing between a child
 * table with no `organization_id` and a cross-workspace read.
 *
 * The subject under test is the real `createOrgScopedClient` over a real (if
 * small) PostgREST, exactly as `tenancy/__tests__/isolation.test.ts` does it.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CALIBRATION } from '../../kb/relevance';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import {
  EVALUATION_CASE_RESULTS_TABLE,
  latestRuns,
  loadCaseResults,
  saveRun,
} from '../store';
import type { EvalRun } from '../types';

const ACME = 'org-acme';
const GLOBEX = 'org-globex';

function tables(): Tables {
  return { evaluation_runs: [], evaluation_case_results: [] };
}

/** A workspace-scoped handle over the shared fake, for one organization. */
function scoped(data: Tables, organizationId: string) {
  return createOrgScopedClient(createFakeSupabase(data).client, organizationId);
}

function run(over: Partial<EvalRun> = {}): EvalRun {
  return {
    identity: {
      suiteId: 'cortex-brain-v1',
      suiteDigest: 'aaaaaaaaaaaaaaaa',
      embeddingModel: DEFAULT_CALIBRATION.modelId,
      calibration: DEFAULT_CALIBRATION,
      chatModel: null,
      judgeModel: null,
      answerPromptDigest: null,
      judgePromptDigest: null,
    },
    tier: 'offline',
    startedAt: '2026-08-07T12:00:00.000Z',
    elapsedMs: 900,
    vectorSource: 'medición del 2026-08-07',
    retrieval: {
      cases: 22,
      top1: 0.9,
      recall: 1,
      grounding: 1,
      restraint: 1,
      missedByFloor: 0,
      overclaimed: 0,
      results: [
        {
          caseId: 'plan-arranque',
          group: 'answered',
          query: '¿plan de arranque de cortex?',
          goldRank: 1,
          goldKept: true,
          bestScore: 0.51,
          goldScore: 0.51,
          coverage: 'answered',
          coverageCorrect: true,
          missedByFloor: false,
          overclaimed: false,
          passed: true,
        },
      ],
    },
    selection: {
      cases: 5,
      reach: 1,
      staleTools: 0,
      results: [
        {
          caseId: 'sel-placa',
          query: 'consulta los comparendos de la placa WXY123',
          needsFamily: 'vehicles',
          offered: true,
          familyScore: 0.62,
          familiesOffered: 4,
          passed: true,
        },
      ],
    },
    answers: null,
    costUsd: 0,
    warnings: [],
    ...over,
  };
}

describe('storing a run', () => {
  it('writes the summary and the per-case detail, stamped with the workspace', async () => {
    const data = tables();
    const db = scoped(data, ACME);
    const id = await saveRun(db, run());

    const runs = data.evaluation_runs ?? [];
    const cases = data.evaluation_case_results ?? [];

    expect(runs).toHaveLength(1);
    expect(runs[0]?.organization_id).toBe(ACME);
    // Two rows: one retrieval case, one selection case. Every one carries the
    // run it belongs to, which is the only tenant it has.
    expect(cases).toHaveLength(2);
    for (const row of cases) expect(row.run_id).toBe(id);
    // And no organization_id anywhere on the child rows — a second copy of the
    // workspace id is a second thing that can disagree with the first.
    for (const row of cases) expect(row.organization_id).toBeUndefined();
  });

  it('shows a workspace only its own runs, however alike the numbers are', async () => {
    // Both workspaces run the identical suite and get identical scores, so a
    // lost filter returns something plausible rather than something empty —
    // which is exactly how this kind of bug survives review.
    const data = tables();
    await saveRun(scoped(data, ACME), run());
    await saveRun(scoped(data, GLOBEX), run());

    expect(data.evaluation_runs ?? []).toHaveLength(2);
    const acme = await latestRuns(scoped(data, ACME));
    expect(acme).toHaveLength(1);
    expect(acme[0]?.suiteDigest).toBe('aaaaaaaaaaaaaaaa');
    expect(acme[0]?.retrieval.grounding).toBe(1);
  });

  it('reads the case detail only when a run is named', async () => {
    const data = tables();
    const db = scoped(data, ACME);
    const id = await saveRun(db, run());

    const detail = await loadCaseResults(db, id);
    expect(detail.map((d) => d.caseId).sort()).toEqual(['plan-arranque', 'sel-placa']);
    expect(detail.find((d) => d.layer === 'retrieval')?.detail).toMatchObject({
      goldRank: 1,
      coverage: 'answered',
    });

    // The same table read without naming a run: the derived guard refuses,
    // because a child table with no organization_id has no other boundary.
    await expect(db.from(EVALUATION_CASE_RESULTS_TABLE).select('*')).rejects.toThrow();
  });
});
