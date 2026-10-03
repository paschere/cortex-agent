import { describe, expect, it } from 'vitest';
import type { PlanItem } from '../autopilot/types';
import { margins, quoteConversion, quoteOutcome, winLoss } from './analytics';
import type { QuoteIn, SaleIn } from './analytics';
import { collectClientesEnRiesgo, collectNegociosQuietos } from './autopilot-collect';
import { assessChurn, atRiskList, levelOf } from './churn';
import { weightedForecast } from './forecast';
import { matchQuoteToOpportunity, quoteStageRule, staleDeals } from './rules';
import {
  DEFAULT_STAGES,
  type OpportunityRow,
  effectiveProbability,
  npsBucket,
  npsScore,
  parseStages,
} from './shape';

const TODAY = '2026-10-03';
const stages = [...DEFAULT_STAGES];

function opp(over: Partial<OpportunityRow> = {}): OpportunityRow {
  return {
    id: 'o1',
    pipeline_id: null,
    client_id: 'c1',
    client_name: 'Nexa',
    title: 'Fletes Cali',
    value: 10_000_000,
    currency: 'COP',
    stage: 'nuevo',
    probability: null,
    expected_close: null,
    owner_user_id: 'u1',
    source: 'inbound',
    prospect_ref: null,
    next_step: null,
    next_step_due: null,
    lost_reason_kind: null,
    lost_reason: null,
    quote_id: null,
    order_id: null,
    notes: null,
    stage_changed_at: '2026-09-01T00:00:00Z',
    last_activity_at: '2026-09-30T00:00:00Z',
    won_at: null,
    lost_at: null,
    created_by: 'u1',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-30T00:00:00Z',
    ...over,
  };
}

/** Facturas cada `every` días desde `from` (n compras de `amount`). */
function buys(from: string, every: number, n: number, amount = 1_000_000) {
  const base = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    issuedOn: new Date(base + i * every * 86_400_000).toISOString().slice(0, 10),
    total: amount,
  }));
}

describe('el embudo', () => {
  it('una etapa sin ganada ni perdida no sirve: vuelve el embudo de la casa', () => {
    expect(parseStages([{ key: 'a', label: 'A', probability: 10 }])).toEqual([...DEFAULT_STAGES]);
    const custom = parseStages([
      { key: 'abierta', label: 'Abierta', probability: 30 },
      { key: 'cerrada', label: 'Cerrada', probability: 100, role: 'won' },
      { key: 'caida', label: 'Caída', probability: 0, role: 'lost' },
    ]);
    expect(custom.map((s) => s.key)).toEqual(['abierta', 'cerrada', 'caida']);
  });

  it('la probabilidad propia gana a la de la etapa', () => {
    expect(effectiveProbability({ stage: 'negociacion', probability: null }, stages)).toBe(70);
    expect(effectiveProbability({ stage: 'negociacion', probability: 90 }, stages)).toBe(90);
  });
});

