import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { accountingTableSpec } from '../accounting/tables';
import { computeNextRun } from '../schedule/recurrence';
import { type ViewRow, type ViewSource, computeView } from './compute';
import {
  type PulseFact,
  type PulseInventory,
  SUMMARY_BLOCK_ID,
  checkGrounding,
  composePulseSpec,
  cronWeekdays,
  emptyPulseMessage,
  fallbackSummary,
  pulseFacts,
  pulseRoutineRow,
  summaryVersionPrompt,
  weekdaysPhrase,
} from './pulse';
import {
  type SummaryWriter,
  pulseRoutineInput,
  refreshViewSummary,
  viewsRefreshSummary,
  viewsSchedulePulse,
} from './pulse-tools';
import { PLATFORM_SOURCES } from './sources';
import { type CatalogTracker, type ViewSpec, checkSpecAgainst } from './spec';

// ---------------------------------------------------------------------------
// Piezas de prueba
// ---------------------------------------------------------------------------

const siigo = { id: 'siigo', name: 'Siigo', paymentsLabel: 'Recibos de caja' };
const facturasSiigo = accountingTableSpec(siigo, 'invoices');
const pagosSiigo = accountingTableSpec(siigo, 'payments');
const clientesSiigo = accountingTableSpec(siigo, 'customers');

/** El catálogo de verdad: las fuentes de la plataforma y las tablas de Siigo. */
const CATALOG: CatalogTracker[] = [
  ...[...PLATFORM_SOURCES.values()].map((s) => ({ slug: s.id, name: s.name, fields: s.fields })),
  ...[facturasSiigo, pagosSiigo, clientesSiigo].map((t) => ({
    slug: t.slug,
    name: t.name,
    fields: t.fields,
  })),
];

const EMPTY: PulseInventory['platform'] = {
  'cortex.ventas': 'empty',
  'cortex.pagos': 'empty',
  'cortex.cartera': 'empty',
  'cortex.recuperado': 'empty',
  'cortex.metas': 'empty',
  'cortex.gestion': 'empty',
  'cortex.compromisos': 'empty',
  'cortex.vencimientos': 'empty',
  'cortex.rutinas': 'empty',
};

const ONLY_SIIGO: PulseInventory = {
  // La cartera unificada ya trae las facturas vencidas de Siigo.
  platform: { ...EMPTY, 'cortex.cartera': 'data' },
  accounting: [
    { provider: 'siigo', entity: 'facturas', slug: 'siigo_facturas', rows: 120 },
    { provider: 'siigo', entity: 'pagos', slug: 'siigo_pagos', rows: 40 },
    { provider: 'siigo', entity: 'clientes', slug: 'siigo_clientes', rows: 30 },
  ],
};

const ids = (spec: ViewSpec | null) => spec?.blocks.map((b) => b.id) ?? [];
const block = (spec: ViewSpec | null, id: string) => spec?.blocks.find((b) => b.id === id);

// 10:00 a. m. en Bogotá del viernes 2 de octubre de 2026.
const NOW = new Date('2026-10-02T15:00:00Z');

const row = (id: string, label: string, values: Record<string, string | number>): ViewRow => ({
  id,
  label,
  values,
  created_at: '2026-09-01T15:00:00Z',
  updated_at: '2026-10-01T15:00:00Z',
});

function source(t: CatalogTracker, rows: ViewRow[]): ViewSource {
  return { tracker: t, rows, truncated: false };
}

const carteraDef = PLATFORM_SOURCES.get('cortex.cartera') as NonNullable<
  ReturnType<typeof PLATFORM_SOURCES.get>
>;

