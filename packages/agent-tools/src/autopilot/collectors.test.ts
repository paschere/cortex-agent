import { describe, expect, it } from 'vitest';
import {
  FIXTURE_DAY,
  FIXTURE_NOW,
  LAURA_ID,
  OWNER_ID,
  fixtureSettings,
  fixtureSnapshot,
  fixtureTool,
} from './autopilot.fixtures';
import {
  type AutopilotSnapshot,
  collectAll,
  collectCobro,
  collectConciliacion,
  collectEquipo,
  collectFinanzas,
  collectGerencia,
  collectPagos,
  collectProcesos,
  collectVencimientos,
} from './collectors';
import { buildPlan } from './plan';
import { autopilotWeekday, runGate, settingsFromRow } from './settings';

describe('recolectores', () => {
  const s = fixtureSnapshot();

  it('cobro: la factura con contacto trae el correo listo; la que no, sólo se cuenta', () => {
    const items = collectCobro(s);
    expect(items).toHaveLength(2);
    const [coltrans, nexa] = items;
    expect(coltrans?.title).toBe('Cobrar $ 12.400.000 a Coltrans S.A.S.');
    expect(coltrans?.why).toContain('47 días de mora en la factura FE-1043');
    expect(coltrans?.effect).toBe('external_message');
    expect(coltrans?.proposedAction?.toolId).toBe('gmail.send_message');
    const input = coltrans?.proposedAction?.input as {
      to: string[];
      subject: string;
      body: string;
    };
    expect(input.to).toEqual(['cartera@coltrans.co']);
    expect(input.body).toContain('Buen día, Marta:');
    expect(input.body).toContain('20 de agosto de 2026');
    // Escalón de mora en la clave: el escalón 30 de FE-1043.
    expect(coltrans?.dedupeKey).toBe('cobro:document:aaaaaaaa-0000-4000-8000-000000000001:30');
    expect(nexa?.proposedAction).toBeNull();
    expect(nexa?.why).toContain('No tengo el correo de nadie de Nexa Logística');
  });

  it('pagos: un solo aviso, sin acción — nunca se mueve plata', () => {
    const [p] = collectPagos(s);
    expect(p?.proposedAction).toBeNull();
    expect(p?.why).toContain('$ 8.200.000 por pagar esta semana');
    expect(collectPagos({ today: FIXTURE_DAY })).toEqual([]);
  });

  it('conciliación: sólo lo que casa sin duda se propone atar; lo dudoso se cuenta', () => {
    const items = collectConciliacion(s);
    expect(items.map((i) => i.proposedAction?.toolId ?? null)).toEqual([
      'payments.apply_to_invoice',
      null,
    ]);
    expect(items[0]?.proposedAction?.input).toEqual({
      paymentId: 'bbbbbbbb-0000-4000-8000-000000000001',
      invoiceKind: 'accounting',
      invoiceId: 'dddddddd-0000-4000-8000-000000000077',
    });
    expect(items[0]?.risk).toBe('low');
    expect(items[1]?.title).toBe('1 pago del banco con factura por confirmar');
  });

  it('conciliación: dos pagos «seguros» contra la misma factura dejan de ser seguros', () => {
    const base = fixtureSnapshot().reconciliation?.[0];
    if (!base) throw new Error('fixture');
    const twin = { ...base, paymentId: 'bbbbbbbb-0000-4000-8000-000000000003' };
    const items = collectConciliacion({ today: FIXTURE_DAY, reconciliation: [base, twin] });
    expect(items.every((i) => i.risk === 'medium')).toBe(true);
    expect(items[0]?.why).toContain('hay que elegir');
  });

  it('finanzas: categorizar lo pendiente y contar las alertas de caja (no las informativas)', () => {
    const items = collectFinanzas(s);
    expect(items.map((i) => i.title)).toEqual([
      'Categorizar 14 movimientos del libro',
      'La caja queda apretada',
    ]);
    expect(items[1]?.why).toContain('$ 21.700.000');
    expect(items[1]?.proposedAction).toBeNull();
  });

  it('procesos: reintentar la carpeta que falló', () => {
    const [p] = collectProcesos(s);
    expect(p?.proposedAction).toEqual({
      toolId: 'trackers.retry_sync',
      input: { kind: 'drive_folder', syncId: 'eeeeeeee-0000-4000-8000-000000000001' },
    });
    expect(p?.why).toContain('Drive respondió 503');
  });

  it('procesos: un programa contable se reintenta con accounting.sync_now', () => {
    const [p] = collectProcesos({
      today: FIXTURE_DAY,
      syncs: [
        {
          kind: 'accounting',
          id: 'x',
          name: 'Siigo',
          provider: 'siigo',
          lastRunAt: null,
          lastError: 'Token vencido',
        },
      ],
    });
    expect(p?.proposedAction).toEqual({
      toolId: 'accounting.sync_now',
      input: { provider: 'siigo' },
    });
  });

  it('vencimientos: recordar lo que vence en 2 días; lo ya vencido sólo se cuenta', () => {
    const items = collectVencimientos(s);
    expect(items).toHaveLength(2);
    expect(items[0]?.proposedAction?.toolId).toBe('autopilot.remind');
    expect((items[0]?.proposedAction?.input as { person: string }).person).toBe(LAURA_ID);
    expect(items[0]?.title).toContain('vence en 2 días');
    expect(items[1]?.proposedAction).toBeNull();
    expect(items[1]?.title).toBe('1 compromiso vencido');
  });

  it('equipo: una reasignación concreta por receptor, con los ítems vencidos primero', () => {
    const [e] = collectEquipo(s);
    expect(e?.proposedAction).toEqual({
      toolId: 'work.assign',
      input: { itemIds: ['w1', 'w2', 'w3', 'w4'], person: 'Andrés Mejía' },
    });
    expect(e?.risk).toBe('medium');
  });

  it('gerencia: las aprobaciones paradas se cuentan en una línea', () => {
    const items = collectGerencia(s, FIXTURE_NOW);
    expect(items).toHaveLength(1);
    expect(items[0]?.proposedAction).toBeNull();
    expect(items[0]?.why).toContain('lleva 3 días');
    // Recién creada: todavía no está parada.
    expect(
      collectGerencia(
        {
          today: FIXTURE_DAY,
          staleApprovals: [
            {
              ...(s.staleApprovals?.[0] as NonNullable<
                AutopilotSnapshot['staleApprovals']
              >[number]),
              createdAt: FIXTURE_NOW.toISOString(),
            },
          ],
        },
        FIXTURE_NOW,
      ),
    ).toEqual([]);
  });

  it('un recolector que revienta no tumba a los demás', () => {
    const broken = fixtureSnapshot() as AutopilotSnapshot;
    Object.defineProperty(broken, 'overdueInvoices', {
      get() {
        throw new Error('cartera caída');
      },
    });
    const { items, errors } = collectAll(broken, FIXTURE_NOW);
    expect(errors).toEqual([{ source: 'cobro', message: 'cartera caída' }]);
    expect(items.some((i) => i.area === 'conciliacion')).toBe(true);
    expect(items.some((i) => i.area === 'cobro')).toBe(false);
  });

  it('una fotografía vacía no produce nada', () => {
    expect(collectAll({ today: FIXTURE_DAY }, FIXTURE_NOW)).toEqual({ items: [], errors: [] });
  });
});

