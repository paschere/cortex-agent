import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { accountingTableSpec } from '../accounting/tables';
import { SAFE_ACTION_CATALOG } from '../safe-actions/catalog';
import { computeNextRun } from '../schedule/recurrence';
import type { ToolContext } from '../types';
import { type ViewRow, type ViewSource, computeView, formatValue } from './compute';
import {
  type PulseFact,
  type PulseInventory,
  SUMMARY_BLOCK_ID,
  checkGrounding,
  composePulseSpec,
  fallbackSummary,
  pulseFacts,
} from './pulse';
import {
  EMPTY_ACTIVITY,
  NO_BASELINE_LINE,
  NO_PULSE_LINE,
  type PulseSnapshot,
  WEEK_BLOCK_ID,
  type WeeklyActivity,
  compareFacts,
  dailyDeltas,
  fallbackWeekly,
  isoWeekStart,
  pickBaseline,
  renderWeekly,
  snapshotFacts,
  weeklyFacts,
  weeklyRecommendations,
  weeklyRoutineRow,
} from './pulse-history';
import { readPulseSnapshots, savePulseSnapshot } from './pulse-snapshots';
import { type SummaryWriter, refreshViewSummary } from './pulse-tools';
import {
  type WeeklyWriter,
  runWeeklyReview,
  viewsScheduleWeeklyReview,
  viewsWeeklyReview,
  weeklyRoutineInput,
} from './pulse-weekly';
import { PLATFORM_SOURCES } from './sources';
import type { CatalogTracker, ViewSpec } from './spec';

// ---------------------------------------------------------------------------
// Piezas de prueba
// ---------------------------------------------------------------------------

/** El espacio de Intl (U+00A0) se lee como uno normal en las comparaciones. */
const plain = (s: string) => s.replace(/\s/g, ' ');

const siigo = { id: 'siigo', name: 'Siigo', paymentsLabel: 'Recibos de caja' };
const facturasSiigo = accountingTableSpec(siigo, 'invoices');
const pagosSiigo = accountingTableSpec(siigo, 'payments');
const carteraDef = PLATFORM_SOURCES.get('cortex.cartera') as NonNullable<
  ReturnType<typeof PLATFORM_SOURCES.get>
>;
const carteraTracker: CatalogTracker = {
  slug: carteraDef.id,
  name: carteraDef.name,
  fields: carteraDef.fields,
};

const EMPTY: PulseInventory['platform'] = {
  'cortex.ventas': 'empty',
  'cortex.pagos': 'empty',
  'cortex.cartera': 'data',
  'cortex.recuperado': 'empty',
  'cortex.metas': 'empty',
  'cortex.gestion': 'empty',
  'cortex.compromisos': 'empty',
  'cortex.vencimientos': 'empty',
  'cortex.rutinas': 'empty',
};
const ONLY_SIIGO: PulseInventory = {
  platform: EMPTY,
  accounting: [
    { provider: 'siigo', entity: 'facturas', slug: 'siigo_facturas', rows: 120 },
    { provider: 'siigo', entity: 'pagos', slug: 'siigo_pagos', rows: 40 },
  ],
};
const SPEC = composePulseSpec(ONLY_SIIGO).spec as ViewSpec;

const row = (id: string, values: Record<string, string | number>): ViewRow => ({
  id,
  label: id,
  values,
  created_at: '2026-09-01T15:00:00Z',
  updated_at: '2026-10-01T15:00:00Z',
});

const VIEW_ID = '22222222-2222-4222-8222-222222222222';
// Jueves 1 y viernes 2 de octubre de 2026, 10:00 a. m. en Bogotá.
const THU = new Date('2026-10-01T15:00:00Z');
const FRI = new Date('2026-10-02T15:00:00Z');

/**
 * El jueves: una factura vencida de $ 3.000.000 y dos pagos del miércoles.
 * El viernes: se venció otra de $ 1.250.000 y el jueves entraron cinco pagos.
 */
