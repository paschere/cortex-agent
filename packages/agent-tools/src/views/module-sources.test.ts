import { describe, expect, it } from 'vitest';
import { type Tables, createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { trackerFieldsSchema } from '../trackers/schema';
import { computeView } from './compute';
import { NOMINA_RESTRICTED } from './module-sources';
import { PLATFORM_SOURCES, internalSourcesOf, readPlatformSource } from './sources';
import { type CatalogTracker, checkSpecAgainst, viewSpecSchema } from './spec';
import { loadViewSources, viewCatalog } from './store';

/**
 * Las fuentes de los módulos de operación contra un PostgREST de mentira:
 * la forma de sus filas, el interruptor del módulo, y las dos reglas de
 * privacidad que no se negocian (nómina sólo en agregados y sólo para quien
 * administra; contratos laborales sólo para su círculo).
 */

const ACME = 'org-acme';
const GLOBEX = 'org-globex';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const BETO = '22222222-2222-4222-8222-222222222222';
const CARLA = '33333333-3333-4333-8333-333333333333';
const TODAY = '2026-09-24';
const T = '2026-09-01T15:00:00Z';

const ALL_MODULES = [
  'payables',
  'inventory',
  'taxes',
  'payroll',
  'contracts',
  'compliance',
  'crm',
  'service_orders',
  'fleet',
  'doc_expirations',
  'statements',
  'budget',
];

function modules(on: string[] = ALL_MODULES, off: string[] = []) {
  return [
    ...on.map((k) => ({ organization_id: ACME, module_key: k, enabled: true })),
    ...off.map((k) => ({ organization_id: ACME, module_key: k, enabled: false })),
  ];
}

const payable = (id: string, org: string, extra: Record<string, unknown>) => ({
  id,
  organization_id: org,
  supplier_name: 'Proveedor SAS',
  doc_number: 'FP-1',
  currency: 'COP',
  issue_date: '2026-09-01',
  due_date: '2026-09-30',
  total: '1190000.00',
  net_amount: '1100000.00',
  status: 'aprobada',
  checks: [],
  scheduled_pay_date: null,
  paid_at: null,
  source: 'correo',
  created_at: T,
  updated_at: T,
  ...extra,
});

function world(): Tables {
  return {
    company_modules: modules(),
    users: [
      { id: ADMIN, organization_id: ACME, email: 'ana@acme.com', name: 'Ana', role: 'org_admin' },
      { id: BETO, organization_id: ACME, email: 'beto@acme.com', name: 'Beto', role: 'member' },
      { id: CARLA, organization_id: ACME, email: 'carla@acme.com', name: 'Carla', role: 'member' },
    ],
    payable_invoices: [
      payable('pay-1', ACME, {
        doc_number: 'FP-1',
        checks: [
          { code: 'price_jump', severity: 'warn', message: 'El precio subió 20 %.' },
          { code: 'po_match', severity: 'info', message: 'Coincide con la OC-0001.' },
        ],
      }),
      payable('pay-2', ACME, {
        doc_number: 'FP-2',
        supplier_name: 'Alfa Ltda',
        due_date: '2026-09-10',
        status: 'programada',
        scheduled_pay_date: '2026-09-26',
      }),
      payable('pay-3', ACME, {
        doc_number: 'FP-3',
        status: 'pagada',
        paid_at: '2026-09-05T15:00:00Z',
      }),
      payable('pay-4', ACME, {
        doc_number: 'EX-1',
        currency: 'USD',
        total: 3000,
        net_amount: 3000,
        due_date: null,
        status: 'por_aprobar',
      }),
      payable('pay-x', GLOBEX, { doc_number: 'GX-1' }),
    ],
    products: [
      {
        id: 'prod-1',
        organization_id: ACME,
        sku: 'TOR-1',
        name: 'Tornillo',
        unit: 'caja',
        category: 'Ferretería',
        track_stock: true,
        currency: 'COP',
        cost: '10000',
        price: '15000',
        min_stock: 20,
        reorder_qty: 50,
        lead_time_days: 5,
        preferred_supplier_id: 'sup-1',
        source: 'manual',
        stock_from: 'cortex',
        active: true,
        created_at: T,
        updated_at: T,
      },
      {
        id: 'prod-2',
        organization_id: ACME,
        sku: 'CLA-1',
        name: 'Clavo',
        unit: 'caja',
        category: 'Ferretería',
        track_stock: true,
        currency: 'COP',
        cost: '5000',
        price: '8000',
        min_stock: 5,
        reorder_qty: null,
        lead_time_days: null,
        preferred_supplier_id: null,
        source: 'manual',
        stock_from: 'cortex',
        active: true,
        created_at: T,
        updated_at: T,
      },
      {
        id: 'prod-3',
        organization_id: ACME,
        sku: 'IMP-1',
        name: 'Importado',
        unit: 'und',
        category: null,
        track_stock: true,
        currency: 'USD',
        cost: '12',
        price: '20',
        min_stock: null,
        reorder_qty: null,
        lead_time_days: null,
        preferred_supplier_id: null,
        source: 'manual',
        stock_from: 'cortex',
        active: true,
        created_at: T,
        updated_at: T,
      },
    ],
    stock_levels: [
      {
        organization_id: ACME,
        product_id: 'prod-1',
        location_id: 'loc-1',
        on_hand: 8,
        last_movement_on: '2026-09-20',
        movements: 3,
      },
      {
        organization_id: ACME,
        product_id: 'prod-2',
        location_id: 'loc-1',
        on_hand: 100,
        last_movement_on: '2026-09-20',
        movements: 1,
      },
      {
        organization_id: ACME,
        product_id: 'prod-3',
        location_id: 'loc-1',
        on_hand: 4,
        last_movement_on: '2026-09-20',
        movements: 1,
      },
    ],
    stock_locations: [],
    stock_movements: [],
    suppliers: [{ id: 'sup-1', organization_id: ACME, name: 'Tornillos SA' }],
    purchase_orders: [
      {
        id: 'po-1',
        organization_id: ACME,
        number: 7,
        supplier_name: 'Tornillos SA',
        status: 'enviada',
        currency: 'COP',
        total: 2500000,
        expected_on: '2026-09-20',
        payment_terms_days: 30,
        origin: 'sugerencia',
        received_at: null,
        created_at: T,
        updated_at: T,
      },
      {
        id: 'po-2',
        organization_id: ACME,
        number: 6,
        supplier_name: 'Clavos SA',
        status: 'cerrada',
        currency: 'COP',
        total: 100000,
        expected_on: '2026-08-01',
        payment_terms_days: 30,
        origin: 'manual',
        received_at: '2026-08-02T15:00:00Z',
        created_at: T,
        updated_at: T,
      },
    ],
    tax_obligations: [
      {
        id: 'tax-1',
        organization_id: ACME,
        year: 2026,
        obligation_key: 'iva:B4',
        kind: 'iva',
        period: 'Bimestre 4',
        title: 'IVA bimestre 4',
        authority: 'DIAN',
        form: '300',
        due_date: '2026-09-15',
        requires_payment: true,
        needs_confirmation: false,
        rule_version: 'v1',
        source_note: null,
        status: 'presentada',
        status_at: null,
        status_by: null,
        status_note: null,
        evidence_document_id: null,
        evidence_url: null,
        commitment_id: null,
      },
      {
        id: 'tax-2',
        organization_id: ACME,
        year: 2026,
        obligation_key: 'ica:A',
        kind: 'ica',
        period: 'Anual',
        title: 'ICA anual',
        authority: 'Secretaría de Hacienda',
        form: null,
        due_date: '2026-10-20',
        requires_payment: true,
        needs_confirmation: true,
        rule_version: 'v1',
        source_note: null,
        status: 'pendiente',
        status_at: null,
        status_by: null,
        status_note: null,
        evidence_document_id: null,
        evidence_url: null,
        commitment_id: null,
      },
    ],
    payroll_periods: [
      {
        id: 'per-1',
        organization_id: ACME,
        frequency: 'mensual',
        period_start: '2026-08-01',
        period_end: '2026-08-31',
        pay_date: '2026-08-30',
        status: 'pagado',
        params_version: 'v1',
        totals: {
          devengado: 12000000,
          deducciones: 960000,
          neto: 11040000,
          aportes: 3000000,
          provisiones: 2000000,
          costoTotal: 17000000,
          employees: 4,
          seguridadSocial: 4500000,
        },
        employees_count: 4,
        liquidated_at: '2026-08-28T15:00:00Z',
        created_at: T,
        updated_at: T,
      },
    ],
    // Lo que NUNCA debe tocar la fuente de nómina.
    employees: [
      { id: 'emp-1', organization_id: ACME, full_name: 'Persona Secreta', user_id: BETO },
    ],
    payslips: [{ id: 'ps-1', organization_id: ACME, employee_id: 'emp-1', net_pay: 9999999 }],
    contracts: [
      {
        id: 'con-1',
        organization_id: ACME,
        contract_type: 'arrendamiento_comercial',
        title: 'Arriendo bodega',
        counterparty_kind: 'proveedor',
        counterparty_name: 'Inmobiliaria Sur',
        employee_user_id: null,
        value_amount: 8000000,
        currency: 'COP',
        start_on: '2026-01-01',
        end_on: '2026-12-31',
        renewal: 'ninguna',
        renewal_months: null,
        notice_days: 60,
        status: 'firmado',
        owner_user_id: ADMIN,
        created_by: ADMIN,
        created_at: T,
        updated_at: T,
      },
      {
        id: 'con-2',
        organization_id: ACME,
        contract_type: 'laboral_indefinido',
        title: 'Contrato de Carla',
        counterparty_kind: 'empleado',
        counterparty_name: 'Carla',
        employee_user_id: CARLA,
        value_amount: 5000000,
        currency: 'COP',
        start_on: '2026-02-01',
        end_on: null,
        renewal: 'ninguna',
        renewal_months: null,
        notice_days: null,
        status: 'firmado',
        owner_user_id: CARLA,
        created_by: ADMIN,
        created_at: T,
        updated_at: T,
      },
    ],
    contract_obligations: [
      {
        id: 'ob-1',
        organization_id: ACME,
        contract_id: 'con-1',
        description: 'Pagar el canon',
        due_on: '2026-10-05',
        status: 'confirmada',
        created_at: T,
      },
      {
        id: 'ob-2',
        organization_id: ACME,
        contract_id: 'con-2',
        description: 'Entregar dotación',
        due_on: '2026-10-01',
        status: 'confirmada',
        created_at: T,
      },
    ],
    pqrs: [
      {
        id: 'pq-1',
        organization_id: ACME,
        year: 2026,
        seq: 1,
        radicado: 'PQRS-2026-000001',
        channel: 'correo',
        kind: 'reclamo',
        matter: 'consumo',
        subject: 'Producto defectuoso',
        body: 'TEXTO PRIVADO DEL RECLAMO',
        requester_name: 'Persona Reclamante',
        requester_email: 'reclamante@correo.com',
        requester_phone: '3001112222',
        received_at: '2026-09-10T15:00:00Z',
        received_on: '2026-09-10',
        due_on: '2026-10-02',
        extended_due_on: null,
        status: 'en_tramite',
        assigned_user_id: BETO,
        response_text: 'RESPUESTA PRIVADA',
        responded_at: null,
        created_at: T,
        updated_at: T,
      },
    ],
    compliance_items: [
      {
        id: 'ci-1',
        organization_id: ACME,
        item_key: 'rnbd',
        period: '2026',
        area: 'datos_personales',
        title: 'Actualizar el RNBD',
        frequency: 'anual',
        due_on: '2026-09-01',
        due_needs_confirmation: false,
        legal_basis: 'Decreto 090 de 2018',
        applies: 'si',
        status: 'pendiente',
        owner_user_id: BETO,
        completed_at: null,
        created_at: T,
        updated_at: T,
      },
    ],
    crm_pipelines: [],
    crm_opportunities: [
      {
        id: 'opp-1',
        organization_id: ACME,
        client_name: 'Coltrans',
        title: 'Flota de 10 camiones',
        value: 100000000,
        currency: 'COP',
        stage: 'negociacion',
        probability: null,
        expected_close: '2026-10-15',
        owner_user_id: BETO,
        source: 'referral',
        next_step: 'Enviar contrato',
        next_step_due: '2026-09-27',
        stage_changed_at: T,
        last_activity_at: '2026-09-14T15:00:00Z',
        won_at: null,
        lost_at: null,
        created_at: T,
        updated_at: T,
      },
      {
        id: 'opp-2',
        organization_id: ACME,
        client_name: 'Alpha',
        title: 'Renovación',
        value: 3000,
        currency: 'USD',
        stage: 'ganada',
        probability: 100,
        expected_close: null,
        owner_user_id: null,
        source: 'inbound',
        stage_changed_at: T,
        last_activity_at: T,
        won_at: '2026-09-20T15:00:00Z',
        lost_at: null,
        created_at: T,
        updated_at: T,
      },
    ],
    doc_dummy: [],
    document_expirations: [
      {
        id: 'ex-1',
        organization_id: ACME,
        document_id: 'doc-1',
        space_id: 'space-secreto',
        source: 'documento',
        kind: 'poliza',
        title: 'Póliza de responsabilidad civil',
        subject_kind: 'empresa',
        subject: 'La empresa',
        subject_key: 'la empresa',
        vehicle_id: null,
        client_id: null,
        issuer: 'Seguros Bolívar',
        number: 'P-1',
        expires_on: '2026-10-10',
        expires_quote: 'CITA PRIVADA DEL DOCUMENTO',
        renewal_lead_days: 45,
        owner_user_id: ADMIN,
        status: 'vigente',
        needs_review: false,
        created_at: T,
        updated_at: T,
      },
      {
        id: 'ex-2',
        organization_id: ACME,
        document_id: null,
        source: 'manual',
        kind: 'soat',
        title: 'SOAT WGY482',
        subject_kind: 'vehiculo',
        subject: 'WGY482',
        vehicle_id: null,
        client_id: null,
        issuer: null,
        expires_on: '2026-09-01',
        renewal_lead_days: 30,
        owner_user_id: null,
        status: 'vigente',
        needs_review: false,
        created_at: T,
        updated_at: T,
      },
      // Sin confirmar: todavía no se vigila, y una vista no lo cuenta.
      {
        id: 'ex-3',
        organization_id: ACME,
        document_id: null,
        source: 'documento',
        kind: 'licencia',
        title: 'Licencia propuesta',
        subject_kind: 'empresa',
        subject: 'La empresa',
        expires_on: '2026-09-30',
        renewal_lead_days: 60,
        owner_user_id: null,
        status: 'vigente',
        needs_review: true,
        created_at: T,
        updated_at: T,
      },
    ],
    kb_documents: [],
    vehicles: [
      {
        id: 'veh-1',
        organization_id: ACME,
        user_id: ADMIN,
        plate: 'WGY482',
        label: 'Furgón 1',
        brand: 'Chevrolet',
        line: 'NHR',
        in_fleet: true,
        archived: false,
        vehicle_type: 'furgon',
        odometer_km: 120000,
        soat_expires_at: '2026-09-01',
        rtm_expires_at: '2027-03-01',
        total_pending_cop: 400000,
        driver_name: 'Pedro',
        created_at: T,
      },
    ],
    maintenance_plans: [
      {
        id: 'mp-1',
        organization_id: ACME,
        vehicle_id: 'veh-1',
        task: 'Cambio de aceite',
        every_km: 10000,
        every_days: null,
        last_done_km: 110000,
        last_done_on: '2026-06-01',
        active: true,
      },
    ],
    fuel_logs: [],
    maintenance_events: [],
    trips: [],
    projects: [
      {
        id: 'prj-1',
        organization_id: ACME,
        number: 3,
        code: 'OS-0003',
        kind: 'orden_servicio',
        title: 'Montaje de bodega',
        status: 'en_curso',
        client_name: 'Coltrans',
        owner_id: BETO,
        currency: 'COP',
        budget_amount: 10000000,
        budget_hours: 100,
        contract_amount: 15000000,
        start_on: '2026-09-01',
        due_on: '2026-10-01',
        finished_on: null,
        created_at: T,
        updated_at: T,
      },
    ],
    work_items: [],
    time_entries: [],
    project_costs: [],
    project_milestones: [],
    sales_documents: [],
    custom_views: [],
  };
}

function acme(tables: Tables = world()) {
  const fake = createFakeSupabase(tables);
  return { db: createOrgScopedClient(fake.client, ACME), tables: fake.tables };
}

const NEW_IDS = [
  'cortex.por_pagar',
  'cortex.inventario',
  'cortex.ordenes_compra',
  'cortex.impuestos',
  'cortex.nomina',
  'cortex.contratos',
  'cortex.pqrs',
  'cortex.cumplimiento',
  'cortex.comercial',
  'cortex.proyectos',
  'cortex.flota',
  'cortex.documentos_vencen',
];

const read = async (
  db: ReturnType<typeof acme>['db'],
  id: string,
  viewerId: string | null = ADMIN,
) => {
  const result = await readPlatformSource(db, id, 100, TODAY, { viewerId });
  if (!result) throw new Error(`falta la fuente ${id}`);
  return result;
};

const byLabel = (rows: Array<{ label: string; values: Record<string, string | number> }>) =>
  new Map(rows.map((r) => [r.label, r.values]));

describe('el registro de los módulos de operación', () => {
  it('están todas, son internas, tienen su módulo y campos con la forma de una tabla', () => {
    for (const id of [...NEW_IDS, 'cortex.estados', 'cortex.presupuesto']) {
      const source = PLATFORM_SOURCES.get(id);
      expect(source, id).toBeDefined();
      expect(source?.sensitivity, id).toBe('internal');
      expect(source?.module, id).toBeDefined();
      expect(trackerFieldsSchema.safeParse(source?.fields).success, id).toBe(true);
      for (const f of source?.fields ?? [])
        if (f.type === 'select') expect(f.options?.length, `${id}.${f.key}`).toBeGreaterThan(0);
    }
  });

  it('una vista que las usa no se puede compartir por enlace', () => {
    for (const id of NEW_IDS) {
      const spec = viewSpecSchema.parse({
        version: 1,
        blocks: [{ id: 'b', type: 'table', title: 'T', tracker: id }],
      });
      expect(
        internalSourcesOf(spec).map((s) => s.id),
        id,
      ).toEqual([id]);
    }
  });

  it('el catálogo y el contrato aceptan sus campos y rechazan los que no tienen', () => {
    const catalog: CatalogTracker[] = [...PLATFORM_SOURCES.values()].map((s) => ({
      slug: s.id,
      name: s.name,
      fields: s.fields,
    }));
    const ok = viewSpecSchema.parse({
      version: 1,
      blocks: [
        {
          id: 'a',
          type: 'metric',
          title: 'Por pagar',
          tracker: 'cortex.por_pagar',
          aggregate: 'sum',
          field: 'neto',
        },
        { id: 'b', type: 'board', title: 'Etapas', tracker: 'cortex.comercial', groupBy: 'etapa' },
      ],
    });
    expect(checkSpecAgainst(ok, catalog)).toEqual([]);
    const bad = viewSpecSchema.parse({
      version: 1,
      blocks: [
        { id: 'x', type: 'table', title: 'X', tracker: 'cortex.nomina', columns: ['salario'] },
      ],
    });
    expect(checkSpecAgainst(bad, catalog).join(' ')).toContain('«salario» no es un campo');
  });
});

describe('cortex.por_pagar', () => {
  it('lee las facturas del espacio con neto, alertas y días; lo abierto va primero', async () => {
    const { db } = acme();
    const result = await read(db, 'cortex.por_pagar');
    expect(result.truncated).toBe(false);
    // Una de otra empresa no entra; lo abierto antes que lo pagado.
    expect(result.rows).toHaveLength(4);
    expect(result.rows.at(-1)?.values.estado).toBe('Pagada');
    const rows = byLabel(result.rows);
    expect(rows.get('Proveedor SAS · FP-1')).toMatchObject({
      proveedor: 'Proveedor SAS',
      numero: 'FP-1',
      vence: '2026-09-30',
      dias: 6,
      estado: 'Aprobada',
      total: 1190000,
      neto: 1100000,
      alertas: 1,
      revision: 'El precio subió 20 %.',
      origen: 'Correo (factura electrónica)',
    });
    expect(rows.get('Alfa Ltda · FP-2')).toMatchObject({
      estado: 'Programada',
      dias: -14,
      pagar_el: '2026-09-26',
    });
    expect(rows.get('Proveedor SAS · FP-3')).toMatchObject({
      estado: 'Pagada',
      pagada_el: '2026-09-05',
    });
    expect(rows.get('Proveedor SAS · FP-3')?.dias).toBeUndefined();
  });

  it('lo que está en dólares no entra en un campo de pesos', async () => {
    const { db } = acme();
    const usd = byLabel((await read(db, 'cortex.por_pagar')).rows).get('Proveedor SAS · EX-1');
    expect(usd).toMatchObject({ moneda: 'USD', total_otra_moneda: 3000, estado: 'Por aprobar' });
    expect(usd?.total).toBeUndefined();
    expect(usd?.neto).toBeUndefined();
  });

  it('respeta el tope y dice que hay más', async () => {
    const { db } = acme();
    const result = await readPlatformSource(db, 'cortex.por_pagar', 2, TODAY, { viewerId: ADMIN });
    expect(result?.rows).toHaveLength(2);
    expect(result?.truncated).toBe(true);
  });
});

describe('inventario y órdenes de compra', () => {
  it('inventario: existencia, mínimo, faltante y alerta; lo que pide atención primero', async () => {
    const { db } = acme();
    const result = await read(db, 'cortex.inventario');
    const rows = byLabel(result.rows);
    expect(result.rows[0]?.label).toBe('Tornillo');
    expect(rows.get('Tornillo')).toMatchObject({
      sku: 'TOR-1',
      existencia: 8,
      minimo: 20,
      faltante: 12,
      alerta: 'Bajo el mínimo',
      costo: 10000,
      precio: 15000,
      valor: 80000,
      proveedor: 'Tornillos SA',
    });
    expect(rows.get('Clavo')).toMatchObject({ existencia: 100, faltante: 0, alerta: 'Al día' });
    // Un costo en dólares no se pinta como pesos.
    const usd = rows.get('Importado');
    expect(usd).toMatchObject({ moneda: 'USD', existencia: 4 });
    expect(usd?.costo).toBeUndefined();
    expect(usd?.valor).toBeUndefined();
  });

  it('órdenes de compra: lo abierto primero, con atraso y sin mezclar monedas', async () => {
    const { db } = acme();
    const result = await read(db, 'cortex.ordenes_compra');
    expect(result.rows[0]?.label).toBe('OC-0007 · Tornillos SA');
    expect(byLabel(result.rows).get('OC-0007 · Tornillos SA')).toMatchObject({
      estado: 'Enviada',
      esperada: '2026-09-20',
      dias_para_llegar: -4,
      atrasada: 'Sí',
      total: 2500000,
      origen: 'Sugerencia de reposición',
    });
    expect(byLabel(result.rows).get('OC-0006 · Clavos SA')).toMatchObject({
      estado: 'Cerrada',
      atrasada: 'No',
      recibida: '2026-08-02',
    });
  });
});

describe('cortex.impuestos', () => {
  it('lo cumplido no está vencido ni tiene días; lo pendiente sí', async () => {
    const { db } = acme();
    const rows = byLabel((await read(db, 'cortex.impuestos')).rows);
    expect(rows.get('IVA bimestre 4')).toMatchObject({
      tipo: 'IVA',
      estado: 'Presentada',
      vence: '2026-09-15',
      // Una declaración que se paga no se cumple con presentarla (580-1 ET).
      vencida: 'Sí',
      dias: -9,
      requiere_pago: 'Sí',
    });
    expect(rows.get('ICA anual')).toMatchObject({
      estado: 'Pendiente',
      dias: 26,
      vencida: 'No',
      por_confirmar: 'Sí',
    });
  });
});

describe('cortex.nomina: sólo agregados, sólo para quien administra', () => {
  it('una fila por período con los totales, sin personas', async () => {
    const { db, tables } = acme();
    const result = await read(db, 'cortex.nomina', ADMIN);
    expect(result.blocked).toBeUndefined();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.values).toMatchObject({
      periodo: 'agosto 2026',
      frecuencia: 'Mensual',
      estado: 'Pagado',
      personas: 4,
      devengado: 12000000,
      deducciones: 960000,
      aportes: 3000000,
      neto: 11040000,
      costo_total: 17000000,
    });
    // Ninguna llave ni valor que identifique a una persona.
    const dump = JSON.stringify(result.rows);
    expect(dump).not.toContain('Persona Secreta');
    expect(dump).not.toContain('9999999');
    expect(Object.keys(result.rows[0]?.values ?? {})).not.toContain('persona');
    expect(tables.employees).toBeDefined();
  });

  it('no lee empleados ni desprendibles', async () => {
    const tables = world();
    const fake = createFakeSupabase(tables);
    const touched: string[] = [];
    const client = {
      ...fake.client,
      from: (table: string) => {
        touched.push(table);
        return fake.client.from(table);
      },
    } as unknown as typeof fake.client;
    const db = createOrgScopedClient(client, ACME);
    await read(db, 'cortex.nomina', ADMIN);
    expect(touched).toContain('payroll_periods');
    for (const forbidden of ['employees', 'payslips', 'payslip_items', 'payroll_novelties'])
      expect(touched, forbidden).not.toContain(forbidden);
  });

  it('quien no administra, o nadie, no la lee: sin filas y con la razón', async () => {
    const { db } = acme();
    for (const viewer of [BETO, null]) {
      const result = await read(db, 'cortex.nomina', viewer);
      expect(result.rows).toEqual([]);
      expect(result.blocked).toBe(NOMINA_RESTRICTED);
    }
  });

  it('en una vista, el bloque dice por qué en vez de «no se pudo leer»', async () => {
    const { db } = acme();
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [{ id: 'n', type: 'table', title: 'Nómina', tracker: 'cortex.nomina' }],
    });
    const sources = await loadViewSources(db, spec, { viewerId: BETO });
    expect(sources.get('cortex.nomina')?.blocked).toBe(NOMINA_RESTRICTED);
    const admin = await loadViewSources(db, spec, { viewerId: ADMIN });
    expect(admin.get('cortex.nomina')?.blocked).toBeUndefined();
    expect(admin.get('cortex.nomina')?.rows).toHaveLength(1);
  });
});

