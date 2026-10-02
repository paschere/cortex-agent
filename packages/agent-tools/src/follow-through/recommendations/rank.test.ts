import { describe, expect, it } from 'vitest';
import {
  type KindHistory,
  MAX_KIND_WEIGHT,
  MIN_KIND_WEIGHT,
  kindStats,
  kindWeight,
  rankRecommendations,
} from './rank';
import type { RecommendationKind } from './shape';

const history = (
  kind: RecommendationKind,
  rows: Array<['followed' | 'not_followed', 'good' | 'none' | null]>,
): KindHistory[] => rows.map(([status, outcome]) => ({ kind, status, outcome }));

describe('la tasa de acierto por tipo', () => {
  it('cuenta sólo lo que ya tiene veredicto, y acierto = seguida y buen desenlace', () => {
    const stats = kindStats([
      ...history('fix_routine', [
        ['followed', 'good'],
        ['followed', 'none'],
        ['not_followed', 'good'],
      ]),
      { kind: 'fix_routine', status: 'open', outcome: null },
      { kind: 'setup_goals', status: 'followed', outcome: 'good' },
    ]);
    expect(stats.get('fix_routine')).toEqual({
      kind: 'fix_routine',
      evaluated: 3,
      followed: 2,
      ignored: 1,
      hits: 1,
    });
    // Lo que no se mide no aprende.
    expect(stats.has('setup_goals')).toBe(false);
  });

  it('con menos de tres evaluados pesa 1; después, siempre entre 0,7 y 1,3', () => {
    expect(kindWeight(undefined)).toBe(1);
    expect(
      kindWeight(
        kindStats(
          history('fix_routine', [
            ['followed', 'good'],
            ['followed', 'good'],
          ]),
        ).get('fix_routine'),
      ),
    ).toBe(1);
    const always = kindStats(
      history(
        'fix_routine',
        Array.from({ length: 30 }, () => ['followed', 'good'] as ['followed', 'good']),
      ),
    ).get('fix_routine');
    const never = kindStats(
      history(
        'fix_routine',
        Array.from({ length: 30 }, () => ['not_followed', null] as ['not_followed', null]),
      ),
    ).get('fix_routine');
    expect(kindWeight(always)).toBeGreaterThan(1.2);
    expect(kindWeight(always)).toBeLessThanOrEqual(MAX_KIND_WEIGHT);
    expect(kindWeight(never)).toBeLessThan(0.8);
    expect(kindWeight(never)).toBeGreaterThanOrEqual(MIN_KIND_WEIGHT);
  });
});

describe('el orden de las recomendaciones', () => {
  const c = (kind: RecommendationKind, severity: 'info' | 'warn' | 'critical' = 'info') => ({
    kind,
    severity,
    text: kind,
  });

  it('sin historia, el orden de urgencia de la fuente', () => {
    const out = rankRecommendations(
      [c('review_approvals'), c('fix_routine'), c('close_commitments'), c('decide_cases')],
      new Map(),
      3,
    );
    expect(out.map((x) => x.kind)).toEqual([
      'review_approvals',
      'fix_routine',
      'close_commitments',
    ]);
  });

  it('un tipo que aquí funciona sube; uno que se ignora baja — sin desaparecer de la lista entera', () => {
    const stats = kindStats([
      ...history(
        'close_commitments',
        Array.from({ length: 8 }, () => ['followed', 'good'] as ['followed', 'good']),
      ),
      ...history(
        'review_approvals',
        Array.from({ length: 8 }, () => ['not_followed', null] as ['not_followed', null]),
      ),
    ]);
    const out = rankRecommendations(
      [c('review_approvals'), c('fix_routine'), c('close_commitments'), c('decide_cases')],
      stats,
      4,
    );
    expect(out.map((x) => x.kind)).toEqual([
      'close_commitments',
      'fix_routine',
      'review_approvals',
      'decide_cases',
    ]);
  });

  it('la caja en rojo y la cartera vencida entran siempre, primero, aunque se ignoren', () => {
    const stats = kindStats([
      ...history(
        'cash_alert',
        Array.from({ length: 10 }, () => ['not_followed', null] as ['not_followed', null]),
      ),
      ...history(
        'collect_counterparty',
        Array.from({ length: 10 }, () => ['not_followed', null] as ['not_followed', null]),
      ),
      ...history(
        'fix_routine',
        Array.from({ length: 10 }, () => ['followed', 'good'] as ['followed', 'good']),
      ),
      ...history(
        'close_commitments',
        Array.from({ length: 10 }, () => ['followed', 'good'] as ['followed', 'good']),
      ),
    ]);
    const out = rankRecommendations(
      [
        c('cash_alert', 'critical'),
        c('collect_counterparty', 'warn'),
        c('close_commitments'),
        c('fix_routine'),
      ],
      stats,
      3,
    );
    expect(out.map((x) => x.kind)).toEqual([
      'cash_alert',
      'collect_counterparty',
      'close_commitments',
    ]);
  });
});