describe('configuración', () => {
  it('nace apagada y con pagos en «avisar»', () => {
    const s = settingsFromRow(null);
    expect(s.enabled).toBe(false);
    expect(s.runHour).toBe(7);
    expect(s.runDays).toEqual([1, 2, 3, 4, 5]);
    expect(s.areaLevels.pagos).toBe('avisar');
  });

  it('pagos nunca queda en «hacer», venga de donde venga', () => {
    expect(settingsFromRow({ area_levels: { pagos: 'hacer' } }).areaLevels.pagos).toBe('proponer');
  });

  it('lo que no se entiende cae al valor por defecto, y los topes se recortan', () => {
    const s = settingsFromRow({
      enabled: 'yes' as unknown as boolean,
      run_hour: 99,
      max_external_messages: 900,
      area_levels: { cobro: 'todo', equipo: 'hacer' },
      run_days: [0, 9],
    });
    expect(s.enabled).toBe(false);
    expect(s.runHour).toBe(23);
    expect(s.maxExternalMessages).toBe(50);
    expect(s.areaLevels.cobro).toBe('proponer');
    expect(s.areaLevels.equipo).toBe('hacer');
    expect(s.runDays).toEqual([1, 2, 3, 4, 5]);
  });

  it('el día: apagado, día no configurado, festivo y día quieto', () => {
    expect(runGate(fixtureSettings({ enabled: false }), FIXTURE_DAY)).toEqual({
      run: false,
      reason: 'apagado',
    });
    expect(autopilotWeekday('2026-10-10')).toBe(6);
    expect(runGate(fixtureSettings(), '2026-10-10')).toEqual({
      run: false,
      reason: 'dia_no_configurado',
    });
    // 12 de octubre de 2026: Día de la Raza, festivo en lunes.
    expect(runGate(fixtureSettings(), '2026-10-12')).toEqual({ run: false, reason: 'festivo' });
    expect(runGate(fixtureSettings({ skipHolidays: false }), '2026-10-12')).toEqual({ run: true });
    expect(runGate(fixtureSettings({ quietDays: [FIXTURE_DAY] }), FIXTURE_DAY)).toEqual({
      run: false,
      reason: 'dia_quieto',
    });
    expect(runGate(fixtureSettings(), FIXTURE_DAY)).toEqual({ run: true });
  });
});