/** Lo que una empresa con Siigo tiene de verdad: facturas de dos meses, pagos y su cartera. */
function siigoSources(): Map<string, ViewSource> {
  return new Map<string, ViewSource>([
    [
      'siigo_facturas',
      source(facturasSiigo, [
        row('f1', 'FV-101', {
          numero: 'FV-101',
          cliente: 'Transportes Andinos',
          fecha: '2026-10-01',
          total: 4_500_000,
          saldo: 4_500_000,
          estado: 'Por cobrar',
        }),
        row('f2', 'FV-099', {
          numero: 'FV-099',
          cliente: 'Ferretería El Tornillo',
          fecha: '2026-09-10',
          vence: '2026-09-25',
          total: 8_000_000,
          saldo: 3_000_000,
          estado: 'Vencida',
        }),
        row('f3', 'FV-090', {
          numero: 'FV-090',
          cliente: 'Transportes Andinos',
          fecha: '2026-09-02',
          total: 2_000_000,
          saldo: 0,
          estado: 'Pagada',
        }),
        row('f4', 'FV-080', {
          numero: 'FV-080',
          cliente: 'Ferretería El Tornillo',
          fecha: '2026-08-15',
          total: 6_000_000,
          saldo: 0,
          estado: 'Anulada',
        }),
      ]),
    ],
    [
      'siigo_pagos',
      source(pagosSiigo, [
        row('p1', 'RC-1', {
          cliente: 'Ferretería El Tornillo',
          fecha: '2026-10-01',
          valor: 5_000_000,
        }),
        row('p2', 'RC-2', {
          cliente: 'Transportes Andinos',
          fecha: '2026-09-20',
          valor: 2_000_000,
        }),
      ]),
    ],
    [
      'cortex.cartera',
      source({ slug: carteraDef.id, name: carteraDef.name, fields: carteraDef.fields }, [
        row('c1', 'FV-099', {
          numero: 'FV-099',
          cliente: 'Ferretería El Tornillo',
          vence: '2026-09-25',
          dias_mora: 7,
          tramo: '1 a 30 días',
          saldo: 3_000_000,
          origen: 'Siigo',
        }),
        row('c2', 'FV-100', {
          numero: 'FV-100',
          cliente: 'Transportes Andinos',
          vence: '2026-10-01',
          dias_mora: 1,
          tramo: '1 a 30 días',
          saldo: 1_250_000,
          origen: 'Siigo',
        }),
      ]),
    ],
  ]);
}

// ---------------------------------------------------------------------------
// 1. Componer con lo que hay
// ---------------------------------------------------------------------------

