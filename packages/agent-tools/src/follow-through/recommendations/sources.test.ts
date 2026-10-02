import { describe, expect, it } from 'vitest';
import type { TeamWorkReport } from '../../work/types';
import { recommendationDedupeKey, subjectKeyOf } from './shape';
import { draftsFromForecastAlerts, draftsFromPulseFacts, draftsFromWorkSignals } from './sources';
import { workLoad } from './store';

describe('de cada fuente a una recomendación con sujeto', () => {
  it('las señales del equipo que piden algo; los reconocimientos no', () => {
    const report = {
      people: [{ person: { id: 'u-laura', name: 'Laura' } }],
      signals: [
        {
          kind: 'overloaded',
          personId: 'u-laura',
          workType: 'despacho',
          severity: 'critical',
          message: 'Laura tiene 15 despachos abiertos…',
          suggestion: 'Reasignar 6 a Andrés (tiene 3 despachos pendientes).',
          evidence: { person: 'Laura', openNow: 15, overdueNow: 6 },
        },
        {
          kind: 'improving',
          personId: 'u-laura',
          severity: 'info',
          message: 'Va mejor.',
          evidence: {},
        },
        {
          kind: 'unassigned_pile',
          workType: 'cobro',
          severity: 'warn',
          message: '7 cobros sin responsable',
          evidence: { workType: 'cobro', unassigned: 7 },
        },
      ],
    } as unknown as TeamWorkReport;
    const drafts = draftsFromWorkSignals(report);
    expect(drafts.map((d) => [d.kind, d.subjectKey, d.headline, d.baseline])).toEqual([
      [
        'rebalance_person',
        'u-laura',
        'repartir los despachos de Laura',
        { workType: 'despacho', open: 15, overdue: 6 },
      ],
      [
        'assign_unassigned',
        'cobro',
        'asignar los cobros sin responsable',
        { workType: 'cobro', count: 7 },
      ],
    ]);
    expect(drafts[0]?.text).toBe('Reasignar 6 a Andrés (tiene 3 despachos pendientes).');
  });

  it('la caja en rojo y quien paga tarde', () => {
    const drafts = draftsFromForecastAlerts([
      {
        kind: 'negative_cash',
        severity: 'critical',
        week: '2026-11-16',
        message: 'La caja queda en rojo…',
      },
      {
        kind: 'late_payer',
        severity: 'warn',
        week: null,
        message: 'Nexa suele pagar…',
        counterpartyName: 'Nexa S.A.S.',
      },
      { kind: 'big_outflow', severity: 'info', week: null, message: 'Pago grande…' },
    ]);
    expect(drafts.map((d) => [d.kind, d.subjectKey, d.severity])).toEqual([
      ['cash_alert', 'negative_cash', 'critical'],
      ['collect_counterparty', 'nexa', 'warn'],
    ]);
  });

  it('el pulso y la revisión comparten la identidad del «cóbrale a quien más debe»', () => {
    const [pulse] = draftsFromPulseFacts([
      { key: 'cartera_vencida', value: 4_250_000, display: '$ 4.250.000' },
      { key: 'top_deudores.0', value: 3_000_000, display: 'Nexa S.A.S. · FV-12 · $ 3.000.000' },
    ]);
    expect(pulse?.subjectKey).toBe(subjectKeyOf('NEXA sas'));
    expect(recommendationDedupeKey(pulse as never, '2026-09-28')).toBe(
      'collect_counterparty:nexa:2026-09-28',
    );
    expect(draftsFromPulseFacts([{ key: 'cartera_vencida', value: 0, display: '$ 0' }])).toEqual(
      [],
    );
  });

  it('la llave de un cliente ignora tildes, mayúsculas y razón social, pero no se come nombres', () => {
    expect(subjectKeyOf('Ferretería El Tornillo S.A.S.')).toBe('ferreteria el tornillo');
    expect(subjectKeyOf('Sánchez & Cía. Ltda')).toBe('sanchez');
    expect(subjectKeyOf('Europa SA')).toBe('europa');
  });
});

describe('la carga de hoy', () => {
  it('abiertos y vencidos por persona y por tipo; lo sin responsable aparte', () => {
    const base = { openedAt: '2026-09-01', source: { kind: 'manual' as const, ref: 'x' } };
    const load = workLoad(
      [
        {
          ...base,
          id: '1',
          assigneeId: 'u',
          workType: 'despacho',
          title: 'a',
          status: 'open',
          dueAt: '2026-09-30',
        },
        {
          ...base,
          id: '2',
          assigneeId: 'u',
          workType: 'despacho',
          title: 'b',
          status: 'open',
          dueAt: '2026-10-09',
        },
        {
          ...base,
          id: '3',
          assigneeId: 'u',
          workType: 'cobro',
          title: 'c',
          status: 'done',
          dueAt: '2026-09-01',
        },
        { ...base, id: '4', assigneeId: null, workType: 'cobro', title: 'd', status: 'open' },
      ],
      '2026-10-02',
    );
    expect(load.personLoad).toEqual({
      u: { open: 2, overdue: 1 },
      'u|despacho': { open: 2, overdue: 1 },
    });
    expect(load.unassigned).toEqual({ '*': 1, cobro: 1 });
  });
});