describe('el plan del día con la fotografía de Transportes Andinos', () => {
  it('hace lo interno, pregunta el cobro y la reasignación, cuenta el resto', () => {
    const plan = buildPlan(fixtureSnapshot(), {
      settings: fixtureSettings(),
      mandates: [],
      tool: fixtureTool,
      now: FIXTURE_NOW,
    });
    const by = (d: string) =>
      plan.items
        .filter((i) => i.decision === d)
        .map((i) => i.title)
        .sort();
    expect(by('do')).toEqual(
      [
        'Atar $ 4.500.000 de Nexa Logística a la factura FV-77',
        'Categorizar 14 movimientos del libro',
        'Recordarle a Laura Gómez: «SOAT camión TKL-482» vence en 2 días',
        'Reintentar la carpeta «Facturas de proveedores»',
      ].sort(),
    );
    expect(by('ask')).toEqual(
      [
        'Cobrar $ 12.400.000 a Coltrans S.A.S.',
        'Pasarle 4 despachos de Laura Gómez a Andrés Mejía',
      ].sort(),
    );
    expect(plan.counts).toEqual({ do: 4, ask: 2, tell: 6 });
    expect(OWNER_ID).toBeTruthy();
  });

  it('lo ya hecho otro día no se replantea; lo que espera decisión se cuenta aparte', () => {
    const plan = buildPlan(fixtureSnapshot(), {
      settings: fixtureSettings(),
      mandates: [],
      tool: fixtureTool,
      now: FIXTURE_NOW,
      history: {
        settled: new Set(['conciliar:bbbbbbbb-0000-4000-8000-000000000001']),
        openAsks: new Set(['cobro:document:aaaaaaaa-0000-4000-8000-000000000001:30']),
      },
    });
    expect(plan.suppressed).toBe(1);
    expect(plan.stillWaiting).toBe(1);
    expect(plan.items.some((i) => i.dedupeKey.startsWith('cobro:document'))).toBe(false);
  });
});