describe('las reglas que siguen a la cotización', () => {
  const quote = {
    id: 'q1',
    label: 'COT-12',
    status: 'enviada',
    validUntil: '2026-10-20',
    orderId: null,
  };

  it('enviada mueve hacia adelante, nunca hacia atrás', () => {
    expect(quoteStageRule(opp({ stage: 'contactado' }), quote, stages, TODAY)?.stage).toBe(
      'cotizacion_enviada',
    );
    expect(quoteStageRule(opp({ stage: 'negociacion' }), quote, stages, TODAY)).toBeNull();
  });

  it('aceptada gana y ata el pedido', () => {
    const r = quoteStageRule(
      opp({ stage: 'negociacion' }),
      { ...quote, status: 'pedido', orderId: 'p1' },
      stages,
      TODAY,
    );
    expect(r).toMatchObject({ stage: 'ganada', orderId: 'p1', won: true });
  });

  it('vencida sin respuesta pone el negocio en riesgo, una sola vez', () => {
    const expired = { ...quote, validUntil: '2026-09-30' };
    expect(
      quoteStageRule(opp({ stage: 'cotizacion_enviada' }), expired, stages, TODAY)?.stage,
    ).toBe('en_riesgo');
    expect(quoteStageRule(opp({ stage: 'en_riesgo' }), expired, stages, TODAY)).toBeNull();
  });

  it('lo ganado a mano sólo recibe el pedido que le falta', () => {
    const r = quoteStageRule(
      opp({ stage: 'ganada' }),
      { ...quote, status: 'pedido', orderId: 'p9' },
      stages,
      TODAY,
    );
    expect(r).toMatchObject({ stage: null, orderId: 'p9' });
    expect(quoteStageRule(opp({ stage: 'perdida' }), quote, stages, TODAY)).toBeNull();
  });

  it('ata la cotización sola sólo si hay un único negocio abierto del cliente', () => {
    const one = [opp({ id: 'a' })];
    expect(matchQuoteToOpportunity({ clientId: 'c1', createdAt: '2026-10-01' }, one, stages)).toBe(
      'a',
    );
    const two = [opp({ id: 'a' }), opp({ id: 'b' })];
    expect(
      matchQuoteToOpportunity({ clientId: 'c1', createdAt: '2026-10-01' }, two, stages),
    ).toBeNull();
  });

  it('lo quieto sale con su porqué y qué hacer', () => {
    const list = staleDeals(
      [
        opp({ id: 'q', last_activity_at: '2026-09-01T00:00:00Z', stage: 'cotizacion_enviada' }),
        opp({ id: 'v', next_step: 'Mandar ficha técnica', next_step_due: '2026-10-01' }),
        opp({ id: 'ok' }),
        opp({ id: 'w', stage: 'ganada', last_activity_at: '2026-01-01T00:00:00Z' }),
      ],
      stages,
      TODAY,
    );
    expect(list.map((d) => d.id).sort()).toEqual(['q', 'v']);
    expect(list.find((d) => d.id === 'q')?.why).toContain('32 días');
    expect(list.find((d) => d.id === 'v')?.suggestion).toContain('Mandar ficha técnica');
  });
});

describe('el pronóstico ponderado', () => {
  it('reparte valor × probabilidad por mes; lo vencido al mes en curso; sin fecha aparte', () => {
    const f = weightedForecast(
      [
        opp({ value: 10_000_000, stage: 'negociacion', expected_close: '2026-11-15' }),
        opp({ value: 4_000_000, stage: 'cotizacion_enviada', expected_close: '2026-09-20' }),
        opp({ value: 1_000_000, stage: 'nuevo' }),
        opp({ value: 9_000_000, stage: 'ganada', expected_close: '2026-10-10' }),
        opp({ value: 500, currency: 'USD', stage: 'nuevo', expected_close: '2026-10-10' }),
      ],
      stages,
      { today: TODAY, months: 3 },
    );
    expect(f.months.map((m) => m.month)).toEqual(['2026-10', '2026-11', '2026-12']);
    expect(f.months[0]?.weighted).toBe(2_000_000);
    expect(f.months[1]?.weighted).toBe(7_000_000);
    expect(f.overdue.count).toBe(1);
    expect(f.undated).toMatchObject({ count: 1, weighted: 100_000 });
    expect(f.otherCurrencies).toEqual(['USD']);
  });
});

