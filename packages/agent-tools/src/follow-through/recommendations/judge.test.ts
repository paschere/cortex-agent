import { describe, expect, it } from 'vitest';
import { type FollowThroughEvidence, isSettledRecommendation, judgeRecommendation } from './judge';
import type { RecommendationRecord } from './shape';

// Lunes 28 de septiembre, 07:30 de Bogotá: la revisión recomendó.
const CREATED = '2026-09-28T12:30:00Z';

const rec = (over: Partial<RecommendationRecord>): RecommendationRecord => ({
  id: 'r1',
  source: 'weekly_review',
  kind: 'collect_counterparty',
  subjectKind: 'counterparty',
  subjectKey: 'nexa',
  subjectLabel: 'Nexa S.A.S.',
  text: 'Cobra primero a Nexa…',
  headline: 'cobrarle primero a Nexa',
  suggestedAction: null,
  expectedEffect: 'collect',
  severity: 'warn',
  baseline: {},
  createdFor: 'u1',
  createdAt: CREATED,
  status: 'open',
  followedAt: null,
  followEvidence: {},
  outcome: null,
  outcomeEvidence: {},
  evaluatedAt: null,
  ...over,
});

const ev = (over: Partial<FollowThroughEvidence>): FollowThroughEvidence => ({
  now: '2026-10-02T13:00:00Z',
  collections: [],
  inflows: [],
  reassignments: [],
  personLoad: {},
  unassigned: {},
  items: {},
  decisions: [],
  pendingApprovals: {},
  routines: {},
  routineEdits: [],
  overdueCommitments: null,
  openCases: null,
  cases: {},
  cashAlertKinds: null,
  ...over,
});

const collection = (over: Partial<NonNullable<FollowThroughEvidence['collections']>[number]>) => ({
  id: 'a1',
  state: 'approved',
  createdAt: '2026-09-29T14:00:00Z',
  executedAt: '2026-09-29T15:00:00Z',
  sentOk: true,
  haystack: 'factura fv 12 vencida pagos nexa com co nexa',
  ...over,
});

describe('cobrarle a un cliente', () => {
  it('se envió el cobro el martes y pagó el jueves: seguida, y buen desenlace', () => {
    const v = judgeRecommendation(
      rec({}),
      ev({
        collections: [collection({})],
        inflows: [
          { on: '2026-10-01', counterpartyKey: 'nexa', amount: 12_000_000, currency: 'COP' },
        ],
      }),
    );
    expect(v.status).toBe('followed');
    expect(v.followEvidence).toEqual({
      what: 'collection_sent',
      at: '2026-09-29T15:00:00Z',
      count: 1,
    });
    expect(v.outcome).toBe('good');
    expect(v.outcomeEvidence).toEqual({
      what: 'payment',
      at: '2026-10-01',
      amount: 12_000_000,
      currency: 'COP',
    });
  });

  it('el cobro redactado y sin aprobar está en curso', () => {
    const v = judgeRecommendation(
      rec({}),
      ev({ collections: [collection({ state: 'proposed', executedAt: null, sentOk: false })] }),
    );
    expect(v.status).toBe('in_progress');
    expect(v.outcome).toBe('pending');
  });

  it('sin cobro durante una semana: no seguida; y si pagó igual, se dice', () => {
    const v = judgeRecommendation(
      rec({}),
      ev({
        now: '2026-10-06T13:00:00Z',
        inflows: [
          { on: '2026-10-05', counterpartyKey: 'nexa', amount: 5_000_000, currency: 'COP' },
        ],
      }),
    );
    expect(v.status).toBe('not_followed');
    expect(v.outcome).toBe('good');
  });

  it('antes de la semana de gracia, sin nada todavía, sigue abierta', () => {
    expect(judgeRecommendation(rec({}), ev({})).status).toBe('open');
  });

  it('un cobro ANTERIOR a la recomendación no la cumple, ni un pago de otro cliente', () => {
    const v = judgeRecommendation(
      rec({}),
      ev({
        now: '2026-11-05T13:00:00Z',
        collections: [
          collection({ createdAt: '2026-09-20T10:00:00Z', executedAt: '2026-09-21T10:00:00Z' }),
        ],
        inflows: [
          { on: '2026-10-01', counterpartyKey: 'nexalogistica', amount: 3, currency: 'COP' },
        ],
      }),
    );
    expect(v.status).toBe('not_followed');
    expect(v.outcome).toBe('none');
  });

  it('un nombre de menos de tres letras no empareja nada', () => {
    const v = judgeRecommendation(
      rec({ subjectKey: 'ab' }),
      ev({ collections: [collection({ haystack: 'ab ab' })] }),
    );
    expect(v.status).toBe('open');
  });

  it('sin poder leer los cobros no se declara nada', () => {
    expect(judgeRecommendation(rec({}), ev({ collections: null })).status).toBe('open');
  });
});

