import { describe, expect, it } from 'vitest';
import { type AutopilotSnapshot, collectAll, collectImpuestos } from '../autopilot/collectors';

/**
 * El piloto y los impuestos: «vence X en N días» al responsable, y una sola
 * línea cuando el impuesto y su vencimiento son la misma cosa.
 */

const today = '2026-10-05';
const owner = '00000000-0000-4000-8000-000000000001';

function snapshot(extra: Partial<AutopilotSnapshot> = {}): AutopilotSnapshot {
  return {
    today,
    taxObligations: [
      {
        id: 'o1',
        title: 'Retención en la fuente — septiembre 2026',
        authority: 'DIAN',
        dueOn: '2026-10-09',
        commitmentId: 'c1',
        needsConfirmation: false,
        ownerUserId: owner,
        ownerName: 'Laura (contadora)',
      },
      {
        id: 'o2',
        title: 'ICA Bogotá — bimestre 4 (jul–ago 2026)',
        authority: 'Secretaría de Hacienda de Bogotá',
        dueOn: '2026-10-09',
        commitmentId: null,
        needsConfirmation: true,
        ownerUserId: owner,
        ownerName: 'Laura (contadora)',
      },
      {
        id: 'o3',
        title: 'IVA bimestral — bimestre 5',
        authority: 'DIAN',
        dueOn: '2026-11-13',
        commitmentId: 'c3',
        needsConfirmation: false,
        ownerUserId: owner,
        ownerName: 'Laura (contadora)',
      },
    ],
    ...extra,
  };
}

describe('collectImpuestos', () => {
  it('recuerda al responsable lo que vence en los próximos días, con la duda si la hay', () => {
    const items = collectImpuestos(snapshot());
    expect(items).toHaveLength(2);
    expect(items[0]?.proposedAction?.toolId).toBe('autopilot.remind');
    expect(items[0]?.title).toContain('vence en 4 días');
    expect(items[0]?.dedupeKey).toBe('vence:c1:2026-10-09');
    expect(items[1]?.why).toContain('por confirmar con el contador');
    expect(items[1]?.dedupeKey).toBe('impuesto:o2:2026-10-09');
  });

  it('sin responsable sólo lo cuenta y pide elegir al contador', () => {
    const s = snapshot();
    for (const o of s.taxObligations ?? []) o.ownerUserId = null;
    const items = collectImpuestos(s);
    expect(items.every((i) => i.proposedAction === null)).toBe(true);
    expect(items[0]?.why).toContain('elige al contador');
  });

  it('el impuesto y su vencimiento salen una sola vez, con la frase del impuesto', () => {
    // El mismo compromiso con la misma fecha lleva la misma clave en los dos recolectores.
    const s = snapshot({
      today: '2026-10-08',
      commitments: [
        {
          id: 'c1',
          title: 'Retención en la fuente — septiembre 2026',
          kind: 'other',
          counterparty: 'DIAN',
          amountCop: null,
          dueOn: '2026-10-09',
          ownerUserId: owner,
          ownerName: 'Laura (contadora)',
        },
      ],
    });
    const { items } = collectAll(s, new Date('2026-10-08T12:00:00Z'));
    const about = items.filter((i) => i.dedupeKey === 'vence:c1:2026-10-09');
    expect(about).toHaveLength(1);
    expect(about[0]?.href).toBe('/impuestos');
  });
});