describe('cortex.contratos: lo laboral, sólo para su círculo', () => {
  it('quien administra ve todo, con vigencia, aviso y próxima obligación', async () => {
    const { db } = acme();
    const rows = byLabel((await read(db, 'cortex.contratos', ADMIN)).rows);
    expect([...rows.keys()].sort()).toEqual(['Arriendo bodega', 'Contrato de Carla']);
    expect(rows.get('Arriendo bodega')).toMatchObject({
      tipo: 'Arrendamiento comercial',
      contraparte: 'Inmobiliaria Sur',
      valor: 8000000,
      vence: '2026-12-31',
      aviso_hasta: '2026-11-01',
      estado: 'Vigente',
      responsable: 'Ana',
      proxima_obligacion: 'Pagar el canon',
      proxima_obligacion_vence: '2026-10-05',
      obligaciones_pendientes: 1,
      obligaciones_vencidas: 0,
    });
  });

  it('el contrato laboral no sale para otro compañero, ni sus obligaciones, ni sin sesión', async () => {
    const { db } = acme();
    for (const viewer of [BETO, null]) {
      const result = await read(db, 'cortex.contratos', viewer);
      expect(
        result.rows.map((r) => r.label),
        String(viewer),
      ).toEqual(['Arriendo bodega']);
      expect(JSON.stringify(result.rows)).not.toContain('Entregar dotación');
      expect(JSON.stringify(result.rows)).not.toContain('Carla');
    }
  });

  it('su responsable sí lo ve', async () => {
    const { db } = acme();
    const result = await read(db, 'cortex.contratos', CARLA);
    expect(result.rows.map((r) => r.label).sort()).toEqual([
      'Arriendo bodega',
      'Contrato de Carla',
    ]);
  });
});