describe('repartir la carga de una persona', () => {
  const laura = rec({
    kind: 'rebalance_person',
    subjectKind: 'person',
    subjectKey: 'u-laura',
    subjectLabel: 'Laura',
    baseline: { workType: 'despacho', open: 15, overdue: 6 },
  });

  it('nadie reasignó en una semana: no se hizo; sigue con 15 abiertos', () => {
    const v = judgeRecommendation(
      laura,
      ev({
        now: '2026-10-06T13:00:00Z',
        personLoad: { 'u-laura|despacho': { open: 15, overdue: 7 } },
      }),
    );
    expect(v.status).toBe('not_followed');
    expect(v.outcome).toBe('pending');
    expect(v.outcomeEvidence).toEqual({ what: 'count', from: 15, to: 15 });
  });

  it('se reasignó y bajó: seguida, y mejoró', () => {
    const v = judgeRecommendation(
      laura,
      ev({
        reassignments: ['2026-09-29T16:00:00Z'],
        personLoad: { 'u-laura|despacho': { open: 9, overdue: 2 } },
      }),
    );
    expect(v.status).toBe('followed');
    expect(v.outcome).toBe('good');
    expect(v.outcomeEvidence).toEqual({ what: 'count', from: 15, to: 9 });
  });

  it('se reasignó algo pero ella sigue igual: en curso', () => {
    const v = judgeRecommendation(
      laura,
      ev({
        reassignments: ['2026-09-29T16:00:00Z'],
        personLoad: { 'u-laura|despacho': { open: 15, overdue: 6 } },
      }),
    );
    expect(v.status).toBe('in_progress');
  });

  it('sacar los vencidos se cumple cuando bajan', () => {
    const v = judgeRecommendation(
      rec({
        kind: 'clear_overdue_person',
        subjectKind: 'person',
        subjectKey: 'u-laura',
        baseline: { overdue: 6 },
      }),
      ev({ personLoad: { 'u-laura': { open: 10, overdue: 2 } } }),
    );
    expect(v.status).toBe('followed');
    expect(v.outcomeEvidence).toEqual({ what: 'count', from: 6, to: 2 });
  });
});

describe('lo demás', () => {
  it('la alerta de caja que ya no aparece es buen desenlace', () => {
    const r = rec({
      kind: 'cash_alert',
      subjectKind: 'company',
      subjectKey: 'negative_cash',
      baseline: { alertKind: 'negative_cash' },
      severity: 'critical',
    });
    expect(judgeRecommendation(r, ev({ cashAlertKinds: [] })).outcome).toBe('good');
    expect(judgeRecommendation(r, ev({ cashAlertKinds: ['negative_cash'] })).outcome).toBe(
      'pending',
    );
    // Sin lectura de la caja, no se da por resuelta.
    expect(judgeRecommendation(r, ev({ cashAlertKinds: null })).outcome).toBe('pending');
  });

  it('lo que espera aprobación se mide sólo con las decisiones de quien leyó la revisión', () => {
    const r = rec({
      kind: 'review_approvals',
      subjectKind: 'company',
      subjectKey: 'review_approvals',
      baseline: { pending: 6 },
    });
    const v = judgeRecommendation(
      r,
      ev({
        decisions: [
          { at: '2026-09-29T10:00:00Z', userId: 'otro' },
          { at: '2026-09-30T10:00:00Z', userId: 'u1' },
        ],
        pendingApprovals: { u1: 2 },
      }),
    );
    expect(v.status).toBe('followed');
    expect(v.followEvidence.count).toBe(1);
    expect(v.outcomeEvidence).toEqual({ what: 'count', from: 6, to: 2 });
  });

  it('la rutina arreglada que no volvió a fallar', () => {
    const r = rec({ kind: 'fix_routine', subjectKind: 'routine', subjectKey: 'cartera diaria' });
    const v = judgeRecommendation(
      r,
      ev({
        routineEdits: ['2026-09-29T10:00:00Z'],
        routines: {
          'cartera diaria': { runs: ['2026-09-30T11:00:00Z', '2026-10-01T11:00:00Z'], errors: [] },
        },
      }),
    );
    expect(v.status).toBe('followed');
    expect(v.outcome).toBe('good');
  });

  it('los consejos de montaje no se miden ni cuentan', () => {
    expect(judgeRecommendation(rec({ kind: 'setup_goals' }), ev({})).status).toBe('unmeasurable');
  });

  it('pasados cuarenta días ya no se vuelve a mirar', () => {
    expect(isSettledRecommendation(rec({}), new Date('2026-11-10T00:00:00Z'))).toBe(true);
    expect(isSettledRecommendation(rec({}), new Date('2026-10-10T00:00:00Z'))).toBe(false);
  });
});