describe('el pulso se arma con lo que la empresa tiene', () => {
  it('con sólo Siigo: ventas y pagos de sus tablas, cartera unificada, y dice qué falta', () => {
    const out = composePulseSpec(ONLY_SIIGO);
    expect(out.spec).not.toBeNull();
    expect(ids(out.spec)[0]).toBe(SUMMARY_BLOCK_ID);
    expect(ids(out.spec)).toEqual(
      expect.arrayContaining([
        'ventas_mes',
        'cartera_vencida',
        'pagos_mes',
        'tendencia_ventas',
        'top_clientes',
        'cobros_mes',
        'top_deudores',
      ]),
    );
    // Nada sobre fuentes vacías.
    for (const id of ['recuperado', 'metas_cumplidas', 'pendientes', 'procesos_fallando'])
      expect(ids(out.spec)).not.toContain(id);

    const ventas = block(out.spec, 'ventas_mes');
    expect(ventas).toMatchObject({
      type: 'metric',
      tracker: 'siigo_facturas',
      field: 'total',
      dateField: 'fecha',
      compare: 'previous_period',
      period: 'month',
    });
    // Una factura anulada no es una venta.
    expect(ventas && 'filters' in ventas ? ventas.filters : []).toContainEqual({
      field: 'estado',
      op: 'neq',
      value: 'Anulada',
    });
    expect(block(out.spec, 'cartera_vencida')).toMatchObject({ tracker: 'cortex.cartera' });
    // Sin pagos en Cortex todavía, los recibos de caja de Siigo.
    expect(block(out.spec, 'pagos_mes')).toMatchObject({ tracker: 'siigo_pagos' });
    expect(out.salesFrom).toBe('Siigo');

    const what = out.missing.map((m) => m.what);
    expect(what).toContain('Metas');
    expect(what).toContain('Pendientes y decisiones');
    expect(what).toContain('Plata recuperada con Cortex');
    expect(what).not.toContain('Ventas y facturación');

    // El spec pasa el contrato Y el catálogo de verdad.
    expect(checkSpecAgainst(out.spec as ViewSpec, CATALOG)).toEqual([]);
  });

  it('con sólo ventas confirmadas: usa cortex.ventas y pide conectar los pagos', () => {
    const out = composePulseSpec({
      platform: { ...EMPTY, 'cortex.ventas': 'data' },
      accounting: [],
    });
    expect(block(out.spec, 'ventas_mes')).toMatchObject({
      tracker: 'cortex.ventas',
      dateField: 'emitida',
    });
    // La cartera se lee aunque hoy esté en cero: «nada vencido» también es un dato.
    expect(block(out.spec, 'cartera_vencida')).toMatchObject({ tracker: 'cortex.cartera' });
    expect(ids(out.spec)).not.toContain('pagos_mes');
    const pagos = out.missing.find((m) => m.what === 'Pagos recibidos');
    expect(pagos?.href).toBe('/payments');
    expect(checkSpecAgainst(out.spec as ViewSpec, CATALOG)).toEqual([]);
  });

  it('si la cartera unificada no contesta, cae a las vencidas de las ventas', () => {
    const out = composePulseSpec({
      platform: { ...EMPTY, 'cortex.ventas': 'data', 'cortex.cartera': 'error' },
      accounting: [],
    });
    expect(block(out.spec, 'cartera_vencida')).toMatchObject({
      tracker: 'cortex.ventas',
      filters: [{ field: 'estado', op: 'eq', value: 'Vencida' }],
    });
    expect(checkSpecAgainst(out.spec as ViewSpec, CATALOG)).toEqual([]);
  });

  it('con todo conectado: cifras, tendencias, tablas y nada que pedir salvo lo que falte', () => {
    const all = Object.fromEntries(
      Object.keys(EMPTY).map((k) => [k, 'data']),
    ) as PulseInventory['platform'];
    const out = composePulseSpec({ platform: all, accounting: [] });
    expect(ids(out.spec)).toEqual(
      expect.arrayContaining([
        'recuperado',
        'metas_cumplidas',
        'pendientes',
        'compromisos_vencidos',
        'vencen_semana',
        'procesos_fallando',
        'metas',
        'decisiones',
      ]),
    );
    expect(out.missing).toEqual([]);
    expect((out.spec as ViewSpec).blocks.length).toBeLessThanOrEqual(24);
    expect(checkSpecAgainst(out.spec as ViewSpec, CATALOG)).toEqual([]);
  });

  it('sin nada: no arma una vista vacía y dice qué conectar primero', () => {
    const out = composePulseSpec({ platform: EMPTY, accounting: [] });
    expect(out.spec).toBeNull();
    const message = emptyPulseMessage(out.missing);
    expect(message).toMatch(/Conecta Siigo, Alegra o QuickBooks/);
    expect(message).toContain('/integrations#programas-contables');
    expect(message).toContain('/goals');
  });

  it('es estable: el mismo inventario da el mismo spec', () => {
    expect(composePulseSpec(ONLY_SIIGO)).toEqual(composePulseSpec(ONLY_SIIGO));
  });
});

// ---------------------------------------------------------------------------
// 2. Las cifras y la guarda
// ---------------------------------------------------------------------------

function siigoFacts(): PulseFact[] {
  const spec = composePulseSpec(ONLY_SIIGO).spec as ViewSpec;
  const sources = siigoSources();
  return pulseFacts(spec, computeView(spec, sources, NOW), sources, NOW);
}

describe('las cifras del día salen de la vista calculada', () => {
  it('trae el mes, el anterior, lo de ayer y lo que se venció ayer', () => {
    const facts = siigoFacts();
    const get = (key: string) => facts.find((f) => f.key === key);
    // Octubre: sólo FV-101 (la anulada no cuenta).
    expect(get('ventas_mes')?.value).toBe(4_500_000);
    // Septiembre: FV-099 + FV-090.
    expect(get('ventas_mes.anterior')?.value).toBe(10_000_000);
    expect(get('ventas_mes.ayer')?.value).toBe(4_500_000);
    expect(get('pagos_mes.ayer')?.value).toBe(5_000_000);
    expect(get('cartera_vencida')?.value).toBe(4_250_000);
    expect(get('cartera.vencio_ayer')?.value).toBe(1);
    expect(get('cartera.vencio_ayer_saldo')?.value).toBe(1_250_000);
    expect(get('top_deudores.0')?.display).toContain('Ferretería El Tornillo');
  });
});