describe('PQRS y cumplimiento', () => {
  it('pqrs: plazo y estado, sin el texto, la respuesta ni los datos de quien reclama', async () => {
    const { db } = acme();
    const result = await read(db, 'cortex.pqrs');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.values).toMatchObject({
      radicado: 'PQRS-2026-000001',
      clase: 'Reclamo',
      canal: 'Correo',
      asunto: 'Producto defectuoso',
      vence: '2026-10-02',
      vencida: 'No',
      estado: 'En trámite',
      responsable: 'Beto',
    });
    expect(result.rows[0]?.values.dias_habiles).toBeGreaterThan(0);
    const dump = JSON.stringify(result.rows);
    for (const secret of [
      'TEXTO PRIVADO',
      'RESPUESTA PRIVADA',
      'Persona Reclamante',
      'reclamante@correo.com',
      '3001112222',
    ])
      expect(dump).not.toContain(secret);
  });

  it('cumplimiento: lo pendiente con fecha pasada está vencido', async () => {
    const { db } = acme();
    const rows = byLabel((await read(db, 'cortex.cumplimiento')).rows);
    expect(rows.get('Actualizar el RNBD')).toMatchObject({
      area: 'Datos personales (SIC)',
      estado: 'Pendiente',
      vence: '2026-09-01',
      dias: -23,
      vencida: 'Sí',
      aplica: 'Sí',
      responsable: 'Beto',
    });
  });
});

