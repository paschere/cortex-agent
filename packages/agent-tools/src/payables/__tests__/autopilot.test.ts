import { describe, expect, it } from 'vitest';
import { FIXTURE_DAY, FIXTURE_NOW, fixtureSettings } from '../../autopilot/autopilot.fixtures';
import { collectProveedores } from '../../autopilot/collectors';
import { buildPlan } from '../../autopilot/plan';

const supplierInvoices = {
  ids: [
    'aaaaaaaa-1111-4000-8000-000000000001',
    'bbbbbbbb-1111-4000-8000-000000000002',
    'cccccccc-1111-4000-8000-000000000003',
  ],
  count: 3,
  amount: 7_450_000,
  currency: 'COP',
  firstDue: '2026-10-14',
  firstLabel: 'Papelería El Cóndor FEPA-451',
  flagged: 1,
};

describe('piloto: facturas de proveedor por aprobar', () => {
  it('una sola pregunta con todas, que propone aprobarlas', () => {
    const [item] = collectProveedores({ today: FIXTURE_DAY, supplierInvoices });
    expect(item?.title).toBe(
      '3 facturas de proveedor por aprobar ($ 7.450.000), vence la primera el 14 oct (Papelería El Cóndor FEPA-451)',
    );
    expect(item?.proposedAction).toEqual({
      toolId: 'payables.approve',
      input: { invoices: supplierInvoices.ids },
    });
    expect(item?.why).toContain('Una trae un aviso');
    expect(item?.href).toBe('/pagar');
    expect(collectProveedores({ today: FIXTURE_DAY })).toEqual([]);
  });

  it('siempre pregunta: aprobar una deuda es de una persona, aun con mandato', () => {
    const plan = buildPlan(
      { today: FIXTURE_DAY, supplierInvoices },
      {
        settings: fixtureSettings({
          areaLevels: { ...fixtureSettings().areaLevels, pagos: 'hacer' },
        }),
        mandates: [],
        tool: (id) => (id === 'payables.approve' ? { id, requiresConfirmation: true } : undefined),
        now: FIXTURE_NOW,
      },
    );
    expect(plan.items.map((i) => i.decision)).toEqual(['ask']);
  });
});