function sourcesOn(day: 'thu' | 'fri'): Map<string, ViewSource> {
  const pagos = [
    row('p1', { cliente: 'Acme', fecha: '2026-09-30', valor: 1_000_000 }),
    row('p2', { cliente: 'Acme', fecha: '2026-09-30', valor: 1_000_000 }),
  ];
  if (day === 'fri')
    for (let i = 0; i < 5; i++)
      pagos.push(row(`q${i}`, { cliente: 'Beta', fecha: '2026-10-01', valor: 400_000 }));
  const cartera = [
    row('c1', {
      numero: 'FV-099',
      cliente: 'Ferretería El Tornillo',
      vence: '2026-09-25',
      dias_mora: day === 'thu' ? 6 : 7,
      saldo: 3_000_000,
    }),
  ];
  if (day === 'fri')
    cartera.push(
      row('c2', {
        numero: 'FV-100',
        cliente: 'Transportes Andinos',
        vence: '2026-10-01',
        dias_mora: 1,
        saldo: 1_250_000,
      }),
    );
  return new Map<string, ViewSource>([
    [
      'siigo_facturas',
      {
        tracker: facturasSiigo,
        rows: [
          row('f1', {
            numero: 'FV-101',
            cliente: 'Acme',
            fecha: '2026-09-28',
            total: 4_500_000,
            estado: 'Por cobrar',
          }),
        ],
        truncated: false,
      },
    ],
    ['siigo_pagos', { tracker: pagosSiigo, rows: pagos, truncated: false }],
    ['cortex.cartera', { tracker: carteraTracker, rows: cartera, truncated: false }],
  ]);
}

function factsOn(day: 'thu' | 'fri'): PulseFact[] {
  const now = day === 'thu' ? THU : FRI;
  const sources = sourcesOn(day);
  return pulseFacts(SPEC, computeView(SPEC, sources, now), sources, now);
}

const get = (facts: PulseFact[], key: string) => facts.find((f) => f.key === key);

// ---------------------------------------------------------------------------
// Una base falsa: lo justo de PostgREST para vistas, historial, memoria y rutinas
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function fakeDb(store: Record<string, Row[]>): SupabaseClient {
  let seq = 0;
  class Query {
    private filters: Array<(r: Row) => boolean> = [];
    private mode: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
    private payload: Row = {};
    private conflict: string[] = [];
    private max: number | null = null;
    private sort: { col: string; asc: boolean } | null = null;
    private head = false;
    constructor(private table: string) {}
    private get rows() {
      store[this.table] ??= [];
      return store[this.table] as Row[];
    }
    select(_cols?: string, opts?: { head?: boolean }) {
      if (opts?.head) this.head = true;
      return this;
    }
    eq(c: string, v: unknown) {
      this.filters.push((r) => r[c] === v);
      return this;
    }
    neq(c: string, v: unknown) {
      this.filters.push((r) => r[c] !== v);
      return this;
    }
    is(c: string, v: unknown) {
      this.filters.push((r) => (v === null ? r[c] == null : r[c] === v));
      return this;
    }
    in(c: string, v: unknown[]) {
      this.filters.push((r) => v.includes(r[c]));
      return this;
    }
    gt(c: string, v: string) {
      this.filters.push((r) => String(r[c]) > v);
      return this;
    }
    gte(c: string, v: string) {
      this.filters.push((r) => String(r[c]) >= v);
      return this;
    }
    lt(c: string, v: string) {
      this.filters.push((r) => String(r[c]) < v);
      return this;
    }
    lte(c: string, v: string) {
      this.filters.push((r) => String(r[c]) <= v);
      return this;
    }
    order(col: string, opts?: { ascending?: boolean }) {
      this.sort = { col, asc: opts?.ascending !== false };
      return this;
    }
    limit(n: number) {
      this.max = n;
      return this;
    }
    insert(p: Row) {
      this.mode = 'insert';
      this.payload = p;
      return this;
    }
    update(p: Row) {
      this.mode = 'update';
      this.payload = p;
      return this;
    }
    upsert(p: Row, opts?: { onConflict?: string }) {
      this.mode = 'upsert';
      this.payload = p;
      // El handle con alcance pone organization_id; aquí no hay espacio.
      this.conflict = (opts?.onConflict ?? 'id').split(',').filter((c) => c !== 'organization_id');
      return this;
    }
    delete() {
      this.mode = 'delete';
      return this;
    }
    private run(): Row[] {
      if (this.mode === 'insert') {
        const created = { id: `id-${++seq}`, ...this.payload };
        this.rows.push(created);
        return [created];
      }
      if (this.mode === 'upsert') {
        const found = this.rows.find((r) => this.conflict.every((c) => r[c] === this.payload[c]));
        if (found) {
          Object.assign(found, this.payload);
          return [found];
        }
        const created = { id: `id-${++seq}`, ...this.payload };
        this.rows.push(created);
        return [created];
      }
      let found = this.rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.mode === 'delete') {
        store[this.table] = this.rows.filter((r) => !found.includes(r));
        return found;
      }
      if (this.mode === 'update') for (const r of found) Object.assign(r, this.payload);
      if (this.sort) {
        const { col, asc } = this.sort;
        found = [...found].sort((a, b) =>
          String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : asc ? 1 : -1,
        );
      }
      return this.max === null ? found : found.slice(0, this.max);
    }
    maybeSingle() {
      return Promise.resolve({ data: this.run()[0] ?? null, error: null });
    }
    single() {
      return this.maybeSingle();
    }
    // biome-ignore lint/suspicious/noThenProperty: el builder de PostgREST se espera con await.
    then(
      ok?: (v: { data: Row[] | null; count: number; error: null }) => unknown,
      ko?: (e: unknown) => unknown,
    ): Promise<unknown> {
      const data = this.run();
      return Promise.resolve({
        data: this.head ? null : data,
        count: data.length,
        error: null,
      }).then(ok, ko);
    }
  }
  return { from: (t: string) => new Query(t) } as unknown as SupabaseClient;
}