describe('cortex.comercial', () => {
  it('etapa, estado, ponderado y responsable; el dólar va aparte', async () => {
    const { db } = acme();
    const rows = byLabel((await read(db, 'cortex.comercial')).rows);
    expect(rows.get('Flota de 10 camiones')).toMatchObject({
      cliente: 'Coltrans',
      etapa: 'Negociación',
      estado: 'Abierta',
      valor: 100000000,
      probabilidad: 70,
      ponderado: 70000000,
      cierre_esperado: '2026-10-15',
      responsable: 'Beto',
      proximo_paso: 'Enviar contrato',
      dias_sin_actividad: 10,
      origen: 'Referido',
    });
    const won = rows.get('Renovación');
    expect(won).toMatchObject({ estado: 'Ganada', moneda: 'USD', valor_otra_moneda: 3000 });
    expect(won?.valor).toBeUndefined();
    expect(won?.ganada).toBe('2026-09-20');
  });
});

describe('proyectos, flota y documentos que vencen', () => {
  it('proyectos: avance, horas, costo y margen con las cuentas del módulo', async () => {
    const { db } = acme();
    const result = await read(db, 'cortex.proyectos');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.label).toBe('OS-0003 · Montaje de bodega');
    expect(result.rows[0]?.values).toMatchObject({
      tipo: 'Orden de servicio',
      cliente: 'Coltrans',
      estado: 'En curso',
      responsable: 'Beto',
      entrega: '2026-10-01',
      dias_para_entrega: 7,
      presupuesto: 10000000,
      ingreso: 15000000,
      moneda: 'COP',
    });
  });

  it('flota: km, mantenimiento más urgente y papeles de cada vehículo', async () => {
    const { db } = acme();
    const result = await read(db, 'cortex.flota');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.values).toMatchObject({
      vehiculo: 'WGY482 · Chevrolet · NHR',
      tipo: 'Furgón',
      conductor: 'Pedro',
      km: 120000,
      mantenimiento: 'Cambio de aceite',
      soat_vence: '2026-09-01',
      tecnomecanica_vence: '2027-03-01',
      comparendos: 400000,
    });
    expect(result.rows[0]?.values.documentos_por_vencer).toBeGreaterThanOrEqual(1);
    expect(String(result.rows[0]?.values.atencion)).toContain('SOAT');
  });

  it('documentos que vencen: sólo lo confirmado, sin título del documento ni cita', async () => {
    const { db } = acme();
    const result = await read(db, 'cortex.documentos_vencen');
    expect(result.rows.map((r) => r.label).sort()).toEqual([
      'Póliza de responsabilidad civil',
      'SOAT WGY482',
    ]);
    const rows = byLabel(result.rows);
    expect(rows.get('Póliza de responsabilidad civil')).toMatchObject({
      tipo: 'Póliza',
      sujeto: 'La empresa',
      emisor: 'Seguros Bolívar',
      vence: '2026-10-10',
      dias: 16,
      // 16 días para vencer, con 45 de anticipación para renovar.
      estado: 'Por vencer',
      responsable: 'Ana',
      aviso_dias: 45,
    });
    expect(rows.get('SOAT WGY482')).toMatchObject({ estado: 'Vencido', dias: -23 });
    const dump = JSON.stringify(result.rows);
    expect(dump).not.toContain('CITA PRIVADA');
    expect(dump).not.toContain('Licencia propuesta');
  });
});

