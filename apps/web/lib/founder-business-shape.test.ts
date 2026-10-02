import { describe, expect, it } from 'vitest';
import {
  type CompanyBusiness,
  actionCandidates,
  businessTotals,
  compactCop,
  companyStatus,
  initialsOf,
  inkOn,
  pulseHref,
  rankActionItems,
  safeBrandColor,
} from './founder-business-shape';
import type { ConsoleRow } from './founder-console-shape';

/**
 * «DÓNDE ACTUAR HOY» Y EL ESTADO EN PALABRAS.
 *
 * Lo que más importa: el orden (la plata grande y los procesos caídos antes
 * que una puesta en marcha a medias), que cada renglón abra ESA empresa, que
 * una empresa no se coma la lista entera, y que «sin dato» nunca se lea como
 * cero ni como «al día».
 */

const NOW = new Date('2026-10-02T15:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function row(id: string, patch: Partial<ConsoleRow> = {}): ConsoleRow {
  return {
    id,
    name: id,
    kind: 'company',
    role: 'owner',
    active: false,
    owned: true,
    groupId: null,
    pulse: {
      status: 'ready',
      approvals: 0,
      actions: 0,
      deadlines: 0,
      blocked: 0,
      pending: 0,
    },
    health: null,
    ...patch,
  };
}

function pulse(patch: Partial<ConsoleRow['pulse']>): ConsoleRow['pulse'] {
  return {
    status: 'ready',
    approvals: 0,
    actions: 0,
    deadlines: 0,
    blocked: 0,
    pending: 0,
    ...patch,
  };
}

function biz(id: string, patch: Partial<CompanyBusiness> = {}): CompanyBusiness {
  return {
    organizationId: id,
    risk: {
      total: 0,
      receivablesOverdue: 0,
      overdueInvoices: 0,
      paymentsOverdue: 0,
      paymentsDueSoon: 0,
      finesPending: 0,
      others: [],
    },
    recovered: { month: 0, monthInvoices: 0, total: 0, others: [] },
    sales: { month: 120_000_000, previous: 150_000_000, asOf: '2026-10-02' },
    failing: { routines: 0, syncs: 0, total: 0 },
    setup: { ready: 5, total: 5, percent: 100, next: null },
    oldestDecisionAt: null,
    pulseView: true,
    brand: null,
    ...patch,
  };
}

function risk(
  receivables: number,
  invoices: number,
  patch: Partial<NonNullable<CompanyBusiness['risk']>> = {},
) {
  return {
    total: receivables,
    receivablesOverdue: receivables,
    overdueInvoices: invoices,
    paymentsOverdue: 0,
    paymentsDueSoon: 0,
    finesPending: 0,
    others: [],
    ...patch,
  };
}

describe('compactCop', () => {
  it('lee millones con una coma decimal y miles sin decimales', () => {
    expect(compactCop(38_500_000)).toBe('$ 38,5 M');
    expect(compactCop(950_000)).toBe('$ 950 mil');
    expect(compactCop(1_200_000_000)).toBe('$ 1,2 mil M');
    expect(compactCop(0)).toBe('$ 0');
  });
});

describe('companyStatus', () => {
  it('al día cuando hay negocio y nada vencido ni caído', () => {
    expect(companyStatus(row('a'), biz('a'), NOW)).toEqual({
      tone: 'emerald',
      label: 'Al día',
      reasons: [],
    });
  });

  it('pide atención con cartera vencida y procesos con error, y dice por qué', () => {
    const status = companyStatus(
      row('a'),
      biz('a', { risk: risk(38_500_000, 7), failing: { routines: 1, syncs: 1, total: 2 } }),
      NOW,
    );
    expect(status.label).toBe('Pide atención');
    expect(status.tone).toBe('amber');
    expect(status.reasons).toEqual(['$ 38,5 M en cartera vencida', '2 procesos con error']);
  });

  it('un cobro del plan pendiente es rosa', () => {
    const status = companyStatus(
      row('a', {
        health: {
          status: 'ready',
          subscriptionStatus: 'past_due',
          answers: null,
        } as unknown as ConsoleRow['health'],
      }),
      biz('a'),
      NOW,
    );
    expect(status).toMatchObject({ tone: 'rose', label: 'Pide atención' });
  });

  it('decisiones recientes no alarman; las que esperan dos días o más sí', () => {
    const r = row('a', { pulse: pulse({ approvals: 3, actions: 1 }) });
    expect(companyStatus(r, biz('a', { oldestDecisionAt: daysAgo(0.5) }), NOW).label).toBe(
      'Al día',
    );
    const late = companyStatus(r, biz('a', { oldestDecisionAt: daysAgo(3) }), NOW);
    expect(late.label).toBe('Pide atención');
    expect(late.reasons).toEqual(['4 decisiones esperan hace 3 días']);
  });

  it('una empresa nueva sin cifras dice «Sin datos todavía», no «Al día»', () => {
    const status = companyStatus(
      row('nueva'),
      biz('nueva', {
        sales: null,
        pulseView: false,
        setup: { ready: 1, total: 5, percent: 20, next: 'Conecta tu correo' },
      }),
      NOW,
    );
    expect(status).toEqual({
      tone: 'neutral',
      label: 'Sin datos todavía',
      reasons: ['Puesta en marcha al 20 %'],
    });
  });

  it('sin lectura cuando ni el pulso ni el negocio respondieron', () => {
    const status = companyStatus(
      row('caida', { pulse: pulse({ status: 'unavailable' }) }),
      biz('caida', { risk: null, recovered: null, failing: null, setup: null, sales: null }),
      NOW,
    );
    expect(status.label).toBe('Sin lectura');
  });

  it('una cifra sin dato no se lee como cero ni como problema', () => {
    const status = companyStatus(row('a'), biz('a', { risk: null, failing: null }), NOW);
    expect(status.label).toBe('Al día');
  });
});

