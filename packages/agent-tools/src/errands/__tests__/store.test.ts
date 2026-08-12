import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetPlansCache } from '../../billing';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import type { ToolContext } from '../../types';
import { OutboundToolRefused, assertProposalOnly } from '../boundary';
import { MAX_LIVE_ERRANDS } from '../budget';
import { answerFromChat, commissionErrand, countLiveErrands } from '../store';

/**
 * THE ONE DOOR, TESTED AS ONE DOOR.
 *
 * The interesting property of this module is not any single check — it is that
 * `commissionErrand` HOLDS all of them, so `POST /api/errands` and the
 * `errands.start` tool cannot differ. Before the chat existed the checks lived
 * in the route; the day a second caller appeared, that arrangement would have
 * silently exempted the caller a model drives from a sentence somebody typed.
 *
 * So these run the real function, not the route and not the tool, and every
 * refusal below is a refusal both surfaces inherit for free.
 */

const ORG = 'org-a';

interface Fixture {
  ctx: ToolContext;
  tables: Tables;
  /** `Tables` is an index signature, so every lookup is optional to the compiler. */
  errands: () => Array<Record<string, unknown>>;
  questions: () => Array<Record<string, unknown>>;
}

function fixture(errands: Array<Record<string, unknown>> = []): Fixture {
  const tables: Tables = {
    errands: errands.map((e, i) => ({
      id: `errand-${i + 1}`,
      organization_id: ORG,
      user_id: 'user-1',
      kind: 'research_compare',
      request: 'Investiga algo',
      state: 'working',
      token_ceiling: 400_000,
      tokens_spent: 0,
      leg_ceiling: 3,
      legs_used: 0,
      check_interval_minutes: null,
      checks_done: 0,
      next_check_at: null,
      baseline: null,
      conversation_id: null,
      current_run_id: null,
      findings: null,
      deliverable: null,
      sources: [],
      closing_note: null,
      last_heartbeat_at: new Date().toISOString(),
      claimed_at: null,
      started_at: null,
      finished_at: null,
      created_at: new Date().toISOString(),
      ...e,
    })),
    errand_questions: [],
  };
  const { client } = createFakeSupabase(tables);
  const ctx = {
    organizationId: ORG,
    userId: 'user-1',
    agentId: 'agent-1',
    conversationId: undefined,
    surface: 'web',
    db: client,
    // Never reached by this module.
    integrations: {} as ToolContext['integrations'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as ToolContext['logger'],
  } as unknown as ToolContext;
  return {
    ctx,
    tables,
    errands: () => tables.errands ?? [],
    questions: () => tables.errand_questions ?? [],
  };
}

beforeEach(() => resetPlansCache());

describe('commissioning an errand', () => {
  it('writes the row and hands back the view both surfaces render', async () => {
    const fx = fixture();
    const outcome = await commissionErrand(fx.ctx, {
      kind: 'research_compare',
      request: 'Investiga qué operadores manejan carga refrigerada en Buenaventura',
      conversationId: null,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.errand.state).toBe('queued');
    expect(outcome.errand.kind).toBe('research_compare');
    // A ceiling is always set. An errand with no ceiling is the surprise bill.
    expect(outcome.errand.tokenCeiling).toBeGreaterThan(0);
    expect(outcome.errand.legCeiling).toBeGreaterThan(0);
    expect(fx.errands()).toHaveLength(1);
  });

  it('remembers the conversation, which is how the question gets back to it', async () => {
    const fx = fixture();
    const outcome = await commissionErrand(fx.ctx, {
      kind: 'gather_sources',
      request: 'Reúneme todo lo que tengamos de Coltrans',
      conversationId: 'conv-9',
    });
    expect(outcome.ok).toBe(true);
    expect(fx.errands()[0]?.conversation_id).toBe('conv-9');
  });

  it('starts an errand from the form with no conversation attached', async () => {
    const fx = fixture();
    await commissionErrand(fx.ctx, {
      kind: 'research_compare',
      request: 'Investiga los competidores más cercanos',
      conversationId: null,
    });
    expect(fx.errands()[0]?.conversation_id).toBeNull();
  });

  it('gives a monitor a cadence even when nobody chose one', async () => {
    // The CHECK constraint in 0089 refuses a monitor without one, so a default
    // is not a convenience — it is what stops the chat path writing a row the
    // database will reject.
    const fx = fixture();
    const outcome = await commissionErrand(fx.ctx, {
      kind: 'monitor_change',
      request: 'Vigila las tarifas de flete Cartagena–Miami',
    });
    expect(outcome.ok).toBe(true);
    expect(fx.errands()[0]?.check_interval_minutes).toBeGreaterThan(0);
  });

  it('ignores a cadence nobody offered, rather than honouring a made-up one', async () => {
    // A model asked for minutes will happily invent "5". Five minutes is 288
    // re-reads of the same page a day, billed.
    const fx = fixture();
    await commissionErrand(fx.ctx, {
      kind: 'monitor_change',
      request: 'Vigila el precio y me avisas',
      checkIntervalMinutes: 5,
    });
    expect(fx.errands()[0]?.check_interval_minutes).not.toBe(5);
  });

  // ── The room ────────────────────────────────────────────────────────────
  it('refuses once the workspace is already full, whoever is asking', async () => {
    const fx = fixture(
      Array.from({ length: MAX_LIVE_ERRANDS }, (_, i) => ({ id: `live-${i}`, state: 'working' })),
    );
    const outcome = await commissionErrand(fx.ctx, {
      kind: 'research_compare',
      request: 'Investiga otra cosa más, la cuarta',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('too_many_live');
    // Returned, not thrown: the caller that matters is a model relaying this to
    // a person, and a thrown error becomes "no pude hacerlo".
    expect(outcome.message).toContain('máximo');
    // And nothing was written.
    expect(fx.errands()).toHaveLength(MAX_LIVE_ERRANDS);
  });

  it('counts a blocked errand against the cap, because it is still costing a slot', async () => {
    const fx = fixture([
      { id: 'a', state: 'blocked' },
      { id: 'b', state: 'watching' },
      { id: 'c', state: 'queued' },
      // Finished ones must not count, or a busy workspace jams for ever.
      { id: 'd', state: 'delivered' },
      { id: 'e', state: 'cancelled' },
    ]);
    expect(await countLiveErrands(fx.ctx.db as SupabaseClient)).toBe(3);
  });

  // ── The line ────────────────────────────────────────────────────────────
  it('refuses to commission anything whose toolset could act outward', async () => {
    // The guard `commissionErrand` runs before it writes. Exercised directly
    // here because the only way to reach it in production is to have broken the
    // allow-list, and this is what makes that break loud instead of shipped.
    expect(() => assertProposalOnly(['web.search', 'gmail.send_message'])).toThrow(
      OutboundToolRefused,
    );
  });

  it('lets a normal commission through the same guard untouched', async () => {
    const fx = fixture();
    await expect(
      commissionErrand(fx.ctx, {
        kind: 'research_compare',
        request: 'Consígueme opciones de vuelo a Bogotá para el martes y compáralas',
      }),
    ).resolves.toMatchObject({ ok: true });
    // Note what this request says and what it produces: a COMPARISON. The
    // booking half is refused by the toolset, not by refusing the errand.
  });
});

describe('answering from the chat', () => {
  it('says so plainly when nothing is waiting', async () => {
    const fx = fixture();
    const outcome = await answerFromChat(fx.ctx.db as SupabaseClient, {
      answer: 'marítima',
      userId: 'user-1',
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'none_open' });
  });

  it('refuses to guess which errand is being answered', async () => {
    // Two jobs waiting and a bare "la primera". Picking wrong sends an hour of
    // work down the wrong road, so the tool asks instead — the same reflex the
    // errands themselves have.
    const fx = fixture([
      { id: 'e1', state: 'blocked' },
      { id: 'e2', state: 'blocked' },
    ]);
    fx.tables.errand_questions = [
      {
        id: 'q1',
        organization_id: ORG,
        errand_id: 'e1',
        state: 'open',
        question: '¿Marítima o terrestre?',
        asked_at: '2026-08-12T10:00:00.000Z',
      },
      {
        id: 'q2',
        organization_id: ORG,
        errand_id: 'e2',
        state: 'open',
        question: '¿Incluyo Cartagena?',
        asked_at: '2026-08-12T11:00:00.000Z',
      },
    ];
    const outcome = await answerFromChat(fx.ctx.db as SupabaseClient, {
      answer: 'la primera',
      userId: 'user-1',
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'ambiguous' });
    // Both questions are still open — nothing was answered on a guess.
    expect(fx.questions().every((q) => q.state === 'open')).toBe(true);
  });

  it('answers the one that was named, even when two are waiting', async () => {
    const fx = fixture([
      { id: 'e1', state: 'blocked' },
      { id: 'e2', state: 'blocked' },
    ]);
    fx.tables.errand_questions = [
      {
        id: 'q1',
        organization_id: ORG,
        errand_id: 'e1',
        state: 'open',
        question: '¿Marítima o terrestre?',
        asked_at: '2026-08-12T10:00:00.000Z',
      },
      {
        id: 'q2',
        organization_id: ORG,
        errand_id: 'e2',
        state: 'open',
        question: '¿Incluyo Cartagena?',
        asked_at: '2026-08-12T11:00:00.000Z',
      },
    ];
    const outcome = await answerFromChat(fx.ctx.db as SupabaseClient, {
      errandId: 'e2',
      answer: 'sí, inclúyelo',
      userId: 'user-1',
    });
    expect(outcome).toMatchObject({ ok: true, errandId: 'e2' });
    expect(fx.questions().find((q) => q.id === 'q2')).toMatchObject({
      state: 'answered',
      answer: 'sí, inclúyelo',
    });
    // The other one is untouched, and its errand is still blocked.
    expect(fx.questions().find((q) => q.id === 'q1')?.state).toBe('open');
  });

  it('resumes the errand it answered, keeping everything it had found', async () => {
    const fx = fixture([
      { id: 'e1', state: 'blocked', findings: 'cuatro operadores', legs_used: 2 },
    ]);
    fx.tables.errand_questions = [
      {
        id: 'q1',
        organization_id: ORG,
        errand_id: 'e1',
        state: 'open',
        question: '¿Marítima o terrestre?',
        asked_at: '2026-08-12T10:00:00.000Z',
      },
    ];
    const outcome = await answerFromChat(fx.ctx.db as SupabaseClient, {
      answer: 'marítima',
      userId: 'user-1',
    });
    expect(outcome.ok).toBe(true);
    const errand = fx.errands().find((e) => e.id === 'e1');
    expect(errand?.state).toBe('working');
    // A resumption, not a relaunch. This is the property the whole
    // ask-instead-of-guess design rests on.
    expect(errand?.findings).toBe('cuatro operadores');
    expect(errand?.legs_used).toBe(2);
  });
});