describe('el riesgo de perder un cliente', () => {
  it('un cliente al día y en contacto no tiene señales', () => {
    const a = assessChurn({
      clientId: 'c1',
      clientName: 'Nexa',
      today: TODAY,
      invoices: buys('2025-10-10', 30, 12),
      lastContactAt: '2026-09-28T10:00:00Z',
    });
    expect(a.level).toBe('bajo');
    expect(a.signals).toEqual([]);
    expect(a.action).toBeNull();
  });

  it('compra menos seguido que su propia historia y le facturan menos → riesgo con evidencia', () => {
    const a = assessChurn({
      clientId: 'c1',
      clientName: 'Nexa',
      today: TODAY,
      // Cada 20 días desde enero de 2025 hasta junio de 2026; nada desde entonces.
      invoices: buys('2025-01-05', 20, 27),
      lastContactAt: '2026-09-25T00:00:00Z',
    });
    expect(a.signals.map((s) => s.key)).toContain('frecuencia');
    expect(a.signals.map((s) => s.key)).toContain('facturacion');
    expect(a.level).toBe('alto');
    expect(a.signals.find((s) => s.key === 'frecuencia')?.evidence).toMatch(
      /Compraba cada 20 días/,
    );
    expect(a.action).toContain('Nexa');
  });

  it('un detractor y una queja pesan aunque las compras vayan bien', () => {
    const a = assessChurn({
      clientId: 'c1',
      clientName: 'Coltrans',
      today: TODAY,
      invoices: buys('2025-10-10', 30, 12),
      lastContactAt: '2026-09-28T00:00:00Z',
      nps: [{ at: '2026-09-10T00:00:00Z', score: 3, comment: 'Las entregas llegan tarde' }],
      escalations: [{ at: '2026-09-15T00:00:00Z', reason: 'Pidió hablar con una persona' }],
    });
    expect(a.signals.map((s) => s.key)).toEqual(['encuesta', 'quejas']);
    expect(a.level).toBe('alto');
    expect(a.signals[0]?.evidence).toContain('3/10');
    expect(a.action).toContain('3/10');
  });

  it('pagar cada vez más tarde y la mora vieja son señales; sin historia, se dice', () => {
    const a = assessChurn({
      clientId: 'c1',
      clientName: 'Nexa',
      today: TODAY,
      invoices: buys('2025-10-10', 30, 12),
      lastContactAt: '2026-09-28T00:00:00Z',
      paymentDays: { recent: { average: 62, sample: 4 }, prior: { average: 30, sample: 6 } },
      overdue: { amount: 5_000_000, maxDays: 75 },
    });
    expect(a.signals.map((s) => s.key).sort()).toEqual(['mora', 'pagos']);
    const thin = assessChurn({
      clientId: 'c2',
      clientName: 'Nuevo',
      today: TODAY,
      invoices: buys('2026-09-01', 10, 2),
      lastContactAt: null,
      paymentDays: { recent: null, prior: null },
    });
    expect(thin.gaps.length).toBeGreaterThan(0);
  });

  it('el silencio sólo cuenta si compró este año', () => {
    const quiet = assessChurn({
      clientId: 'c1',
      clientName: 'Nexa',
      today: TODAY,
      invoices: buys('2025-10-10', 30, 12),
      lastContactAt: '2026-06-01T00:00:00Z',
    });
    expect(quiet.signals.map((s) => s.key)).toContain('contacto');
    const gone = assessChurn({
      clientId: 'c2',
      clientName: 'Viejo',
      today: TODAY,
      invoices: buys('2023-01-01', 30, 5),
      lastContactAt: '2024-01-01T00:00:00Z',
    });
    expect(gone.signals.map((s) => s.key)).not.toContain('contacto');
  });

  it('niveles y orden de la lista', () => {
    expect(levelOf(50)).toBe('alto');
    expect(levelOf(25)).toBe('medio');
    expect(levelOf(24)).toBe('bajo');
    const list = atRiskList([
      {
        clientId: 'a',
        clientName: 'A',
        level: 'medio',
        score: 30,
        signals: [],
        action: null,
        revenue12m: 5,
        gaps: [],
      },
      {
        clientId: 'b',
        clientName: 'B',
        level: 'alto',
        score: 60,
        signals: [],
        action: null,
        revenue12m: 1,
        gaps: [],
      },
      {
        clientId: 'c',
        clientName: 'C',
        level: 'bajo',
        score: 0,
        signals: [],
        action: null,
        revenue12m: 9,
        gaps: [],
      },
    ]);
    expect(list.map((x) => x.clientId)).toEqual(['b', 'a']);
  });
});

