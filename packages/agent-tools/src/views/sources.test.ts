import { ValidationError } from '@cortex/core';
import { describe, expect, it } from 'vitest';
import { type Tables, createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { TRACKER_SLUG_RE, trackerFieldsSchema } from '../trackers/schema';
import { computeView } from './compute';
import { PLATFORM_SOURCES, internalSourcesOf, readPlatformSource } from './sources';
import {
  type CatalogTracker,
  PLATFORM_SOURCE_RE,
  checkSpecAgainst,
  isPlatformSourceId,
  viewSpecSchema,
} from './spec';
import { INTERNAL_SOURCE_BLOCKED, loadViewSources, setViewAccess, updateView } from './store';

/**
 * Las fuentes de la plataforma dentro de una vista: el registro, el contrato,
 * la puerta de afuera y los lectores contra un PostgREST de mentira con DOS
 * espacios, para que «lee lo de su empresa y nada más» sea una afirmación
 * probada y no una intención.
 */

const ACME = 'org-acme';
const GLOBEX = 'org-globex';
const ANA = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-09-24';
const T = '2026-09-01T15:00:00Z';

const catalog: CatalogTracker[] = [
  {
    slug: 'remates',
    name: 'Remates',
    fields: [{ key: 'valor', label: 'Valor', type: 'money', required: false }],
  },
  ...[...PLATFORM_SOURCES.values()].map((s) => ({ slug: s.id, name: s.name, fields: s.fields })),
];

describe('el registro de fuentes', () => {
  it('ningún id puede confundirse con el slug de una tabla', () => {
    expect(PLATFORM_SOURCES.size).toBeGreaterThanOrEqual(5);
    for (const id of PLATFORM_SOURCES.keys()) {
      expect(id).toMatch(PLATFORM_SOURCE_RE);
      expect(TRACKER_SLUG_RE.test(id)).toBe(false);
      expect(isPlatformSourceId(id)).toBe(true);
    }
    expect(isPlatformSourceId('remates')).toBe(false);
  });

  it('los campos tienen la misma forma que los de una tabla, con opciones reales', () => {
    for (const source of PLATFORM_SOURCES.values()) {
      const parsed = trackerFieldsSchema.safeParse(source.fields);
      expect(parsed.success, source.id).toBe(true);
      for (const f of source.fields)
        if (f.type === 'select')
          expect(f.options?.length, `${source.id}.${f.key}`).toBeGreaterThan(0);
    }
  });

  it('lo que nombra gente del equipo es interno', () => {
    const internal = [...PLATFORM_SOURCES.values()]
      .filter((s) => s.sensitivity === 'internal')
      .map((s) => s.id)
      .sort();
    expect(internal).toEqual(['cortex.compromisos', 'cortex.gestion', 'cortex.prospectos']);
  });
});

describe('el contrato con fuentes de la plataforma', () => {
  it('acepta un id de fuente y sus campos; rechaza lo que la fuente no tiene', () => {
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [
        {
          id: 'ventas',
          type: 'metric',
          title: 'Ventas',
          tracker: 'cortex.ventas',
          aggregate: 'sum',
          field: 'total',
        },
        {
          id: 'estado',
          type: 'board',
          title: 'Vencimientos',
          tracker: 'cortex.vencimientos',
          groupBy: 'estado',
        },
        { id: 'x', type: 'table', title: 'X', tracker: 'cortex.pagos', columns: ['inventado'] },
        { id: 'y', type: 'table', title: 'Y', tracker: 'cortex.no_existe' },
      ],
    });
    const problems = checkSpecAgainst(spec, catalog);
    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).toContain('«inventado» no es un campo de Pagos recibidos');
    expect(problems.join(' ')).toContain('«cortex.no_existe» no es una fuente de la plataforma');
  });

  it('un formulario sobre una fuente de la plataforma se rechaza con su razón', () => {
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [{ id: 'f', type: 'form', title: 'Nueva venta', tracker: 'cortex.ventas' }],
    });
    expect(checkSpecAgainst(spec, catalog).join(' ')).toContain('es de sólo lectura');
    // Y si un spec así llega por otro camino, se pinta el aviso, no el formulario.
    const [block] = computeView(
      spec,
      new Map([
        [
          'cortex.ventas',
          {
            tracker: catalog.find((c) => c.slug === 'cortex.ventas') as CatalogTracker,
            rows: [],
            truncated: false,
          },
        ],
      ]),
    ).blocks;
    expect(block?.type).toBe('problem');
  });

  it('la forma rechaza ids que no son ni tabla ni fuente', () => {
    for (const tracker of ['Cortex.Ventas', 'cortex.', 'otra.ventas', 'cortex.ventas.x']) {
      const r = viewSpecSchema.safeParse({
        version: 1,
        blocks: [{ id: 'm', type: 'metric', title: 'M', tracker }],
      });
      expect(r.success, tracker).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Contra la base de mentira
// ---------------------------------------------------------------------------

const INV_PAID = 'eeee0000-0000-4000-8000-000000000001';
const INV_LATE = 'eeee0000-0000-4000-8000-000000000002';
const INV_USD = 'eeee0000-0000-4000-8000-000000000003';
const CLIENT = 'cccc0000-0000-4000-8000-000000000001';
const VIEW_ID = 'ffff0000-0000-4000-8000-000000000001';

function invoice(id: string, org: string, extra: Record<string, unknown>) {
  return {
    id,
    organization_id: org,
    doc_type: 'invoice',
    financial_role: 'receivable',
    review_state: 'confirmed',
    doc_number: null,
    client_id: null,
    counterparty_name: null,
    counterparty_nit: null,
    total_amount: null,
    tax_amount: null,
    currency: 'COP',
    issued_on: '2026-08-01',
    due_on: null,
    created_at: T,
    updated_at: T,
    ...extra,
  };
}

function payment(org: string, extra: Record<string, unknown>) {
  return {
    id: `pay-${Math.random().toString(36).slice(2)}`,
    organization_id: org,
    kind: 'payment',
    amount: 0,
    currency: 'COP',
    paid_on: '2026-09-01',
    client_id: null,
    client_nit: null,
    client_match_state: 'no_nit',
    extraction_id: null,
    invoice_number: null,
    state: 'confirmed',
    source_count: 1,
    created_at: T,
    updated_at: T,
    ...extra,
  };
}

function commitment(org: string, extra: Record<string, unknown>) {
  return {
    id: `com-${Math.random().toString(36).slice(2)}`,
    organization_id: org,
    title: 'Algo',
    detail: null,
    kind: 'soat',
    counterparty: null,
    amount_cop: null,
    due_on: '2026-10-30',
    notice_days: 30,
    state: 'in_force',
    met_at: null,
    owner_user_id: null,
    review_state: 'confirmed',
    created_at: T,
    updated_at: T,
    ...extra,
  };
}

function world(): Tables {
  return {
    users: [{ id: ANA, organization_id: ACME, email: 'ana@acme.com', name: 'Ana' }],
    clients: [{ id: CLIENT, organization_id: ACME, name: 'Coltrans' }],
    document_extractions: [
      invoice(INV_PAID, ACME, {
        doc_number: 'FE-1',
        client_id: CLIENT,
        total_amount: '1000000.00',
        tax_amount: '190000.00',
        due_on: '2026-08-31',
      }),
      invoice(INV_LATE, ACME, {
        doc_number: 'FE-2',
        counterparty_name: 'Alpha SAS',
        total_amount: 500000,
        due_on: '2026-09-14',
      }),
      invoice(INV_USD, ACME, { doc_number: 'EX-1', total_amount: 3000, currency: 'USD' }),
      // Sin revisar y de otra empresa: ninguna de las dos es una venta de Acme.
      invoice('eeee0000-0000-4000-8000-000000000004', ACME, {
        doc_number: 'FE-PEND',
        review_state: 'pending',
        total_amount: 999,
      }),
      invoice('eeee0000-0000-4000-8000-000000000005', GLOBEX, {
        doc_number: 'GX-1',
        total_amount: 777,
      }),
    ],
    payments: [
      payment(ACME, { extraction_id: INV_PAID, amount: 1000000, client_id: CLIENT }),
      payment(ACME, { extraction_id: INV_LATE, amount: 200000 }),
      // En disputa: no cuenta, ni para el saldo ni en la lista de pagos.
      payment(ACME, { extraction_id: INV_LATE, amount: 300000, state: 'disputed' }),
      payment(ACME, { kind: 'reversal', amount: 50000, invoice_number: 'FE-9' }),
      payment(GLOBEX, { amount: 123 }),
    ],
    commitments: [
      commitment(ACME, { title: 'SOAT TXX123', due_on: '2026-09-20' }),
      commitment(ACME, { title: 'Póliza', kind: 'policy', amount_cop: 2500000 }),
      commitment(ACME, {
        title: 'Mandar el informe',
        kind: 'internal',
        owner_user_id: ANA,
        due_on: '2026-09-25',
        notice_days: 1,
      }),
      commitment(ACME, { title: 'Sin confirmar', review_state: 'pending' }),
      commitment(GLOBEX, { title: 'De Globex' }),
    ],
    management_cases: [
      {
        id: 'case-1',
        organization_id: ACME,
        data: { title: 'Cobrar a Alpha', state: 'working', impact: 'high', ownerId: ANA },
        created_at: T,
        updated_at: T,
      },
    ],
    custom_views: [],
  };
}

function acme(tables: Tables = world()) {
  const fake = createFakeSupabase(tables);
  return { db: createOrgScopedClient(fake.client, ACME), tables: fake.tables };
}

describe('los lectores', () => {
  it('ventas: sólo facturas confirmadas por cobrar del espacio, con cobrado, saldo y mora', async () => {
    const { db } = acme();
    const read = await readPlatformSource(db, 'cortex.ventas', 100, TODAY);
    if (!read) throw new Error('esperaba la fuente');
    expect(read.truncated).toBe(false);
    const byLabel = new Map(read.rows.map((r) => [r.label, r.values]));
    expect([...byLabel.keys()].sort()).toEqual(['EX-1', 'FE-1', 'FE-2']);
    expect(byLabel.get('FE-1')).toMatchObject({
      cliente: 'Coltrans',
      total: 1000000,
      iva: 190000,
      pagado: 1000000,
      saldo: 0,
      estado: 'Pagada',
      emitida: '2026-08-01',
    });
    expect(byLabel.get('FE-2')).toMatchObject({
      cliente: 'Alpha SAS',
      pagado: 200000,
      saldo: 300000,
      estado: 'Vencida',
      dias_mora: 10,
    });
    // Los dólares no entran en un campo que se pinta como pesos.
    const usd = byLabel.get('EX-1') ?? {};
    expect(usd).toMatchObject({ moneda: 'USD', total_otra_moneda: 3000, estado: 'Por cobrar' });
    expect(usd.total).toBeUndefined();
    expect(usd.saldo).toBeUndefined();
  });

  it('pagos: los que cuentan, con el signo de la anulación, y nada de otro espacio', async () => {
    const { db } = acme();
    const read = await readPlatformSource(db, 'cortex.pagos', 100, TODAY);
    const values = (read?.rows ?? []).map((r) => r.values.valor).sort();
    expect(values).toEqual([-50000, 1000000, 200000].sort());
    expect(read?.rows.find((r) => r.values.valor === -50000)?.values.tipo).toBe('Anulación');
  });

  it('vencimientos y compromisos internos salen de la misma tabla sin mezclarse', async () => {
    const { db } = acme();
    const due = await readPlatformSource(db, 'cortex.vencimientos', 100, TODAY);
    expect(due?.rows.map((r) => r.label).sort()).toEqual(['Póliza', 'SOAT TXX123']);
    expect(due?.rows.find((r) => r.label === 'SOAT TXX123')?.values).toMatchObject({
      tipo: 'SOAT',
      estado: 'Vencido',
      dias: -4,
    });
    expect(due?.rows.find((r) => r.label === 'Póliza')?.values.valor).toBe(2500000);

    const internal = await readPlatformSource(db, 'cortex.compromisos', 100, TODAY);
    expect(internal?.rows).toHaveLength(1);
    expect(internal?.rows[0]?.values).toMatchObject({ responsable: 'Ana', estado: 'Por vencer' });
  });

  it('marca parcial cuando hay más filas que el tope', async () => {
    const { db } = acme();
    const read = await readPlatformSource(db, 'cortex.ventas', 2, TODAY);
    expect(read?.rows).toHaveLength(2);
    expect(read?.truncated).toBe(true);
  });
});

describe('la puerta de afuera', () => {
  const internalSpec = viewSpecSchema.parse({
    version: 1,
    blocks: [
      { id: 'casos', type: 'table', title: 'Asuntos', tracker: 'cortex.gestion' },
      { id: 'ventas', type: 'metric', title: 'Ventas', tracker: 'cortex.ventas' },
    ],
  });

  function withView(visibility: 'workspace' | 'link', spec: unknown) {
    const tables = world();
    tables.custom_views = [
      {
        id: VIEW_ID,
        organization_id: ACME,
        slug: 'tablero',
        name: 'Tablero',
        description: '',
        spec,
        version: 1,
        visibility,
        share_token: visibility === 'link' ? 'a'.repeat(32) : null,
        share_expires_at: null,
        share_views: 0,
        pinned: false,
        created_by: ANA,
        updated_by: ANA,
        created_at: T,
        updated_at: T,
        archived_at: null,
      },
    ];
    tables.custom_view_versions = [];
    return acme(tables);
  }

  it('una vista con una fuente interna no se comparte por enlace ni con contraseña', async () => {
    expect(internalSourcesOf(internalSpec).map((s) => s.id)).toEqual(['cortex.gestion']);
    const { db } = withView('workspace', internalSpec);
    for (const visibility of ['link', 'password'] as const) {
      await expect(
        setViewAccess(db, VIEW_ID, { visibility, password: 'secreta-123', userId: ANA }),
      ).rejects.toThrow(ValidationError);
    }
    await expect(setViewAccess(db, VIEW_ID, { visibility: 'link', userId: ANA })).rejects.toThrow(
      /Asuntos de Gerencia/,
    );
    // Fijarla en Inicio no abre ninguna puerta y sigue funcionando.
    const pinned = await setViewAccess(db, VIEW_ID, { pinned: true, userId: ANA });
    expect(pinned.pinned).toBe(true);
    expect(pinned.visibility).toBe('workspace');
  });

  it('una vista ya compartida no puede empezar a usar una fuente interna', async () => {
    const shareable = {
      version: 1,
      accent: 'primary',
      blocks: [{ id: 'v', type: 'metric', title: 'Ventas', tracker: 'cortex.ventas' }],
    };
    const { db } = withView('link', shareable);
    await expect(updateView(db, VIEW_ID, { spec: internalSpec, userId: ANA })).rejects.toThrow(
      ValidationError,
    );
  });

  it('la página pública no lee una fuente interna aunque el spec la nombre', async () => {
    const { db } = acme();
    const sources = await loadViewSources(db, internalSpec, { audience: 'public' });
    expect(sources.get('cortex.gestion')?.rows).toEqual([]);
    expect(sources.get('cortex.gestion')?.blocked).toBe(INTERNAL_SOURCE_BLOCKED);
    expect(sources.get('cortex.ventas')?.rows.length).toBe(3);
    const [casos, ventas] = computeView(internalSpec, sources).blocks;
    expect(casos).toMatchObject({ type: 'problem', message: INTERNAL_SOURCE_BLOCKED });
    expect(ventas).toMatchObject({ type: 'metric', value: 3 });

    // Adentro, la misma vista sí la lee.
    const team = await loadViewSources(db, internalSpec);
    expect(team.get('cortex.gestion')?.rows[0]?.values).toMatchObject({
      estado: 'En gestión',
      impacto: 'Alto',
      responsable: 'Ana',
    });
  });
});