describe('rankActionItems', () => {
  const andes = row('andes', { name: 'Transportes Andinos' });
  const test = row('test', { name: 'Test' });
  const cargo = row('cargo', { name: 'Andes Cargo', pulse: pulse({ approvals: 4 }) });
  const nueva = row('nueva', { name: 'Nueva' });

  const entries = [
    { row: andes, business: biz('andes', { risk: risk(38_500_000, 7) }) },
    { row: test, business: biz('test', { failing: { routines: 2, syncs: 0, total: 2 } }) },
    { row: cargo, business: biz('cargo', { oldestDecisionAt: daysAgo(3) }) },
    {
      row: nueva,
      business: biz('nueva', {
        sales: null,
        setup: { ready: 1, total: 5, percent: 20, next: 'Conecta tu correo' },
      }),
    },
  ];

  it('ordena lo que más pesa primero y lo dice como lo diría una persona', () => {
    const items = rankActionItems(entries, { now: NOW });
    expect(items.map((i) => [i.companyName, i.text])).toEqual([
      ['Transportes Andinos', '$ 38,5 M vencidos, 7 facturas'],
      ['Test', '2 procesos fallando'],
      ['Andes Cargo', '4 decisiones esperando hace 3 días'],
      ['Nueva', 'puesta en marcha al 20 % · sigue: conecta tu correo'],
    ]);
  });

  it('cada renglón abre ESA empresa con ?workspace=', () => {
    const [first] = rankActionItems(entries, { now: NOW });
    expect(first?.href).toBe('/payments?workspace=andes');
    expect(first?.path).toBe('/payments');
    expect(first?.companyId).toBe('andes');
  });

  it('a lo sumo cinco, y como mucho dos por empresa mientras haya otras', () => {
    const noisy = row('noisy', {
      name: 'Ruidosa',
      pulse: pulse({ approvals: 3, deadlines: 4, blocked: 2 }),
    });
    const items = rankActionItems(
      [
        {
          row: noisy,
          business: biz('noisy', {
            risk: risk(90_000_000, 12, { paymentsOverdue: 5_000_000 }),
            failing: { routines: 3, syncs: 0, total: 3 },
          }),
        },
        ...entries,
      ],
      { now: NOW },
    );
    expect(items).toHaveLength(5);
    expect(items.filter((i) => i.companyId === 'noisy')).toHaveLength(2);
  });

  it('rellena con la misma empresa cuando es la única con algo', () => {
    const noisy = row('noisy', { pulse: pulse({ approvals: 3, deadlines: 4, blocked: 2 }) });
    const items = rankActionItems(
      [{ row: noisy, business: biz('noisy', { risk: risk(9_000_000, 2) }) }],
      { now: NOW },
    );
    expect(items.length).toBe(4);
    expect(new Set(items.map((i) => i.companyId))).toEqual(new Set(['noisy']));
  });

  it('el espacio personal nunca entra; una empresa ajena sólo con sus pendientes', () => {
    const personal = row('personal:yo', {
      kind: 'personal',
      owned: false,
      pulse: pulse({ approvals: 9 }),
    });
    const managed = row('ajena', {
      name: 'Ajena',
      owned: false,
      role: 'admin',
      pulse: pulse({ blocked: 1 }),
    });
    const items = rankActionItems(
      [
        { row: personal, business: undefined },
        { row: managed, business: undefined },
      ],
      { now: NOW },
    );
    expect(items.map((i) => [i.companyId, i.kind])).toEqual([['ajena', 'blocked']]);
  });

  it('sin cifras de negocio no inventa plata: sólo lo que sí se leyó', () => {
    const items = actionCandidates(
      row('a', { pulse: pulse({ approvals: 1 }) }),
      biz('a', { risk: null, failing: null, setup: null }),
      NOW,
    );
    expect(items.map((i) => i.kind)).toEqual(['decisions']);
  });

  it('un cobro del plan pendiente va antes que cualquier cartera', () => {
    const billing = row('b', {
      name: 'Billing',
      health: {
        status: 'ready',
        subscriptionStatus: 'past_due',
        answers: null,
      } as unknown as ConsoleRow['health'],
    });
    const items = rankActionItems(
      [
        { row: billing, business: biz('b') },
        { row: andes, business: biz('andes', { risk: risk(500_000_000, 40) }) },
      ],
      { now: NOW },
    );
    expect(items[0]?.kind).toBe('billing');
    expect(items[0]?.href).toBe('/plan?workspace=b');
  });

  it('un pago que vence esta semana no tapa decisiones que llevan días esperando', () => {
    const items = rankActionItems(
      [
        {
          row: row('x', { name: 'X', pulse: pulse({ approvals: 2 }) }),
          business: biz('x', {
            oldestDecisionAt: daysAgo(3),
            risk: risk(0, 0, { total: 20_000_000, paymentsDueSoon: 20_000_000 }),
          }),
        },
      ],
      { now: NOW },
    );
    expect(items.map((i) => i.kind)).toEqual(['decisions', 'payments']);
    expect(items[1]?.text).toBe('$ 20 M por pagar esta semana');
  });

  it('es estable: mismo puntaje, orden por nombre', () => {
    const a = row('a', { name: 'Beta', pulse: pulse({ blocked: 1 }) });
    const b = row('b', { name: 'Alfa', pulse: pulse({ blocked: 1 }) });
    const items = rankActionItems(
      [
        { row: a, business: biz('a') },
        { row: b, business: biz('b') },
      ],
      { now: NOW },
    );
    expect(items.map((i) => i.companyName)).toEqual(['Alfa', 'Beta']);
  });
});

