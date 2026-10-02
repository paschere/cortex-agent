import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../work/types';
import { type DigestRecipient, digestTitle, dueDayOf, planOverdueDigests } from './digest';

// Viernes 2 de octubre de 2026, 08:00 en Bogotá.
const NOW = new Date('2026-10-02T13:00:00Z');
const TODAY = '2026-10-02';

const item = (
  id: string,
  assigneeId: string | null,
  dueAt: string | null,
  extra: Partial<WorkItem> = {},
): WorkItem => ({
  id,
  assigneeId,
  workType: 'despacho',
  title: `Despacho ${id}`,
  status: 'open',
  openedAt: '2026-09-01',
  dueAt,
  source: { kind: 'manual', ref: id },
  ...extra,
});

const person = (id: string, extra: Partial<DigestRecipient> = {}): DigestRecipient => ({
  id,
  name: id,
  timezone: 'America/Bogota',
  windowFrom: '07:00',
  windowTo: '21:00',
  ...extra,
});

const recipients = (...ps: DigestRecipient[]) => new Map(ps.map((p) => [p.id, p]));

describe('el resumen diario de lo vencido', () => {
  it('uno por persona, con lo más vencido primero y sólo lo suyo', () => {
    const plans = planOverdueDigests({
      items: [
        item('a', 'laura', '2026-09-30'),
        item('b', 'laura', '2026-09-20'),
        item('c', 'laura', '2026-10-05'),
        item('d', 'andres', '2026-10-01'),
        item('e', null, '2026-09-01'),
        item('f', 'laura', '2026-09-01', { status: 'done' }),
      ],
      recipients: recipients(person('laura'), person('andres')),
      today: TODAY,
      now: NOW,
      alreadySent: new Set(),
      enabled: true,
    });
    expect(plans.map((p) => [p.userId, p.count, p.lines.map((l) => l.itemId)])).toEqual([
      ['andres', 1, ['d']],
      ['laura', 2, ['b', 'a']],
    ]);
    const laura = plans[1];
    expect(laura?.title).toBe('Tienes 2 vencidos: Despacho b y Despacho a');
    expect(laura?.body).toContain('Despacho b — vencido hace 12 días');
    expect(plans[0]?.title).toBe('Tienes un vencido: Despacho d');
    expect(plans[0]?.body).toContain('venció ayer');
  });

  it('apagado por la empresa, en fin de semana o festivo, no sale nada', () => {
    const base = {
      items: [item('a', 'laura', '2026-09-30')],
      recipients: recipients(person('laura')),
      now: NOW,
      alreadySent: new Set<string>(),
    };
    expect(planOverdueDigests({ ...base, today: TODAY, enabled: false })).toEqual([]);
    expect(planOverdueDigests({ ...base, today: '2026-10-03', enabled: true })).toEqual([]);
    // 12 de octubre de 2026: Día de la Raza (lunes festivo).
    expect(planOverdueDigests({ ...base, today: '2026-10-12', enabled: true })).toEqual([]);
  });

  it('respeta la franja de cada quien, sus días fuera y lo ya enviado hoy', () => {
    const base = {
      items: [
        item('a', 'laura', '2026-09-30'),
        item('b', 'pedro', '2026-09-30'),
        item('c', 'sara', '2026-09-30'),
      ],
      today: TODAY,
      now: NOW,
      enabled: true,
    };
    const plans = planOverdueDigests({
      ...base,
      recipients: recipients(
        person('laura', { windowFrom: '09:00', windowTo: '18:00' }),
        person('pedro', { awayDays: [TODAY] }),
        person('sara'),
      ),
      alreadySent: new Set(['sara']),
    });
    expect(plans).toEqual([]);
  });

  it('quien ya no está en el directorio no recibe nada', () => {
    expect(
      planOverdueDigests({
        items: [item('a', 'fantasma', '2026-09-30')],
        recipients: recipients(),
        today: TODAY,
        now: NOW,
        alreadySent: new Set(),
        enabled: true,
      }),
    ).toEqual([]);
  });

  it('el título nombra dos y cuenta el resto', () => {
    expect(
      digestTitle(5, [
        { itemId: '1', title: 'Uno', daysOverdue: 3 },
        { itemId: '2', title: 'Dos', daysOverdue: 2 },
      ]),
    ).toBe('Tienes 5 vencidos: Uno, Dos y 3 más');
    expect(
      digestTitle(3, [
        { itemId: '1', title: 'Uno', daysOverdue: 3 },
        { itemId: '2', title: 'Dos', daysOverdue: 2 },
      ]),
    ).toBe('Tienes 3 vencidos: Uno, Dos y uno más');
  });

  it('el vencimiento se lee como día de Bogotá', () => {
    expect(dueDayOf('2026-09-30')).toBe('2026-09-30');
    expect(dueDayOf('2026-10-01T03:00:00Z')).toBe('2026-09-30');
    expect(dueDayOf('mañana')).toBeNull();
  });
});
