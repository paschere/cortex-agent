import { describe, expect, it } from 'vitest';
import { checkGrounding } from '../../views/pulse';
import { followUpSection, followUpSentence, followUpWhen } from './report';
import type { RecommendationRecord } from './shape';

// La revisión del lunes 5 de octubre cuenta lo recomendado el lunes anterior.
const TODAY = '2026-10-05';

const rec = (over: Partial<RecommendationRecord>): RecommendationRecord => ({
  id: 'r1',
  source: 'weekly_review',
  kind: 'collect_counterparty',
  subjectKind: 'counterparty',
  subjectKey: 'nexa',
  subjectLabel: 'Nexa',
  text: '',
  headline: 'cobrarle primero a Nexa',
  suggestedAction: null,
  expectedEffect: 'collect',
  severity: 'warn',
  baseline: {},
  createdFor: 'u1',
  createdAt: '2026-09-28T12:30:00Z',
  status: 'open',
  followedAt: null,
  followEvidence: {},
  outcome: null,
  outcomeEvidence: {},
  evaluatedAt: null,
  ...over,
});

const nexa = rec({
  status: 'followed',
  followedAt: '2026-09-29T15:00:00Z',
  followEvidence: { what: 'collection_sent', at: '2026-09-29T15:00:00Z', count: 1 },
  outcome: 'good',
  outcomeEvidence: { what: 'payment', at: '2026-10-01', amount: 12_000_000, currency: 'COP' },
});

const laura = rec({
  id: 'r2',
  kind: 'rebalance_person',
  subjectKind: 'person',
  subjectKey: 'u-laura',
  subjectLabel: 'Laura',
  headline: 'repartir los despachos de Laura',
  status: 'not_followed',
  outcome: 'none',
  outcomeEvidence: { what: 'count', from: 15, to: 15 },
});

describe('«Lo que recomendé y qué pasó»', () => {
  it('cobro enviado y pago: «se envió el cobro el martes y pagó $ 12.000.000 el jueves»', () => {
    const s = followUpSentence(nexa, TODAY);
    expect(s?.text.replace(/ /g, ' ')).toBe(
      'Recomendé cobrarle primero a Nexa: se envió el cobro el martes y pagó $ 12.000.000 el jueves.',
    );
  });

  it('no se hizo: «no se hizo; sigue con 15 abiertos»', () => {
    expect(followUpSentence(laura, TODAY)?.text).toBe(
      'Recomendé repartir los despachos de Laura: no se hizo; sigue con 15 abiertos.',
    );
  });

  it('no se cobró pero pagó igual: se dice «igual», nunca «gracias a»', () => {
    const s = followUpSentence(
      rec({
        status: 'not_followed',
        outcome: 'good',
        outcomeEvidence: { what: 'payment', at: '2026-10-02', amount: 500_000, currency: 'COP' },
      }),
      TODAY,
    );
    expect(s?.text).toMatch(/no se envió el cobro; igual pagó/);
    expect(s?.text).not.toMatch(/gracias/);
  });

  it('cada número de la sección está en sus cifras (la guarda de la revisión lo acepta)', () => {
    const section = followUpSection([laura, nexa], { today: TODAY });
    expect(section.lines).toHaveLength(2);
    const text = section.lines.join('\n');
    const check = checkGrounding(text, section.facts, new Date('2026-10-05T12:30:00Z'));
    expect(check.ungrounded).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('lo que tuvo desenlace va primero; lo recién hecho o sin medida no se cuenta', () => {
    const section = followUpSection(
      [
        laura,
        nexa,
        rec({ id: 'r3', status: 'open' }),
        rec({ id: 'r4', kind: 'setup_goals', status: 'unmeasurable' }),
      ],
      { today: TODAY },
    );
    expect(section.ids).toEqual(['r1', 'r2']);
  });

  it('un mismo consejo repetido dos semanas se cuenta una vez', () => {
    const section = followUpSection(
      [nexa, { ...nexa, id: 'otra', createdAt: '2026-09-21T12:30:00Z' }],
      { today: TODAY },
    );
    expect(section.lines).toHaveLength(1);
  });

  it('los días se dicen por su nombre, sin números', () => {
    expect(followUpWhen('2026-10-05T14:00:00Z', TODAY)).toBe('hoy');
    expect(followUpWhen('2026-10-04', TODAY)).toBe('ayer');
    expect(followUpWhen('2026-10-01', TODAY)).toBe('el jueves');
    expect(followUpWhen('2026-09-29', TODAY)).toBe('el martes');
    expect(followUpWhen('2026-09-24', TODAY)).toBe('el jueves de la semana pasada');
    expect(followUpWhen('2026-09-01', TODAY)).toBe('hace semanas');
  });
});

describe('la concordancia', () => {
  it('lo de la empresa va en plural; lo de una persona, en singular', () => {
    const commitments = rec({
      id: 'c',
      kind: 'close_commitments',
      subjectKind: 'company',
      subjectKey: 'close_commitments',
      headline: 'cerrar o reprogramar los compromisos vencidos',
      status: 'followed',
      outcome: 'good',
      outcomeEvidence: { what: 'count', from: 6, to: 2 },
    });
    expect(followUpSentence(commitments, TODAY)?.text).toBe(
      'Recomendé cerrar o reprogramar los compromisos vencidos: bajaron de 6 a 2 compromisos vencidos.',
    );
    const sameCount = {
      ...commitments,
      status: 'not_followed' as const,
      outcome: 'none' as const,
      outcomeEvidence: { what: 'count' as const, from: 6, to: 6 },
    };
    expect(followUpSentence(sameCount, TODAY)?.text).toBe(
      'Recomendé cerrar o reprogramar los compromisos vencidos: no se hizo; siguen 6 compromisos vencidos.',
    );
  });
});