describe('el análisis comercial', () => {
  const line = (description: string, base: number, productCode: string | null = null) => ({
    description,
    productCode,
    productRef: null,
    quantity: 2,
    unitPrice: base / 2,
    discountPct: 0,
    base,
  });
  const q = (over: Partial<QuoteIn>): QuoteIn => ({
    id: 'q',
    createdBy: 'u1',
    issueDate: '2026-09-01',
    status: 'enviada',
    validUntil: '2026-12-01',
    sentAt: '2026-09-01T00:00:00Z',
    acceptedAt: null,
    currency: 'COP',
    total: 1_000_000,
    lines: [line('Flete', 1_000_000, 'FL-1')],
    ...over,
  });

  it('la conversión cuenta ganadas sobre decididas; las abiertas aparte', () => {
    expect(quoteOutcome({ status: 'enviada', validUntil: '2026-09-01' }, TODAY)).toBe('lost');
    const r = quoteConversion(
      [
        q({ id: '1', status: 'aceptada', acceptedAt: '2026-09-05T00:00:00Z' }),
        q({ id: '2', status: 'pedido', createdBy: 'u2' }),
        q({ id: '3', status: 'rechazada' }),
        q({ id: '4', status: 'enviada' }),
        q({ id: '5', status: 'borrador' }),
      ],
      { today: TODAY, ownerName: (id) => (id === 'u1' ? 'Laura' : 'Andrés') },
    );
    expect(r.overall).toMatchObject({ won: 2, lost: 1, open: 1 });
    expect(r.overall.rate).toBeCloseTo(2 / 3);
    expect(r.byOwner.find((o) => o.label === 'Laura')?.rate).toBe(0.5);
    expect(r.byProduct[0]?.label).toBe('Flete');
  });

  it('ganadas y perdidas por razón, ciclo y ticket', () => {
    const w = winLoss(
      [
        opp({
          id: 'a',
          stage: 'ganada',
          won_at: '2026-09-21T00:00:00Z',
          created_at: '2026-09-01T00:00:00Z',
        }),
        opp({ id: 'b', stage: 'perdida', lost_reason_kind: 'precio', value: 3_000_000 }),
        opp({ id: 'c', stage: 'perdida' }),
        opp({ id: 'd', stage: 'negociacion' }),
      ],
      [
        q({
          sentAt: '2026-09-01T00:00:00Z',
          acceptedAt: '2026-09-11T00:00:00Z',
          status: 'aceptada',
        }),
      ],
      stages,
      TODAY,
    );
    expect(w.winRate).toBeCloseTo(1 / 3);
    expect(w.opportunityCycle.medianDays).toBe(20);
    expect(w.quoteCycle.medianDays).toBe(10);
    // Mismo número de pérdidas: primero la de más plata.
    expect(w.reasons.map((r) => r.kind)).toEqual(['sin_razon', 'precio']);
    expect(w.averageDeal).toBe(10_000_000);
  });

  it('márgenes sólo donde hay costo, y lo dice', () => {
    const sales: SaleIn[] = [
      {
        id: 's1',
        clientId: 'c1',
        clientName: 'Nexa',
        issueDate: '2026-09-01',
        currency: 'COP',
        lines: [line('Tornillo', 1_000, 'T-10'), line('Servicio', 3_000)],
      },
    ];
    const r = margins(sales, [{ sku: 't-10', sourceRef: null, name: 'Tornillo', cost: 300 }]);
    expect(r.totals.revenue).toBe(4_000);
    expect(r.totals.revenueWithCost).toBe(1_000);
    expect(r.totals.margin).toBeCloseTo(0.4);
    expect(r.totals.coverage).toBeCloseTo(0.25);
    expect(r.note).toBeNull();
    expect(margins(sales, []).note).toContain('costo');
  });
});

describe('la encuesta', () => {
  it('detractor, pasivo, promotor y el NPS', () => {
    expect([0, 6, 7, 8, 9, 10].map(npsBucket)).toEqual([
      'detractor',
      'detractor',
      'pasivo',
      'pasivo',
      'promotor',
      'promotor',
    ]);
    expect(npsScore([10, 9, 8, 3])).toBe(25);
    expect(npsScore([])).toBeNull();
  });
});

describe('el piloto', () => {
  it('lo quieto es una pregunta con la tarea lista; el riesgo sólo se cuenta', () => {
    const items: PlanItem[] = [
      ...collectNegociosQuietos(
        {
          stale: [
            {
              id: 'o1',
              title: 'Fletes Cali',
              clientName: 'Nexa',
              ownerName: 'Laura',
              value: 10_000_000,
              currency: 'COP',
              quietDays: 20,
              why: 'Sin actividad hace 20 días.',
              suggestion: 'Llama a Nexa.',
            },
          ],
          newlyAtRisk: [],
        },
        TODAY,
      ),
      ...collectClientesEnRiesgo({
        stale: [],
        newlyAtRisk: [
          {
            clientId: 'c1',
            clientName: 'Coltrans',
            level: 'alto',
            score: 55,
            evidence: ['En la encuesta calificó 3/10.'],
            action: 'Llama a Coltrans.',
            ownerName: null,
            revenue12m: 40_000_000,
          },
        ],
      }),
    ];
    expect(items[0]?.proposedAction).toMatchObject({
      toolId: 'crm.log_activity',
      input: { opportunity: 'o1', kind: 'task', dueOn: TODAY },
    });
    expect(items[0]?.dedupeKey).toBe('crm:quieto:o1');
    expect(items[1]?.proposedAction).toBeNull();
    expect(items[1]?.dedupeKey).toBe('crm:riesgo:c1:alto');
    expect(collectNegociosQuietos(undefined, TODAY)).toEqual([]);
  });
});