describe('la guarda de números', () => {
  const facts = siigoFacts();
  const display = (key: string) => facts.find((f) => f.key === key)?.display ?? '';

  it('acepta las cifras copiadas tal cual y sus redondeos honestos', () => {
    const text = [
      `**Frente a ayer:** entraron ${display('pagos_mes.ayer')} en pagos y se vencieron ${display('cartera.vencio_ayer')} factura por ${display('cartera.vencio_ayer_saldo')}.`,
      `**Para hoy:** la cartera vencida suma ${display('cartera_vencida')}; Ferretería El Tornillo debe la mayor parte.`,
      '**El mes:** las ventas van en 4,5 millones contra 10 millones de septiembre.',
    ].join('\n');
    expect(checkGrounding(text, facts, NOW)).toEqual({ ok: true, ungrounded: [] });
  });

  it('rechaza cifras inventadas, calculadas o de otro orden de magnitud', () => {
    const invented = checkGrounding('Las ventas suben 37 % y hay 3 clientes nuevos.', facts, NOW);
    expect(invented.ok).toBe(false);
    expect(invented.ungrounded).toEqual(expect.arrayContaining(['37', '3']));
    expect(checkGrounding('La cartera vencida es $ 4.900.000.', facts, NOW).ok).toBe(false);
    expect(checkGrounding('Vamos en 45 millones.', facts, NOW).ok).toBe(false);
    // 4.250.000 redondeado a «4,3 millones» es honesto; «4,1 millones» no.
    expect(checkGrounding('Faltan 4,3 millones por cobrar.', facts, NOW).ok).toBe(true);
    expect(checkGrounding('Faltan 4,1 millones por cobrar.', facts, NOW).ok).toBe(false);
  });

  it('acepta la fecha de hoy y la de ayer, nada más', () => {
    expect(checkGrounding('Hoy 2 de octubre de 2026.', facts, NOW).ok).toBe(true);
    expect(checkGrounding('Desde el 17 de septiembre.', facts, NOW).ok).toBe(false);
  });

  it('el resumen sin modelo pasa siempre su propia guarda', () => {
    const bullets = fallbackSummary(facts);
    expect(bullets).toHaveLength(3);
    expect(bullets[0]).toMatch(/^\*\*Frente a ayer:\*\*/);
    expect(checkGrounding(bullets.join('\n'), facts, NOW)).toEqual({ ok: true, ungrounded: [] });
  });
});

// ---------------------------------------------------------------------------
// 3. La rutina diaria
// ---------------------------------------------------------------------------