describe('el interruptor del módulo', () => {
  it('con el módulo apagado la fuente no se lee y dice por qué', async () => {
    const tables = world();
    tables.company_modules = modules(
      ALL_MODULES.filter((m) => m !== 'payables' && m !== 'fleet'),
      ['payables', 'fleet'],
    );
    const { db } = acme(tables);
    for (const [id, label] of [
      ['cortex.por_pagar', 'Cuentas por pagar'],
      ['cortex.flota', 'Flota y rutas'],
    ] as const) {
      const result = await read(db, id);
      expect(result.rows, id).toEqual([]);
      expect(result.blocked, id).toBe(
        `El módulo ${label} está apagado; un administrador lo prende en Ajustes › Módulos.`,
      );
    }
    // Y la de un módulo que sigue prendido, igual que siempre.
    expect((await read(db, 'cortex.impuestos')).rows).toHaveLength(2);
  });

  it('las dos fuentes de inventario y las dos de cumplimiento van con su módulo', async () => {
    const tables = world();
    tables.company_modules = modules(
      ALL_MODULES.filter((m) => m !== 'inventory' && m !== 'compliance'),
      ['inventory', 'compliance'],
    );
    const { db } = acme(tables);
    for (const id of [
      'cortex.inventario',
      'cortex.ordenes_compra',
      'cortex.pqrs',
      'cortex.cumplimiento',
    ])
      expect((await read(db, id)).blocked, id).toContain('está apagado');
  });

  it('los módulos que una empresa nunca tocó siguen su valor por defecto', async () => {
    // Sin filas en company_modules: inventario, nómina, cumplimiento, proyectos
    // y flota nacen apagados; las cuentas por pagar, prendidas.
    const tables = world();
    tables.company_modules = [];
    const { db } = acme(tables);
    expect((await read(db, 'cortex.por_pagar')).blocked).toBeUndefined();
    for (const id of [
      'cortex.inventario',
      'cortex.nomina',
      'cortex.cumplimiento',
      'cortex.proyectos',
      'cortex.flota',
    ])
      expect((await read(db, id)).blocked, id).toContain('está apagado');
  });

  it('en una vista, el bloque lleva el aviso del módulo y los demás siguen', async () => {
    const tables = world();
    tables.company_modules = modules(
      ALL_MODULES.filter((m) => m !== 'payables'),
      ['payables'],
    );
    const { db } = acme(tables);
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [
        { id: 'p', type: 'table', title: 'Por pagar', tracker: 'cortex.por_pagar' },
        { id: 'i', type: 'table', title: 'Impuestos', tracker: 'cortex.impuestos' },
      ],
    });
    const sources = await loadViewSources(db, spec, { viewerId: ADMIN });
    expect(sources.get('cortex.por_pagar')?.blocked).toContain('Cuentas por pagar');
    expect(sources.get('cortex.impuestos')?.rows).toHaveLength(2);
    const view = computeView(spec, sources, new Date(`${TODAY}T15:00:00Z`));
    expect(view.blocks.find((b) => b.id === 'p')?.type).toBe('problem');
  });

  it('el catálogo la conserva pero la marca, para que el diseñador no la ofrezca', async () => {
    const tables = world();
    tables.company_modules = modules(
      ALL_MODULES.filter((m) => m !== 'payables'),
      ['payables'],
    );
    const { db } = acme(tables);
    const catalog = await viewCatalog(db, { viewerId: ADMIN });
    expect(catalog.find((c) => c.slug === 'cortex.por_pagar')?.moduleOff).toContain(
      'Cuentas por pagar',
    );
    expect(catalog.find((c) => c.slug === 'cortex.impuestos')?.moduleOff).toBeUndefined();
    // Una fuente de un módulo apagado sigue validando: un spec guardado no se rompe.
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [{ id: 'p', type: 'table', title: 'P', tracker: 'cortex.por_pagar' }],
    });
    expect(checkSpecAgainst(spec, catalog)).toEqual([]);
  });
});

describe('el aislamiento por espacio', () => {
  it('no trae filas de otra empresa', async () => {
    const tables = world();
    const { db } = acme(tables);
    const result = await read(db, 'cortex.por_pagar');
    expect(JSON.stringify(result.rows)).not.toContain('GX-1');
  });
});
