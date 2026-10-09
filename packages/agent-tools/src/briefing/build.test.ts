import { describe, expect, it } from 'vitest';
import { type BriefingInput, buildBriefing } from './build';
import { type BriefingData, briefingInputFor } from './load';

const empty: BriefingInput = {
  today: '2026-10-08',
  firstName: 'Laura',
  scope: 'company',
  overdueCommitments: [],
  dueTodayCommitments: [],
  workOverdue: [],
  asks: [],
  anomalies: [],
};

const ask = (n: number, actionable = true) => ({
  itemId: `00000000-0000-4000-8000-00000000000${n}`,
  contentHash: `hash${n}`,
  title: `Reintentar la hoja ${n}`,
  why: `La hoja «Despachos ${n}» lleva 9 h sin filas nuevas (normalmente llegan cada 40 min). La última salió sin errores.`,
  actionable,
});

describe('tu día', () => {
  it('sin nada que decir no se manda', () => {
    const b = buildBriefing(empty);
    expect(b.send).toBe(false);
    expect(b.bullets).toEqual([]);
    expect(b.actions).toEqual([]);
  });

  it('cuenta lo importante en orden y con cifras, 3 a 6 frases', () => {
    const b = buildBriefing({
      ...empty,
      anomalies: [ask(1)],
      asks: [ask(2), ask(3)],
      overdueCommitments: [
        { title: 'SOAT camión', dueOn: '2026-09-26', counterparty: null, ownerName: 'Andrés' },
        { title: 'Pago ARL', dueOn: '2026-10-05', counterparty: null, ownerName: null },
      ],
      receivables: {
        overdueAmount: 15_550_000,
        invoices: 2,
        top: { who: 'Coltrans', amount: 12_400_000, daysOverdue: 47 },
      },
      dueTodayCommitments: [
        { title: 'IVA', dueOn: '2026-10-08', counterparty: null, ownerName: null },
      ],
    });
    expect(b.send).toBe(true);
    expect(b.bullets.length).toBeGreaterThanOrEqual(3);
    expect(b.bullets.length).toBeLessThanOrEqual(6);
    expect(b.bullets[0]).toContain('lleva 9 h sin filas nuevas');
    expect(b.bullets[1]).toContain('2 cosas esperando tu decisión');
    expect(b.bullets.join(' ')).toContain('SOAT camión');
    expect(b.bullets.join(' ')).toContain('$ 15.550.000');
    expect(b.title).toBe('Tu día, Laura: 5 cosas para mirar');
    expect(b.tone).toBe('warning');
  });

  it('los botones referencian cosas del piloto por id y huella, máximo dos, sólo las accionables', () => {
    const b = buildBriefing({
      ...empty,
      anomalies: [ask(1)],
      asks: [ask(2, false), ask(3), ask(4)],
    });
    expect(b.actions).toHaveLength(2);
    expect(b.actions.map((a) => a.itemId)).toEqual([ask(1).itemId, ask(3).itemId]);
    for (const a of b.actions) {
      expect(a.kind).toBe('autopilot_item');
      expect(a.contentHash).toMatch(/^hash/);
      // Nunca una herramienta suelta dentro del aviso.
      expect(Object.keys(a).sort()).toEqual(['contentHash', 'itemId', 'kind', 'title']);
    }
  });

  it('una persona sin administración sólo ve lo suyo y no recibe botones', () => {
    const data: BriefingData = {
      today: '2026-10-08',
      people: [],
      commitments: [
        {
          title: 'Mío',
          dueOn: '2026-10-01',
          counterparty: null,
          ownerName: 'Ana',
          ownerUserId: 'ana',
        },
        {
          title: 'De otro',
          dueOn: '2026-10-01',
          counterparty: null,
          ownerName: 'Luis',
          ownerUserId: 'luis',
        },
        {
          title: 'Mío hoy',
          dueOn: '2026-10-08',
          counterparty: null,
          ownerName: 'Ana',
          ownerUserId: 'ana',
        },
      ],
      workOverdue: [
        { title: 'Despachar', assigneeId: 'ana', daysOverdue: 3 },
        { title: 'Ajeno', assigneeId: 'luis', daysOverdue: 9 },
      ],
      receivables: { overdueAmount: 1, invoices: 1, top: null },
      asks: [ask(1)],
      anomalies: [ask(2)],
      errors: [],
    };
    const input = briefingInputFor(data, { id: 'ana', name: 'Ana María Ruiz' }, false);
    expect(input.scope).toBe('person');
    expect(input.firstName).toBe('Ana');
    const b = buildBriefing(input);
    const text = b.bullets.join(' ');
    expect(text).toContain('Mío');
    expect(text).not.toContain('De otro');
    expect(text).not.toContain('Ajeno');
    expect(text).not.toContain('cartera');
    expect(b.actions).toEqual([]);
  });

  it('el administrador ve la empresa completa', () => {
    const data: BriefingData = {
      today: '2026-10-08',
      people: [],
      commitments: [
        {
          title: 'De otro',
          dueOn: '2026-10-01',
          counterparty: null,
          ownerName: 'Luis',
          ownerUserId: 'luis',
        },
      ],
      workOverdue: [],
      receivables: undefined,
      asks: [ask(1)],
      anomalies: [],
      errors: [],
    };
    const b = buildBriefing(briefingInputFor(data, { id: 'dueña', name: 'Marta' }, true));
    expect(b.bullets.join(' ')).toContain('De otro');
    expect(b.actions).toHaveLength(1);
  });
});