describe('la rutina del resumen', () => {
  const view = { id: '11111111-1111-4111-8111-111111111111', name: 'Pulso de la empresa' };
  const who = { userId: 'u-1', agentId: 'a-1' };

  it('por defecto: 7:00 a. m. de lunes a viernes en Bogotá, una herramienta fija', () => {
    const r = pulseRoutineRow(view, who);
    expect(r).toMatchObject({
      kind: 'tool',
      tool_id: 'views.refresh_summary',
      tool_input: { view: view.id },
      schedule_kind: 'cron',
      cron: '0 7 * * 1-5',
      timezone: 'America/Bogota',
      allow_unattended_writes: false,
      notify_conversation: true,
      notify_email: false,
      user_id: 'u-1',
      agent_id: 'a-1',
    });
    // El input que guarda la rutina es exactamente uno que la herramienta acepta.
    expect(viewsRefreshSummary.inputSchema.safeParse(r.tool_input).success).toBe(true);
    // Y corre sin confirmación: si la pidiera, la rutina desatendida la saltaría.
    expect(viewsRefreshSummary.requiresConfirmation).toBeFalsy();
    // Viernes 10:00 a. m. → la próxima es el lunes a las 7:00 de Bogotá.
    expect(computeNextRun(r.cron, r.timezone, NOW).toISOString()).toBe('2026-10-05T12:00:00.000Z');
  });

  it('los días y la hora se configuran', () => {
    expect(pulseRoutineRow(view, who, { hour: 6, minute: 30, weekdays: [1, 3, 5] }).cron).toBe(
      '30 6 * * 1,3,5',
    );
    expect(cronWeekdays([0, 1, 2, 3, 4, 5, 6])).toBe('*');
    expect(cronWeekdays([1, 2, 3, 4, 5, 6])).toBe('1-6');
    expect(weekdaysPhrase([1, 2, 3, 4, 5])).toBe('de lunes a viernes');
    expect(weekdaysPhrase([1, 3, 5])).toBe('lunes, miércoles y viernes');
  });

  it('la herramienta que la programa pide confirmación y trae los valores por defecto', () => {
    expect(viewsSchedulePulse.requiresConfirmation).toBe(true);
    expect(pulseRoutineInput.parse({})).toEqual({
      view: 'pulso_empresa',
      hour: 7,
      minute: 0,
      weekdays: [1, 2, 3, 4, 5],
      timezone: 'America/Bogota',
      notifyEmail: false,
    });
    expect(pulseRoutineInput.safeParse({ hour: 24 }).success).toBe(false);
    expect(pulseRoutineInput.safeParse({ weekdays: [] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Una vez por día
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Lo justo de PostgREST para custom_views y su historial. */
function fakeDb(store: Record<string, Row[]>): SupabaseClient {
  let seq = 0;
  class Query {
    private filters: Array<(r: Row) => boolean> = [];
    private mode: 'select' | 'insert' | 'update' = 'select';
    private payload: Row = {};
    private max: number | null = null;
    constructor(private table: string) {}
    private get rows() {
      store[this.table] ??= [];
      return store[this.table] as Row[];
    }
    select() {
      return this;
    }
    eq(c: string, v: unknown) {
      this.filters.push((r) => r[c] === v);
      return this;
    }
    is(c: string, v: unknown) {
      this.filters.push((r) => (v === null ? r[c] == null : r[c] === v));
      return this;
    }
    order() {
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
    private run(): Row[] {
      if (this.mode === 'insert') {
        const created = { id: `id-${++seq}`, ...this.payload };
        this.rows.push(created);
        return [created];
      }
      const found = this.rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.mode === 'update') for (const r of found) Object.assign(r, this.payload);
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
      ok?: (v: { data: Row[]; error: null }) => unknown,
      ko?: (e: unknown) => unknown,
    ): Promise<unknown> {
      return Promise.resolve({ data: this.run(), error: null }).then(ok, ko);
    }
  }
  return { from: (t: string) => new Query(t) } as unknown as SupabaseClient;
}

function pulseStore(): Record<string, Row[]> {
  const spec = composePulseSpec(ONLY_SIIGO).spec as ViewSpec;
  return {
    custom_views: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        slug: 'pulso_empresa',
        name: 'Pulso de la empresa',
        description: '',
        spec,
        version: 1,
        visibility: 'workspace',
        share_token: null,
        share_expires_at: null,
        share_views: 0,
        pinned: false,
        created_by: 'u-1',
        updated_by: 'u-1',
        created_at: '2026-09-30T12:00:00Z',
        updated_at: '2026-09-30T12:00:00Z',
        archived_at: null,
      },
    ],
    custom_view_versions: [],
  };
}

describe('el resumen se escribe una vez por día', () => {
  const load = async () => siigoSources();

  it('la guardia de repetición es por vista y por día de Bogotá; «force» va sin guardia', () => {
    const policy = viewsRefreshSummary.safeAction as { key: (i: unknown) => unknown };
    vi.useFakeTimers();
    try {
      // 11:30 p. m. del 2 en Bogotá ya es el 3 en UTC: la clave dice 2.
      vi.setSystemTime(new Date('2026-10-03T04:30:00Z'));
      expect(policy.key({ view: 'pulso_empresa' })).toEqual({
        view: 'pulso_empresa',
        blockId: 'resumen_hoy',
        day: '2026-10-02',
      });
      expect(policy.key({ view: 'pulso_empresa', force: true })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('la segunda corrida del mismo día no reescribe ni llama al modelo', async () => {
    const store = pulseStore();
    const db = fakeDb(store);
    const facts = siigoFacts();
    const d = (key: string) => facts.find((f) => f.key === key)?.display ?? '';
    const write = vi.fn<SummaryWriter>(async () => ({
      bullets: [
        `**Frente a ayer:** entraron ${d('pagos_mes.ayer')} en pagos.`,
        `**Para hoy:** la cartera vencida suma ${d('cartera_vencida')}.`,
        `**El mes:** ventas por ${d('ventas_mes')}.`,
      ],
    }));

    const first = await refreshViewSummary(db, {
      view: 'pulso_empresa',
      userId: 'u-1',
      now: NOW,
      write,
      load,
    });
    expect(first.status).toBe('written');
    expect(first.status === 'written' && first.fallback).toBe(false);
    expect(first.markdown).toContain('### Resumen de hoy · viernes 2 de octubre');
    expect(first.markdown).toContain(d('cartera_vencida'));
    const saved = store.custom_views?.[0] as { version: number; spec: ViewSpec };
    expect(saved.version).toBe(2);
    expect(saved.spec.blocks[0]).toMatchObject({ id: SUMMARY_BLOCK_ID, markdown: first.markdown });
    expect(store.custom_view_versions?.[0]).toMatchObject({
      prompt: summaryVersionPrompt('2026-10-02'),
      version: 2,
    });

    const again = await refreshViewSummary(db, {
      view: 'pulso_empresa',
      userId: 'u-1',
      now: NOW,
      write,
      load,
    });
    expect(again.status).toBe('already');
    expect(again.markdown).toBe(first.markdown);
    expect(write).toHaveBeenCalledTimes(1);
    expect((store.custom_views?.[0] as { version: number }).version).toBe(2);

    // A pedido explícito, sí.
    const forced = await refreshViewSummary(db, {
      view: 'pulso_empresa',
      userId: 'u-1',
      now: NOW,
      write,
      load,
      force: true,
    });
    expect(forced.status).toBe('written');

    // Y al día siguiente, otra vez.
    const tomorrow = await refreshViewSummary(db, {
      view: 'pulso_empresa',
      userId: 'u-1',
      now: new Date('2026-10-03T12:00:00Z'),
      write,
      load,
    });
    expect(tomorrow.status).toBe('written');
    expect(store.custom_view_versions?.map((v) => v.prompt)).toEqual([
      'Resumen del día 2026-10-02',
      'Resumen del día 2026-10-02',
      'Resumen del día 2026-10-03',
    ]);
  });

  it('si el modelo inventa dos veces, escribe el resumen sólo con cifras', async () => {
    const store = pulseStore();
    const write = vi.fn<SummaryWriter>(async () => ({
      bullets: ['**El mes:** las ventas crecieron 37 % y llegaron 3 clientes nuevos.'],
    }));
    const out = await refreshViewSummary(fakeDb(store), {
      view: 'pulso_empresa',
      userId: 'u-1',
      now: NOW,
      write,
      load,
    });
    expect(write).toHaveBeenCalledTimes(2);
    // El segundo intento sabe qué números se rechazaron.
    expect(write.mock.calls[1]?.[0].rejected).toEqual(expect.arrayContaining(['37', '3']));
    expect(out.status === 'written' && out.fallback).toBe(true);
    expect(out.markdown).not.toContain('37 %');
    expect(out.markdown).toContain('sólo con las cifras de esta vista');
  });

  it('si el modelo no contesta, también hay resumen', async () => {
    const out = await refreshViewSummary(fakeDb(pulseStore()), {
      view: 'pulso_empresa',
      userId: 'u-1',
      now: NOW,
      write: async () => {
        throw new Error('timeout');
      },
      load,
    });
    expect(out.status).toBe('written');
  });
});