describe('businessTotals', () => {
  it('suma pesos de empresas propias, separa otras monedas y cuenta las que faltan', () => {
    const rows = [
      row('a', { pulse: pulse({ approvals: 2 }) }),
      row('b', { pulse: pulse({ actions: 1 }) }),
      row('c'),
      row('ajena', { owned: false, role: 'admin', pulse: pulse({ approvals: 5 }) }),
    ];
    const totals = businessTotals(
      rows,
      {
        a: biz('a', {
          risk: risk(10_000_000, 2, {
            others: [{ currency: 'USD', amount: 1200, invoices: 1 }],
          }),
          recovered: { month: 3_000_000, monthInvoices: 2, total: 9_000_000, others: [] },
        }),
        b: biz('b', { failing: { routines: 1, syncs: 1, total: 2 } }),
        c: biz('c', { risk: null, recovered: null, failing: null }),
      },
      NOW,
    );
    expect(totals).toMatchObject({
      owned: 3,
      riskCop: 10_000_000,
      riskOthers: [{ currency: 'USD', amount: 1200 }],
      riskMissing: 1,
      recoveredCop: 3_000_000,
      recoveredMissing: 1,
      decisions: 8,
      failing: 2,
      failingMissing: 1,
      attention: 2,
    });
  });
});

describe('marca y enlaces', () => {
  it('iniciales sin artículos ni sociedad', () => {
    expect(initialsOf('Transportes Andinos S.A.S.')).toBe('TA');
    expect(initialsOf('La Bodega del Norte')).toBe('BN');
    expect(initialsOf('Zeta')).toBe('Z');
  });

  it('sólo colores hexadecimales llegan al estilo', () => {
    expect(safeBrandColor('#0f766e')).toBe('#0f766e');
    expect(safeBrandColor('red; background:url(x)')).toBeNull();
    expect(safeBrandColor(null)).toBeNull();
  });

  it('tinta oscura sobre amarillo, blanca sobre verde petróleo', () => {
    expect(inkOn('#facc15')).toBe('#17171F');
    expect(inkOn('#0f766e')).toBe('#FFFFFF');
  });

  it('«Ver su pulso» abre la vista si existe; si no, le pregunta a Cortex', () => {
    expect(pulseHref('a', 'Andes', true)).toBe('/views/pulso_empresa?workspace=a');
    const ask = pulseHref('a', 'Andes', false);
    expect(ask.startsWith('/chat?prompt=')).toBe(true);
    expect(ask).toContain('workspace=a');
    expect(
      decodeURIComponent(new URL(ask, 'https://x').searchParams.get('prompt') ?? ''),
    ).toContain('Dime cómo va la empresa Andes');
  });
});