function pulseStore(visibility: 'workspace' | 'link' = 'workspace'): Record<string, Row[]> {
  return {
    custom_views: [
      {
        id: VIEW_ID,
        slug: 'pulso_empresa',
        name: 'Pulso de la empresa',
        description: '',
        spec: SPEC,
        version: 1,
        visibility,
        share_token: visibility === 'workspace' ? null : 'x'.repeat(32),
        share_expires_at: null,
        share_views: 0,
        pinned: false,
        created_by: 'u-1',
        updated_by: 'u-1',
        created_at: '2026-09-01T12:00:00Z',
        updated_at: '2026-09-01T12:00:00Z',
        archived_at: null,
      },
    ],
    custom_view_versions: [],
    pulse_snapshots: [],
  };
}

// ---------------------------------------------------------------------------
// 1. La memoria: una fila por vista y día
// ---------------------------------------------------------------------------

describe('las cifras de cada día se guardan una vez por vista y día', () => {
  it('el mismo día pisa la fila; otro día agrega otra; lo derivado no se guarda', async () => {
    const store = pulseStore();
    const db = fakeDb(store);
    const thu = factsOn('thu');
    await savePulseSnapshot(db, { viewId: VIEW_ID, day: '2026-10-01', facts: thu });
    await savePulseSnapshot(db, {
      viewId: VIEW_ID,
      day: '2026-10-01',
      facts: [...thu, { key: 'cartera_vencida.delta', label: 'derivada', value: 1, display: '+1' }],
    });
    expect(store.pulse_snapshots).toHaveLength(1);
    const saved = store.pulse_snapshots?.[0]?.facts as PulseFact[];
    expect(saved.some((f) => f.key.endsWith('.delta'))).toBe(false);
    expect(get(saved, 'cartera_vencida')).toMatchObject({
      value: 3_000_000,
      format: 'money',
      goodWhen: 'down',
    });
    expect(get(saved, 'pagos_mes')?.period).toBe('month:2026-10');

    await savePulseSnapshot(db, { viewId: VIEW_ID, day: '2026-10-02', facts: factsOn('fri') });
    const back = await readPulseSnapshots(db, VIEW_ID, '2026-09-20', '2026-10-02');
    expect(back.map((s) => s.day)).toEqual(['2026-10-02', '2026-10-01']);
  });

  it('poda lo que tiene más de 400 días de esa vista, y nada de otra', async () => {
    const store = pulseStore();
    store.pulse_snapshots = [
      { view_id: VIEW_ID, day: '2025-08-27', facts: [] },
      { view_id: VIEW_ID, day: '2025-08-28', facts: [] },
      { view_id: 'otra', day: '2020-01-01', facts: [] },
    ];
    await savePulseSnapshot(fakeDb(store), {
      viewId: VIEW_ID,
      day: '2026-10-02',
      facts: factsOn('fri'),
    });
    // 2026-10-02 menos 400 días es 2025-08-28: ése se queda, el anterior no.
    expect(store.pulse_snapshots?.map((s) => s.day).sort()).toEqual([
      '2020-01-01',
      '2025-08-28',
      '2026-10-02',
    ]);
  });

  it('lo que vuelve de la base se lee sin confiar en su forma', () => {
    expect(snapshotFacts([{ key: 'x', label: 'X', value: Number.NaN, display: '—' }])).toEqual([
      { key: 'x', label: 'X', value: null, display: '—' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Las diferencias
// ---------------------------------------------------------------------------

describe('las diferencias contra el último día guardado', () => {
  const thu: PulseSnapshot = { day: '2026-10-01', facts: factsOn('thu') };
  const fri = factsOn('fri');

  it('resta las cifras de hoy y las de ayer, con la frase entera en la etiqueta', () => {
    const deltas = dailyDeltas(fri, thu, '2026-10-02');
    const cartera = get(deltas, 'cartera_vencida.delta');
    expect(cartera?.value).toBe(1_250_000);
    expect(plain(cartera?.label ?? '')).toBe(
      'Cartera vencida subió $ 1.250.000 desde ayer (de $ 3.000.000 a $ 4.250.000)',
    );
    expect(plain(cartera?.display ?? '')).toBe('+$ 1.250.000');
    expect(cartera?.goodWhen).toBe('down');

    // «Entraron 3 pagos más que ayer»: lo de ayer contra lo de anteayer.
    const payments = get(deltas, 'pagos_mes.ayer_registros.delta');
    expect(payments?.value).toBe(3);
    expect(payments?.label).toBe(
      'Pagos recibidos: ayer entraron 5 registros, 3 más que anteayer (2)',
    );
    // La misma cifra del mes (octubre los dos días) sí se resta.
    expect(get(deltas, 'pagos_mes.delta')?.value).toBe(2_000_000);
  });

  it('no resta lo del mes entre meses distintos, ni posiciones, ni lo que ya es comparación', () => {
    const sept: PulseSnapshot = {
      day: '2026-09-30',
      facts: thu.facts.map((f) => (f.period ? { ...f, period: 'month:2026-09' } : f)),
    };
    const deltas = dailyDeltas(fri, sept, '2026-10-02');
    const keys = deltas.map((d) => d.key);
    expect(keys).not.toContain('pagos_mes.delta');
    expect(keys).not.toContain('ventas_mes.delta');
    expect(keys).toContain('cartera_vencida.delta');
    expect(keys.some((k) => /\.\d+\.delta$/.test(k))).toBe(false);
    expect(keys.some((k) => /\.(anterior|cambio)\.delta$/.test(k))).toBe(false);
  });

  it('el lunes compara contra el viernes y no mezcla «ayer» con «anteayer»', () => {
    const friday: PulseSnapshot = { day: '2026-10-02', facts: fri };
    const deltas = dailyDeltas(factsOn('fri'), friday, '2026-10-05');
    expect(deltas.every((d) => !d.key.includes('.ayer'))).toBe(true);
    expect(get(deltas, 'cartera_vencida.delta')?.label).toBe(
      `Cartera vencida sigue en ${get(fri, 'cartera_vencida')?.display} desde el viernes`,
    );
  });

  it('elige el día guardado más cercano dentro de la ventana', () => {
    const s = (day: string): PulseSnapshot => ({ day, facts: thu.facts });
    expect(
      pickBaseline([s('2026-10-01'), s('2026-09-30')], '2026-10-02', { target: 1, min: 1, max: 4 })
        ?.day,
    ).toBe('2026-10-01');
    expect(pickBaseline([s('2026-10-02')], '2026-10-02', { target: 1, min: 1, max: 4 })).toBeNull();
    expect(
      pickBaseline([s('2026-09-27'), s('2026-09-28'), s('2026-09-23')], '2026-10-05', {
        target: 7,
        min: 5,
        max: 10,
      })?.day,
    ).toBe('2026-09-28');
  });
});

describe('la guarda acepta las diferencias porque son cifras', () => {
  const facts = [
    ...factsOn('fri'),
    ...dailyDeltas(factsOn('fri'), { day: '2026-10-01', facts: factsOn('thu') }, '2026-10-02'),
  ];

  it('«subió $ 1.250.000 desde ayer» y «3 pagos más» pasan; sin la memoria, no', () => {
    const text =
      '**Frente a ayer:** la cartera vencida subió $ 1.250.000 desde ayer y entraron 3 pagos más que anteayer.';
    expect(checkGrounding(text, facts, FRI)).toEqual({ ok: true, ungrounded: [] });
    const without = factsOn('fri');
    expect(checkGrounding(text, without, FRI).ok).toBe(false);
    // Una resta inventada sigue cayendo.
    expect(checkGrounding('La cartera subió $ 1.300.000.', facts, FRI).ok).toBe(false);
  });

  it('el resumen sin modelo cuenta la diferencia y pasa su propia guarda', () => {
    const bullets = fallbackSummary(facts);
    expect(plain(bullets[0] ?? '')).toContain(
      'cartera vencida subió $ 1.250.000 desde ayer (de $ 3.000.000 a $ 4.250.000)',
    );
    expect(checkGrounding(bullets.join('\n'), facts, FRI)).toEqual({ ok: true, ungrounded: [] });
  });
});

describe('el resumen del día guarda sus cifras y compara contra las de ayer', () => {
  it('el jueves guarda; el viernes el modelo recibe las diferencias', async () => {
    const store = pulseStore();
    const db = fakeDb(store);
    const seen: PulseFact[][] = [];
    const write = vi.fn<SummaryWriter>(async ({ facts }) => {
      seen.push(facts);
      return { bullets: ['**Frente a ayer:** sin novedades.'] };
    });
    const first = await refreshViewSummary(db, {
      view: 'pulso_empresa',
      userId: 'u-1',
      now: THU,
      write,
      load: async () => sourcesOn('thu'),
    });
    expect(first.status === 'written' && first.comparedWith).toBeNull();
    expect(first.status === 'written' && first.snapshotSaved).toBe(true);
    expect(seen[0]?.some((f) => f.key.endsWith('.delta'))).toBe(false);

    const second = await refreshViewSummary(db, {
      view: 'pulso_empresa',
      userId: 'u-1',
      now: FRI,
      write,
      load: async () => sourcesOn('fri'),
    });
    expect(second.status === 'written' && second.comparedWith).toBe('2026-10-01');
    expect(get(seen[1] ?? [], 'cartera_vencida.delta')?.value).toBe(1_250_000);
    expect(store.pulse_snapshots?.map((s) => s.day)).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('sin la tabla (migración sin aplicar) el resumen sale igual', async () => {
    const store = pulseStore();
    const base = fakeDb(store);
    const broken = {
      from: (t: string) => {
        if (t === 'pulse_snapshots') throw new Error('relation "pulse_snapshots" does not exist');
        return base.from(t);
      },
    } as unknown as SupabaseClient;
    const out = await refreshViewSummary(broken, {
      view: 'pulso_empresa',
      userId: 'u-1',
      now: FRI,
      write: async () => ({ bullets: ['**Para hoy:** revisar la cartera.'] }),
      load: async () => sourcesOn('fri'),
    });
    expect(out.status).toBe('written');
    expect(out.status === 'written' && out.snapshotSaved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. La semana
// ---------------------------------------------------------------------------

const money = (n: number) => formatValue(n, 'money');

function weekFacts(cartera: number, ventas: number, period = 'month:2026-10'): PulseFact[] {
  return [
    {
      key: 'ventas_mes',
      label: 'Ventas del mes',
      value: ventas,
      display: money(ventas),
      format: 'money',
      period,
      goodWhen: 'up',
    },
    {
      key: 'cartera_vencida',
      label: 'Cartera vencida',
      value: cartera,
      display: money(cartera),
      format: 'money',
      goodWhen: 'down',
    },
    {
      key: 'top_deudores.0',
      label: 'Quién debe más',
      value: null,
      display: `Ferretería El Tornillo · FV-099 · 25 sept · 7 · ${money(3_000_000)}`,
    },
    {
      key: 'top_deudores.total',
      label: 'Quién debe más: filas',
      value: 2,
      display: '2',
      format: 'number',
      goodWhen: 'down',
    },
  ];
}

const ACTIVITY: WeeklyActivity = {
  ...EMPTY_ACTIVITY,
  actionsSent: 4,
  actionsFailed: 0,
  receivableNotices: 0,
  commitmentNotices: 2,
  recoveredCop: 1_500_000,
  recoveredInvoices: 1,
  routineRuns: 12,
  routineErrors: 2,
  failingRoutines: [{ name: 'Cartera de los viernes', errors: 2 }],
  approvalsPending: 1,
  draftsPending: 3,
  tasksDone: 20,
  closures: 1,
  gaps: [],
};

// Lunes 19 de octubre de 2026, 7:30 a. m. en Bogotá: revisa del 12 al 18.
const MON = new Date('2026-10-19T12:30:00Z');

describe('la revisión semanal se arma con la memoria y lo que hizo Cortex', () => {
  it('con la semana anterior guardada: qué mejoró, qué empeoró y tres acciones', () => {
    const comp = weeklyFacts({
      today: '2026-10-19',
      from: '2026-10-12',
      to: '2026-10-18',
      current: weekFacts(4_250_000, 9_000_000),
      base: { day: '2026-10-12', facts: weekFacts(3_000_000, 4_500_000) },
      activity: ACTIVITY,
    });
    expect(comp.hasBaseline).toBe(true);
    expect(comp.span).toBe('del lunes 12 de octubre al domingo 18 de octubre');
    expect(comp.improved.map((f) => f.key)).toEqual(['ventas_mes.semana']);
    expect(comp.worsened.map((f) => f.key)).toEqual(['cartera_vencida.semana']);
    expect(plain(comp.worsened[0]?.label ?? '')).toBe(
      'Cartera vencida subió $ 1.250.000 frente a hace una semana (de $ 3.000.000 a $ 4.250.000)',
    );
    expect(plain(comp.improved[0]?.label ?? '')).toBe(
      'Ventas del mes subieron $ 4.500.000 frente a hace una semana (de $ 4.500.000 a $ 9.000.000)',
    );
    expect(get(comp.facts, 'ventas_mes.semana_pct')?.display).toBe('+100 %');

    const recs = weeklyRecommendations(comp.facts, comp, { hasPulse: true });
    expect(recs).toHaveLength(3);
    expect(plain(recs[0] ?? '')).toBe(
      'Cobra primero a Ferretería El Tornillo: es quien más debe ($ 3.000.000) de una cartera vencida de $ 4.250.000.',
    );
    // No mandó avisos de cartera esta semana: que se active.
    expect(recs[1]).toContain('/procesos');
    expect(recs[2]).toContain('/approvals');

    const draft = fallbackWeekly(comp, recs);
    const text = [...draft.improved, ...draft.worsened, ...draft.cortex, ...draft.next].join('\n');
    expect(checkGrounding(text, comp.facts, MON)).toEqual({ ok: true, ungrounded: [] });
    const md = renderWeekly(comp, draft, { today: '2026-10-19', hasPulse: true, fallback: true });
    expect(md).toContain('### Revisión semanal · del lunes 12 de octubre al domingo 18 de octubre');
    expect(md).toContain('**Lo que mejoró**');
    expect(md).toContain('**Lo que empeoró**');
    expect(plain(md)).toContain('Recuperó $ 1.500.000 en 1 factura');
    expect(md).toContain('Corrió 12 veces tus rutinas, 2 con error.');
    expect(md).toMatch(/\*\*Para esta semana\*\*\n1\. .+\n2\. .+\n3\. .+/);
  });

  it('la primera semana lo dice: aún no hay semana anterior', () => {
    const comp = weeklyFacts({
      today: '2026-10-19',
      from: '2026-10-12',
      to: '2026-10-18',
      current: weekFacts(4_250_000, 9_000_000),
      base: null,
      activity: ACTIVITY,
    });
    expect(comp.hasBaseline).toBe(false);
    expect(comp.improved).toEqual([]);
    expect(comp.facts.some((f) => f.key.endsWith('.semana'))).toBe(false);
    const recs = weeklyRecommendations(comp.facts, comp, { hasPulse: true });
    expect(recs.join(' ')).not.toContain('Deja corriendo'); // hay cosas más urgentes
    const md = renderWeekly(comp, fallbackWeekly(comp, recs), {
      today: '2026-10-19',
      hasPulse: true,
    });
    expect(md).toContain(NO_BASELINE_LINE);
    expect(md).not.toContain('**Lo que mejoró**');
    expect(md).toContain('**Lo que Cortex hizo por ti**');
  });

  it('sin pulso: lo que hizo Cortex y la invitación a armarlo', () => {
    const comp = weeklyFacts({
      today: '2026-10-19',
      from: '2026-10-12',
      to: '2026-10-18',
      current: null,
      base: null,
      activity: { ...EMPTY_ACTIVITY, failingRoutines: [], gaps: [] },
    });
    const recs = weeklyRecommendations(comp.facts, comp, { hasPulse: false });
    expect(recs).toEqual([expect.stringContaining('Arma el pulso de la empresa')]);
    const md = renderWeekly(comp, fallbackWeekly(comp, recs), {
      today: '2026-10-19',
      hasPulse: false,
      gaps: ['La plata recuperada'],
    });
    expect(md).toContain(NO_PULSE_LINE);
    expect(md).toContain('Esta semana Cortex no registró envíos');
    expect(md).toContain('_No pude leer: la plata recuperada._');
  });

  it('un mes nuevo no es una caída: las cifras del mes no se restan entre meses', () => {
    const comp = weeklyFacts({
      today: '2026-10-05',
      from: '2026-09-28',
      to: '2026-10-04',
      current: weekFacts(3_000_000, 500_000),
      base: { day: '2026-09-28', facts: weekFacts(3_000_000, 9_000_000, 'month:2026-09') },
      activity: ACTIVITY,
    });
    expect(comp.worsened.map((f) => f.key)).not.toContain('ventas_mes.semana');
  });
});

describe('la revisión se entrega una vez por semana', () => {
  const activity = async () => ACTIVITY;

  it('escribe el bloque «Semana» debajo del resumen, y no lo repite en la misma semana', async () => {
    const store = pulseStore();
    const db = fakeDb(store);
    // La semana anterior, guardada.
    store.pulse_snapshots?.push({
      view_id: VIEW_ID,
      day: '2026-09-25',
      facts: snapshotFacts(factsOn('thu')),
    });
    const write = vi.fn<WeeklyWriter>(async ({ recommendations, worsened }) => ({
      improved: [],
      worsened,
      cortex: ['Envió 4 correos y cobros que aprobaste.'],
      next: recommendations,
    }));
    const first = await runWeeklyReview(db, {
      userId: 'u-1',
      now: FRI,
      write,
      load: async () => sourcesOn('fri'),
      readActivity: activity,
    });
    expect(first.status).toBe('written');
    if (first.status !== 'written') return;
    expect(first.weekStart).toBe('2026-09-28');
    expect(first.hasBaseline).toBe(true);
    expect(first.fallback).toBe(false);
    expect(first.inView).toBe(true);
    expect(plain(first.markdown)).toContain(
      'Cartera vencida subió $ 1.250.000 frente a hace una semana',
    );
    const saved = store.custom_views?.[0] as { spec: ViewSpec };
    expect(saved.spec.blocks.map((b) => b.id).slice(0, 2)).toEqual([
      SUMMARY_BLOCK_ID,
      WEEK_BLOCK_ID,
    ]);
    expect(store.custom_view_versions?.map((v) => v.prompt)).toEqual([
      'Revisión semanal 2026-09-28',
    ]);
    // Hoy quedó guardado también.
    expect(store.pulse_snapshots?.map((s) => s.day)).toContain('2026-10-02');

    const again = await runWeeklyReview(db, {
      userId: 'u-1',
      now: new Date('2026-10-03T15:00:00Z'),
      write,
      load: async () => sourcesOn('fri'),
      readActivity: activity,
    });
    expect(again.status).toBe('already');
    expect(again.markdown).toBe(first.markdown);
    expect(write).toHaveBeenCalledTimes(1);

    // La semana siguiente, otra vez.
    const next = await runWeeklyReview(db, {
      userId: 'u-1',
      now: new Date('2026-10-05T12:30:00Z'),
      write,
      load: async () => sourcesOn('fri'),
      readActivity: activity,
    });
    expect(next.status).toBe('written');
    expect(store.custom_view_versions?.map((v) => v.prompt)).toEqual([
      'Revisión semanal 2026-09-28',
      'Revisión semanal 2026-10-05',
    ]);
  });

  it('si el modelo inventa dos veces, la escribe sólo con cifras', async () => {
    const write = vi.fn<WeeklyWriter>(async () => ({
      improved: ['Las ventas crecieron 37 %.'],
      worsened: [],
      cortex: ['Cortex mandó 77 avisos.'],
      next: ['Llama a 5 clientes.'],
    }));
    const out = await runWeeklyReview(fakeDb(pulseStore()), {
      userId: 'u-1',
      now: FRI,
      write,
      load: async () => sourcesOn('fri'),
      readActivity: activity,
    });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[0].rejected).toEqual(expect.arrayContaining(['77', '5']));
    expect(out.status === 'written' && out.fallback).toBe(true);
    expect(out.markdown).not.toContain('37 %');
    // Sin semana anterior guardada: lo dice.
    expect(out.markdown).toContain(NO_BASELINE_LINE);
  });

  it('una vista compartida afuera no recibe lo que hizo Cortex', async () => {
    const store = pulseStore('link');
    const out = await runWeeklyReview(fakeDb(store), {
      userId: 'u-1',
      now: FRI,
      write: async () => {
        throw new Error('timeout');
      },
      load: async () => sourcesOn('fri'),
      readActivity: activity,
    });
    expect(out.status === 'written' && out.inView).toBe(false);
    expect(store.custom_view_versions).toEqual([]);
  });

  it('sin pulso, la revisión sale igual con lo que hizo Cortex', async () => {
    const out = await runWeeklyReview(fakeDb({ custom_views: [] }), {
      userId: 'u-1',
      now: FRI,
      write: async () => {
        throw new Error('timeout');
      },
      readActivity: activity,
    });
    expect(out.status).toBe('written');
    expect(out.view).toBeNull();
    expect(out.markdown).toContain(NO_PULSE_LINE);
  });

  it('la guardia de repetición es por vista y semana ISO de Bogotá; «force» va sin guardia', () => {
    const policy = SAFE_ACTION_CATALOG['views.weekly_review'] as unknown as {
      key: (i: unknown) => unknown;
    };
    vi.useFakeTimers();
    try {
      // Domingo 4 de octubre, 11:30 p. m. en Bogotá (ya lunes en UTC): semana del 28.
      vi.setSystemTime(new Date('2026-10-05T04:30:00Z'));
      expect(policy.key({ view: 'pulso_empresa' })).toEqual({
        view: 'pulso_empresa',
        week: '2026-09-28',
      });
      vi.setSystemTime(new Date('2026-10-05T12:30:00Z'));
      expect(policy.key({})).toEqual({ view: 'pulso_empresa', week: '2026-10-05' });
      expect(policy.key({ force: true })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(isoWeekStart('2026-10-04')).toBe('2026-09-28');
    expect(isoWeekStart('2026-10-05')).toBe('2026-10-05');
  });
});

// ---------------------------------------------------------------------------
// 4. La rutina del lunes
// ---------------------------------------------------------------------------

describe('la rutina de la revisión semanal', () => {
  it('por defecto: lunes 7:30 a. m. en Bogotá, una herramienta fija sin confirmación', () => {
    const r = weeklyRoutineRow(
      { ref: VIEW_ID, name: 'Pulso de la empresa' },
      { userId: 'u-1', agentId: 'a-1' },
    );
    expect(r).toMatchObject({
      kind: 'tool',
      tool_id: 'views.weekly_review',
      tool_input: { view: VIEW_ID },
      schedule_kind: 'cron',
      cron: '30 7 * * 1',
      timezone: 'America/Bogota',
      allow_unattended_writes: false,
      notify_conversation: true,
      notify_email: false,
      name: 'Revisión semanal: Pulso de la empresa',
    });
    expect(viewsWeeklyReview.inputSchema.safeParse(r.tool_input).success).toBe(true);
    expect(viewsWeeklyReview.requiresConfirmation).toBeFalsy();
    // Viernes 2 de octubre → el lunes 5 a las 7:30 de Bogotá.
    expect(computeNextRun(r.cron, r.timezone, FRI).toISOString()).toBe('2026-10-05T12:30:00.000Z');
  });

  it('programarla pide confirmación y no la duplica: la segunda vez la cambia', async () => {
    expect(viewsScheduleWeeklyReview.requiresConfirmation).toBe(true);
    expect(weeklyRoutineInput.parse({})).toEqual({
      view: 'pulso_empresa',
      weekday: 1,
      hour: 7,
      minute: 30,
      timezone: 'America/Bogota',
      notifyEmail: false,
    });
    const store = { ...pulseStore(), scheduled_jobs: [] as Row[] };
    const ctx = { db: fakeDb(store), userId: 'u-1', agentId: 'a-1' } as unknown as ToolContext;
    const first = await viewsScheduleWeeklyReview.handler(weeklyRoutineInput.parse({}), ctx);
    expect(first.updated).toBe(false);
    expect(first.cron).toBe('30 7 * * 1');
    expect(store.scheduled_jobs).toHaveLength(1);
    expect(store.scheduled_jobs[0]).toMatchObject({
      tool_id: 'views.weekly_review',
      tool_input: { view: VIEW_ID },
    });
    const second = await viewsScheduleWeeklyReview.handler(
      weeklyRoutineInput.parse({ weekday: 5, hour: 17, minute: 0, notifyEmail: true }),
      ctx,
    );
    expect(second.updated).toBe(true);
    expect(store.scheduled_jobs).toHaveLength(1);
    expect(store.scheduled_jobs[0]).toMatchObject({ cron: '0 17 * * 5', notify_email: true });
    expect(second.markdown).toContain('los viernes a las 5:00 p. m.');
  });
});
