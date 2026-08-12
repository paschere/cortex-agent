import { describe, expect, it } from 'vitest';
import {
  type ErrandBuilder,
  type ErrandDb,
  LEASE_MS,
  answerQuestion,
  askAndBlock,
  claimErrand,
  closeErrand,
  closeLeg,
  openLeg,
  parkForNextCheck,
  releaseErrand,
} from '../lifecycle';

/**
 * A database that behaves like the real one rather than like a Map.
 *
 * Every guard in lifecycle.ts lives in a WHERE clause, so the fake evaluates
 * the filters and writes in ONE synchronous critical section, with the awaits
 * either side of it. An implementation that read a row, went away, and wrote
 * it back would pass a Map-based test and still commission the same leg twice
 * under two events a millisecond apart — this fake fails it.
 *
 * It also enforces the two indexes the schema relies on for correctness, since
 * both of them ARE the concurrency control: one open question per errand, and
 * one leg per (errand, seq).
 */

interface ErrandRowShape {
  id: string;
  organization_id: string;
  state: string;
  claimed_at: string | null;
  last_heartbeat_at: string;
  finished_at: string | null;
  closing_note: string | null;
  deliverable: string | null;
  findings: string | null;
  sources: unknown;
  baseline: string | null;
  legs_used: number;
  tokens_spent: number;
  checks_done: number;
  next_check_at: string | null;
  current_run_id: string | null;
  brief: string | null;
}

interface LegRowShape {
  id: string;
  organization_id: string;
  errand_id: string;
  seq: number;
  run_id: string | null;
  status: string;
  summary: string | null;
  tokens: number;
  assessed_at: string | null;
  finished_at: string | null;
}

interface QuestionRowShape {
  id: string;
  organization_id: string;
  errand_id: string;
  leg: number;
  question: string;
  why: string;
  options: string[];
  state: string;
  answer: string | null;
  answered_at: string | null;
  answered_by: string | null;
}

type Filter = [op: 'eq' | 'in' | 'lt' | 'is', column: string, value: unknown];

function makeDb(
  options: {
    errands?: Partial<ErrandRowShape>[];
    legs?: Partial<LegRowShape>[];
    questions?: Partial<QuestionRowShape>[];
  } = {},
) {
  const errands: ErrandRowShape[] = (options.errands ?? [{}]).map((e, i) => ({
    id: `errand-${i + 1}`,
    organization_id: 'org-1',
    state: 'working',
    claimed_at: null,
    last_heartbeat_at: new Date().toISOString(),
    finished_at: null,
    closing_note: null,
    deliverable: null,
    findings: null,
    sources: [],
    baseline: null,
    legs_used: 0,
    tokens_spent: 0,
    checks_done: 0,
    next_check_at: null,
    current_run_id: null,
    brief: 'a brief',
    ...e,
  }));
  const legs: LegRowShape[] = (options.legs ?? []).map((l, i) => ({
    id: `leg-${i + 1}`,
    organization_id: 'org-1',
    errand_id: 'errand-1',
    seq: i + 1,
    run_id: null,
    status: 'running',
    summary: null,
    tokens: 0,
    assessed_at: null,
    finished_at: null,
    ...l,
  }));
  const questions: QuestionRowShape[] = (options.questions ?? []).map((q, i) => ({
    id: `question-${i + 1}`,
    organization_id: 'org-1',
    errand_id: 'errand-1',
    leg: 0,
    question: '¿?',
    why: 'porque',
    options: [],
    state: 'open',
    answer: null,
    answered_at: null,
    answered_by: null,
    ...q,
  }));

  let inserts = 0;

  const matches = (row: Record<string, unknown>, filters: Filter[]): boolean =>
    filters.every(([op, column, value]) => {
      const actual = row[column];
      if (op === 'eq') return actual === value;
      if (op === 'in') return (value as unknown[]).includes(actual);
      if (op === 'is') return actual === value;
      // `lt` over ISO timestamps. A null claimed_at is not "less than"
      // anything — exactly as SQL treats it, which is why claimErrand needs
      // two statements rather than one.
      return actual != null && String(actual) < String(value);
    });

  const client: ErrandDb = {
    from(table: string) {
      const rows: Record<string, unknown>[] =
        table === 'errands'
          ? (errands as unknown as Record<string, unknown>[])
          : table === 'errand_legs'
            ? (legs as unknown as Record<string, unknown>[])
            : table === 'errand_questions'
              ? (questions as unknown as Record<string, unknown>[])
              : [];
      let mode: 'select' | 'update' | 'insert' = 'select';
      let values: Record<string, unknown> = {};
      const filters: Filter[] = [];

      const settle = () => {
        if (mode === 'insert') {
          inserts += 1;
          if (table === 'errand_questions') {
            // errand_questions_one_open_idx: one open question per errand.
            const clash = questions.some(
              (q) => q.errand_id === values.errand_id && q.state === 'open',
            );
            if (clash) {
              return { data: null, error: { message: 'duplicate key value: one open question' } };
            }
            const row: QuestionRowShape = {
              id: `question-${questions.length + 1}`,
              organization_id: values.organization_id as string,
              errand_id: values.errand_id as string,
              leg: (values.leg as number) ?? 0,
              question: values.question as string,
              why: values.why as string,
              options: (values.options as string[]) ?? [],
              state: 'open',
              answer: null,
              answered_at: null,
              answered_by: null,
            };
            questions.push(row);
            return { data: [{ ...row }], error: null };
          }
          if (table === 'errand_legs') {
            // errand_legs_errand_seq_idx: seq is the leg's identity.
            const clash = legs.some(
              (l) => l.errand_id === values.errand_id && l.seq === values.seq,
            );
            if (clash) return { data: null, error: { message: 'duplicate key value: seq' } };
            const row: LegRowShape = {
              id: `leg-${legs.length + 1}`,
              organization_id: values.organization_id as string,
              errand_id: values.errand_id as string,
              seq: values.seq as number,
              run_id: null,
              status: 'running',
              summary: null,
              tokens: 0,
              assessed_at: null,
              finished_at: null,
            };
            legs.push(row);
            return { data: [{ ...row }], error: null };
          }
          return { data: [values], error: null };
        }
        const hit = rows.filter((row) => matches(row, filters));
        if (mode === 'select') return { data: hit.map((row) => ({ ...row })), error: null };
        // The critical section: match and write with nothing awaited between.
        for (const row of hit) Object.assign(row, values);
        return { data: hit.map((row) => ({ ...row })), error: null };
      };

      const builder: ErrandBuilder = {
        select() {
          return builder;
        },
        update(next) {
          mode = 'update';
          values = next;
          return builder;
        },
        insert(next) {
          mode = 'insert';
          values = next;
          return builder;
        },
        eq(column, value) {
          filters.push(['eq', column, value]);
          return builder;
        },
        in(column, value) {
          filters.push(['in', column, value]);
          return builder;
        },
        lt(column, value) {
          filters.push(['lt', column, value]);
          return builder;
        },
        is(column, value) {
          filters.push(['is', column, value]);
          return builder;
        },
        maybeSingle() {
          const result = settle();
          const list = (result.data ?? []) as unknown[];
          return Promise.resolve({ data: list[0] ?? null, error: result.error });
        },
        // biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are thenables; the fake must be one to stand in for them.
        then(onFulfilled, onRejected) {
          return Promise.resolve(settle()).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };

  return { client, errands, legs, questions, insertCount: () => inserts };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe('claimErrand', () => {
  it('lets exactly one of two concurrent workers move the same errand', async () => {
    // Two workers on one errand means two legs commissioned for one step,
    // which is two bills for one piece of work.
    const db = makeDb();
    const [a, b] = await Promise.all([
      claimErrand(db.client, 'errand-1'),
      claimErrand(db.client, 'errand-1'),
    ]);
    expect([a, b].filter((r) => r.claimed)).toHaveLength(1);
    expect([a, b].find((r) => !r.claimed)).toMatchObject({ reason: 'held' });
  });

  // ── Survives a restart ──────────────────────────────────────────────────
  it('takes over from a worker that died holding the lease', async () => {
    // The whole reason the lease expires. An errand lives for hours and its
    // worker for seconds; a permanent claim would mean one killed process
    // wedged the errand for ever.
    const db = makeDb({ errands: [{ claimed_at: ago(LEASE_MS + 1_000) }] });
    expect(await claimErrand(db.client, 'errand-1')).toEqual({ claimed: true });
  });

  it('leaves a fresh lease alone', async () => {
    const db = makeDb({ errands: [{ claimed_at: ago(LEASE_MS / 2) }] });
    expect(await claimErrand(db.client, 'errand-1')).toEqual({ claimed: false, reason: 'held' });
  });

  it('refuses an errand that has already finished', async () => {
    for (const state of ['delivered', 'failed', 'cancelled', 'exhausted']) {
      const db = makeDb({ errands: [{ state }] });
      expect(await claimErrand(db.client, 'errand-1')).toEqual({
        claimed: false,
        reason: 'not_advanceable',
      });
    }
  });

  it('says so when the errand does not exist', async () => {
    const db = makeDb();
    expect(await claimErrand(db.client, 'nope')).toEqual({ claimed: false, reason: 'not_found' });
  });

  it('releases the lease so the next transition can start immediately', async () => {
    const db = makeDb();
    await claimErrand(db.client, 'errand-1');
    await releaseErrand(db.client, 'errand-1');
    expect(db.errands[0]?.claimed_at).toBeNull();
    expect(await claimErrand(db.client, 'errand-1')).toEqual({ claimed: true });
  });
});

describe('asking, and being answered', () => {
  it('saves what it found BEFORE it blocks, so the pause costs nothing', async () => {
    // The order is the whole point: findings, then the question, then the
    // state. Answering resumes from a full picture rather than from zero.
    const db = makeDb({ errands: [{ findings: null }] });
    await askAndBlock(db.client, {
      errandId: 'errand-1',
      organizationId: 'org-1',
      leg: 1,
      question: '¿Marítima o terrestre?',
      why: 'Son dos mercados distintos.',
      options: ['Marítima', 'Terrestre'],
      findings: 'Cuatro operadores encontrados; dos confirmados.',
    });

    expect(db.errands[0]?.findings).toBe('Cuatro operadores encontrados; dos confirmados.');
    expect(db.errands[0]?.state).toBe('blocked');
    expect(db.errands[0]?.current_run_id).toBeNull();
    expect(db.questions).toHaveLength(1);
    expect(db.questions[0]?.state).toBe('open');
  });

  it('still blocks when a second worker got its question in first', async () => {
    // The one-open-question index refuses the second insert. A person coming
    // back should find ONE thing to answer, not a form — and the errand must
    // still stop, or it would spend another leg on a fork it cannot pick.
    const db = makeDb({ questions: [{ state: 'open' }] });
    const asked = await askAndBlock(db.client, {
      errandId: 'errand-1',
      organizationId: 'org-1',
      leg: 1,
      question: 'otra pregunta',
      why: 'otra razón',
      options: [],
    });
    expect(asked).toBe(false);
    expect(db.questions).toHaveLength(1);
    expect(db.errands[0]?.state).toBe('blocked');
  });

  it('resumes on an answer, keeping everything it already knew', async () => {
    const db = makeDb({
      errands: [{ state: 'blocked', findings: 'lo que ya sabía', legs_used: 1 }],
      questions: [{ state: 'open' }],
      legs: [{ status: 'completed', assessed_at: new Date().toISOString() }],
    });

    expect(
      await answerQuestion(db.client, {
        errandId: 'errand-1',
        questionId: 'question-1',
        answer: 'Marítima',
        userId: 'user-1',
      }),
    ).toBe('resumed');

    expect(db.errands[0]?.state).toBe('working');
    // Nothing was rewound. This is a resumption, not a relaunch.
    expect(db.errands[0]?.findings).toBe('lo que ya sabía');
    expect(db.errands[0]?.legs_used).toBe(1);
    expect(db.legs[0]?.status).toBe('completed');
    expect(db.questions[0]).toMatchObject({ state: 'answered', answer: 'Marítima' });
  });

  it('lets exactly one of two people answer the same question', async () => {
    const db = makeDb({ errands: [{ state: 'blocked' }], questions: [{ state: 'open' }] });
    const [a, b] = await Promise.all([
      answerQuestion(db.client, {
        errandId: 'errand-1',
        questionId: 'question-1',
        answer: 'Marítima',
        userId: 'user-1',
      }),
      answerQuestion(db.client, {
        errandId: 'errand-1',
        questionId: 'question-1',
        answer: 'Terrestre',
        userId: 'user-2',
      }),
    ]);
    expect([a, b].filter((r) => r === 'resumed')).toHaveLength(1);
    expect([a, b]).toContain('not_open');
  });
});

describe('legs and the bill', () => {
  it('charges for a leg before commissioning it, never after', async () => {
    // State ahead of the work it describes: a worker that dies after this
    // leaves an errand charged for a leg that produced nothing, which is the
    // honest failure. The other order is the shape of a runaway bill.
    const db = makeDb({ errands: [{ legs_used: 1 }] });
    const legId = await openLeg(db.client, {
      errandId: 'errand-1',
      organizationId: 'org-1',
      seq: 2,
      objective: 'the next leg',
      legsUsed: 1,
    });
    expect(legId).toBe('leg-1');
    expect(db.errands[0]?.legs_used).toBe(2);
    expect(db.errands[0]?.state).toBe('working');
  });

  it('refuses a duplicate leg for the same step', async () => {
    const db = makeDb({ legs: [{ seq: 1 }] });
    const again = await openLeg(db.client, {
      errandId: 'errand-1',
      organizationId: 'org-1',
      seq: 1,
      objective: 'the same leg twice',
      legsUsed: 1,
    });
    expect(again).toBeNull();
    expect(db.legs).toHaveLength(1);
  });

  it('adds what a leg cost to the errand’s running total', async () => {
    const db = makeDb({ errands: [{ tokens_spent: 40_000 }], legs: [{ status: 'running' }] });
    await closeLeg(db.client, {
      errandId: 'errand-1',
      legId: 'leg-1',
      status: 'completed',
      summary: 'a report',
      tokens: 62_000,
      tokensSpent: 40_000,
    });
    expect(db.errands[0]?.tokens_spent).toBe(102_000);
    expect(db.errands[0]?.current_run_id).toBeNull();
    expect(db.legs[0]).toMatchObject({ status: 'completed', tokens: 62_000 });
  });
});

describe('endings', () => {
  it('never ends without saying why', async () => {
    const db = makeDb();
    await closeErrand(db.client, {
      errandId: 'errand-1',
      state: 'delivered',
      deliverable: '# result',
      sources: [{ title: 'a', url: 'https://a.example', readAt: '2026-08-12T09:00:00.000Z' }],
      closingNote: 'Listo.',
    });
    expect(db.errands[0]).toMatchObject({ state: 'delivered', closing_note: 'Listo.' });
    expect(db.errands[0]?.finished_at).not.toBeNull();
  });

  it('refuses to overwrite an ending somebody else already wrote', async () => {
    // A person cancelling during the last transition owns the ending. A second
    // one would replace "lo detuviste" with "entregado", which is a lie about
    // what happened.
    const db = makeDb({ errands: [{ state: 'cancelled', closing_note: 'Lo detuviste.' }] });
    const closed = await closeErrand(db.client, {
      errandId: 'errand-1',
      state: 'delivered',
      closingNote: 'Listo.',
    });
    expect(closed).toBe(false);
    expect(db.errands[0]?.closing_note).toBe('Lo detuviste.');
  });

  it('parks a monitor with its reading as the next baseline', async () => {
    const db = makeDb({ errands: [{ state: 'working', checks_done: 1 }] });
    const now = Date.parse('2026-08-12T10:00:00.000Z');
    await parkForNextCheck(db.client, {
      errandId: 'errand-1',
      reading: 'Tarifa: USD 3.400',
      checksDone: 1,
      intervalMinutes: 60,
      now,
    });
    expect(db.errands[0]).toMatchObject({
      state: 'watching',
      baseline: 'Tarifa: USD 3.400',
      checks_done: 2,
      next_check_at: new Date(now + 3_600_000).toISOString(),
    });
  });
});
