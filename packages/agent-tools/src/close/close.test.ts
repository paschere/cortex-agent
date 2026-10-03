import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { type ProviderSession, ProviderUncertainError } from '../accounting/types';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { collectCierre } from './autopilot-collect';
import { assertPeriodOpen, openOverrideWindow } from './lock';
import { renderClosePdf } from './pdf';
import {
  type CloseCheckData,
  PeriodLockedError,
  defaultClosePeriod,
  evaluateCheck,
  isLocked,
  periodEnd,
  progressOf,
  taskReady,
  tasksFor,
} from './shape';
import { closePeriod, computeClose, markCloseTask, refreshClose, reopenPeriod } from './store';
import type { ProviderWriter } from './writeback/shape';
import { executeWriteback, loadWritebackQueue } from './writeback/store';

/**
 * El cierre del mes contra el doble de PostgREST (que ejecuta los filtros de
 * verdad) y un programa contable de mentira: lo que importa es lo que queda
 * escrito, qué se bloquea y cuántas veces se le habla al programa.
 */

const ORG = 'org-andina';
const ADMIN = '11111111-1111-4111-a111-111111111111';
const MEMBER = '22222222-2222-4222-a222-222222222222';
type Row = Record<string, unknown>;

let seq = 0;
const nextId = () => `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`;

function world(seed: Record<string, Row[]> = {}) {
  const fake = createFakeSupabase({
    users: [
      { id: ADMIN, organization_id: ORG, role: 'org_admin', email: 'dueno@andina.co' },
      { id: MEMBER, organization_id: ORG, role: 'member', email: 'ana@andina.co' },
    ],
    company_modules: [],
    close_periods: [],
    close_tasks: [],
    close_events: [],
    audit_events: [],
    ledger_accounts: [],
    ledger_movements: [],
    payment_reports: [],
    payments: [],
    payable_invoices: [],
    accounting_connections: [],
    accounting_writebacks: [],
    accounting_account_map: [],
    accounting_invoices: [],
    tax_obligations: [],
    stock_movements: [],
    clients: [],
    ...seed,
  });
  const from = fake.client.from.bind(fake.client);
  const stamp = (table: string, values: Row | Row[]) =>
    (Array.isArray(values) ? values : [values]).map((r) => ({
      id: nextId(),
      created_at: '2026-10-03T00:00:00Z',
      updated_at: '2026-10-03T00:00:00Z',
      ...(table === 'close_periods' ? { summary: {}, override_until: null, closed_at: null } : {}),
      ...(table === 'close_tasks'
        ? {
            status: 'pendiente',
            owner_id: null,
            evidence: null,
            evidence_url: null,
            auto_check: null,
            done_by: null,
            done_at: null,
          }
        : {}),
      ...(table === 'accounting_writebacks'
        ? {
            attempts: 0,
            provider_id: null,
            provider_number: null,
            error: null,
            discard_reason: null,
          }
        : {}),
      ...r,
    }));
  const raw = {
    ...fake.client,
    rpc: fake.client.rpc,
    from: (table: string) => {
      // biome-ignore lint/suspicious/noExplicitAny: envuelve el builder del doble
      const qb = from(table) as any;
      const insert = qb.insert.bind(qb);
      const upsert = qb.upsert.bind(qb);
      qb.insert = (values: Row | Row[]) => {
        const list = stamp(table, values);
        return insert(Array.isArray(values) ? list : list[0]);
      };
      qb.upsert = (
        values: Row | Row[],
        opts?: { onConflict?: string; ignoreDuplicates?: boolean },
      ) => {
        // Como Postgres: con ignoreDuplicates, lo que ya existe no se toca.
        const keys = (opts?.onConflict ?? '').split(',').filter(Boolean);
        const rows = (fake.tables[table] ?? []) as Row[];
        const fresh = stamp(table, values).filter(
          (v) =>
            !(
              opts?.ignoreDuplicates &&
              keys.length &&
              rows.some((r) =>
                keys.every((k) => r[k] === (k === 'organization_id' ? ORG : (v as Row)[k])),
              )
            ),
        );
        return upsert(fresh, opts);
      };
      return qb;
    },
  } as unknown as SupabaseClient;
  return { db: createOrgScopedClient(raw, ORG), tables: fake.tables };
}

const SIIGO_CONN = {
  id: 'conn-siigo',
  organization_id: ORG,
  provider: 'siigo',
  enabled: true,
  created_by: ADMIN,
  account_label: 'api@andina.co',
  created_at: '2026-01-01T00:00:00Z',
};

function payable(over: Row = {}): Row {
  return {
    id: nextId(),
    organization_id: ORG,
    supplier_id: null,
    source: 'correo',
    source_system: 'gmail',
    source_ref: `msg-${seq}`,
    cufe: null,
    doc_number: 'FEPA-451',
    dedupe_key: '900123456:FEPA451',
    supplier_nit: '900123456',
    supplier_dv: '7',
    supplier_name: 'Papelería El Cóndor',
    customer_nit: null,
    currency: 'COP',
    issue_date: '2026-09-12',
    due_date: '2026-10-12',
    subtotal: 1_000_000,
    iva: 190_000,
    other_taxes: 0,
    total: 1_190_000,
    retefuente: 25_000,
    reteiva: 0,
    reteica: 0,
    net_amount: 1_165_000,
    lines: [],
    status: 'aprobada',
    checks: [],
    approved_at: '2026-09-13T00:00:00Z',
    paid_at: null,
    paid_evidence: null,
    ledger_movement_id: null,
    evidence: {},
    created_at: '2026-09-12T00:00:00Z',
    updated_at: '2026-09-12T00:00:00Z',
    ...over,
  };
}

function fakeSession(writer: Partial<ProviderWriter> = {}) {
  const send = vi.fn(async () => ({ id: 'siigo-purchase-1', number: 'FC-2-22', status: null }));
  const w: ProviderWriter = {
    provider: 'siigo',
    supports: { compra: true, recibo: true, pago_proveedor: true },
    prepare: async () => ({ payload: { document: { id: 1 } }, problems: [], warnings: [] }),
    send,
    ...writer,
  };
  const session = { writer: w, requests: 0 } as unknown as ProviderSession;
  return { session, send: (w.send as typeof send) ?? send, openSession: async () => session };
}

// ---------------------------------------------------------------------------
// Puro
// ---------------------------------------------------------------------------

describe('la revisión automática, de los datos a un estado', () => {
  const P = '2026-09';
  const full: CloseCheckData = {
    bankAccounts: [
      { name: 'Bancolombia', lastDate: '2026-09-29' },
      { name: 'Davivienda', lastDate: '2026-09-15' },
    ],
    bankUnmatched: { count: 2, amount: 1_500_000 },
    payablesAwaiting: 0,
    purchasesToBook: 3,
    receiptsToRegister: null,
    supplierPaymentsToRegister: 0,
    uncategorized: { count: 0, amount: 0 },
    payrollRecorded: true,
    taxPending: [{ title: 'Retención en la fuente de agosto', dueDate: '2026-09-10' }],
    taxDue: 2,
    inventoryCounted: false,
  };

  it('dice qué falta y cuánto, en una frase', () => {
    expect(evaluateCheck('extractos', full, P)).toMatchObject({ state: 'pendiente', count: 1 });
    expect(evaluateCheck('extractos', full, P).detail).toMatch(/Davivienda \(va hasta el 15 sep\)/);
    expect(evaluateCheck('conciliacion', full, P)).toMatchObject({ state: 'pendiente', count: 2 });
    expect(evaluateCheck('facturas_proveedor', full, P).state).toBe('ok');
    expect(evaluateCheck('causacion', full, P)).toMatchObject({ state: 'pendiente', count: 3 });
    // Sin programa que lo registre: no aplica, no «al día».
    expect(evaluateCheck('recibos', full, P).state).toBe('no_aplica');
    expect(evaluateCheck('pagos_proveedor', full, P).state).toBe('ok');
    expect(evaluateCheck('sin_categoria', full, P).state).toBe('ok');
    expect(evaluateCheck('nomina', full, P).state).toBe('ok');
    expect(evaluateCheck('impuestos', full, P).detail).toMatch(/Retención en la fuente de agosto/);
    expect(evaluateCheck('inventario', full, P).state).toBe('pendiente');
    expect(evaluateCheck('provisiones', full, P).state).toBe('manual');
  });

  it('una lectura que falló es «no pude revisar», nunca «al día»', () => {
    for (const key of [
      'extractos',
      'conciliacion',
      'causacion',
      'sin_categoria',
      'impuestos',
    ] as const)
      expect(evaluateCheck(key, {}, P).state).toBe('error');
    expect(taskReady({ key: 'x', status: 'pendiente', auto: { state: 'error', detail: '' } })).toBe(
      false,
    );
  });

  it('el extracto cubre el mes si llega a los últimos tres días', () => {
    expect(
      evaluateCheck('extractos', { bankAccounts: [{ name: 'B', lastDate: '2026-09-27' }] }, P)
        .state,
    ).toBe('ok');
    expect(
      evaluateCheck('extractos', { bankAccounts: [{ name: 'B', lastDate: '2026-09-26' }] }, P)
        .state,
    ).toBe('pendiente');
    expect(periodEnd('2026-02')).toBe('2026-02-28');
    expect(periodEnd('2028-02')).toBe('2028-02-29');
  });

  it('lista: al día, o hecha/no aplica por una persona', () => {
    const tasks = [
      { key: 'a', status: 'pendiente' as const, auto: { state: 'ok' as const, detail: '' } },
      { key: 'b', status: 'hecha' as const, auto: { state: 'pendiente' as const, detail: '' } },
      { key: 'c', status: 'pendiente' as const, auto: { state: 'manual' as const, detail: '' } },
    ];
    expect(progressOf(tasks)).toEqual({ done: 2, total: 3 });
  });

  it('el mes que toca: el anterior mientras no esté cerrado', () => {
    expect(defaultClosePeriod('2026-10-03', () => null)).toBe('2026-09');
    expect(defaultClosePeriod('2026-10-03', (p) => (p === '2026-09' ? 'cerrado' : null))).toBe(
      '2026-10',
    );
    expect(defaultClosePeriod('2026-01-02', () => null)).toBe('2025-12');
  });

  it('las tareas de módulos apagados no existen', () => {
    const keys = tasksFor(new Set(['finance', 'payables'])).map((t) => t.key);
    expect(keys).toContain('sin_categoria');
    expect(keys).not.toContain('nomina');
    expect(keys).not.toContain('inventario');
    expect(keys).not.toContain('impuestos');
  });

  it('el candado: cerrado bloquea, salvo una ventana abierta', () => {
    const now = new Date('2026-10-03T15:00:00Z');
    expect(isLocked({ status: 'cerrado', override_until: null }, now)).toBe(true);
    expect(isLocked({ status: 'cerrado', override_until: '2026-10-03T16:00:00Z' }, now)).toBe(
      false,
    );
    expect(isLocked({ status: 'cerrado', override_until: '2026-10-03T14:00:00Z' }, now)).toBe(true);
    expect(isLocked({ status: 'en_cierre', override_until: null }, now)).toBe(false);
    expect(isLocked(null, now)).toBe(false);
  });

  it('el piloto: «Cierre de septiembre: faltan 4 cosas»', () => {
    const [item] = collectCierre(
      { period: '2026-09', pending: 4, total: 9, missing: ['A', 'B', 'C', 'D'] },
      '2026-10-02',
    );
    expect(item?.title).toBe('Cierre de septiembre: faltan 4 cosas');
    expect(item?.proposedAction).toBeNull();
    expect(item?.href).toBe('/cierre?mes=2026-09');
    expect(collectCierre(undefined, '2026-10-02')).toEqual([]);
  });

  it('el PDF sale con su cabecera', () => {
    const bytes = renderClosePdf(
      {
        label: 'Septiembre de 2026',
        status: 'cerrado',
        closedAt: '2026-10-04T10:00:00Z',
        closedByName: 'Dueña',
        note: null,
        progress: { done: 2, total: 2 },
        tasks: [
          {
            title: 'Extractos',
            status: 'pendiente',
            ready: true,
            detail: 'Al día',
            evidence: null,
            doneByName: null,
          },
          {
            title: 'Conciliación',
            status: 'hecha',
            ready: true,
            detail: '1 abono',
            evidence: 'Préstamo del socio',
            doneByName: 'Ana',
          },
        ],
        writebacks: [{ label: 'Causar factura de compra', count: 3, amount: 3_500_000 }],
        providerName: 'Siigo',
        generatedAt: '2026-10-04T10:00:00Z',
      },
      { name: 'Andina', primary: '#1f6feb', logo: null },
    );
    expect(Buffer.from(bytes.slice(0, 8)).toString('latin1')).toBe('%PDF-1.4');
  });
});

// ---------------------------------------------------------------------------
// Contra la base
// ---------------------------------------------------------------------------

describe('la lista del mes contra la base', () => {
  it('crea el mes y sus tareas una sola vez, y guarda la revisión', async () => {
    const { db, tables } = world({
      payable_invoices: [payable({ status: 'por_aprobar' })],
    });
    const view = await refreshClose(db, '2026-09');
    expect(view.status).toBe('abierto');
    expect(view.tasks.find((t) => t.key === 'facturas_proveedor')?.auto).toMatchObject({
      state: 'pendiente',
      count: 1,
    });
    // Sin programa contable: causar/recibos/pagos no aplican.
    expect(view.tasks.find((t) => t.key === 'causacion')?.auto.state).toBe('no_aplica');
    await refreshClose(db, '2026-09');
    expect(tables.close_periods).toHaveLength(1);
    expect(tables.close_tasks?.length).toBe(view.tasks.length);
    expect((tables.close_tasks?.[0] as Row).auto_check).toBeTruthy();
  });

  it('dar por hecha una tarea que la revisión ve pendiente exige evidencia', async () => {
    const { db, tables } = world({ payable_invoices: [payable({ status: 'por_aprobar' })] });
    await expect(
      markCloseTask(db, {
        period: '2026-09',
        key: 'facturas_proveedor',
        status: 'hecha',
        userId: MEMBER,
      }),
    ).rejects.toThrow(/explica por qué/);
    const view = await markCloseTask(db, {
      period: '2026-09',
      key: 'facturas_proveedor',
      status: 'hecha',
      evidence: 'Es una cotización, no una factura',
      userId: MEMBER,
    });
    expect(view.tasks.find((t) => t.key === 'facturas_proveedor')?.ready).toBe(true);
    expect(view.status).toBe('en_cierre');
    expect(tables.close_events?.some((e) => (e as Row).kind === 'tarea')).toBe(true);
  });

  it('cerrar: sólo un administrador y sólo con la lista completa; después, todo bloqueado', async () => {
    const { db, tables } = world();
    await expect(closePeriod(db, { period: '2026-09', userId: MEMBER })).rejects.toThrow(
      /administrador/,
    );
    await expect(closePeriod(db, { period: '2026-09', userId: ADMIN })).rejects.toThrow(
      /Todavía no se puede cerrar/,
    );

    // Lo que no está al día se explica o se marca no aplica.
    const view = await computeClose(db, '2026-09');
    for (const t of view.tasks.filter((x) => !x.ready))
      await markCloseTask(db, {
        period: '2026-09',
        key: t.key,
        status: 'no_aplica',
        evidence: 'No aplica este mes en la empresa de prueba',
        userId: ADMIN,
      });
    const closed = await closePeriod(db, { period: '2026-09', userId: ADMIN, note: 'Sin novedad' });
    expect(closed.closed).toBe(true);
    expect(closed.view.status).toBe('cerrado');
    expect(closed.view.locked).toBe(true);
    expect(((tables.close_periods?.[0] as Row).summary as Row).total).toBe(view.tasks.length);

    // El candado: marcar, anotar con fecha del mes.
    await expect(
      markCloseTask(db, {
        period: '2026-09',
        key: 'provisiones',
        status: 'pendiente',
        userId: ADMIN,
      }),
    ).rejects.toBeInstanceOf(PeriodLockedError);
    await expect(
      assertPeriodOpen(db, '2026-09-15', {
        action: 'anotar un movimiento en el libro',
        userId: MEMBER,
      }),
    ).rejects.toThrow(/Septiembre de 2026 está cerrado/);
    await assertPeriodOpen(db, '2026-10-01', { action: 'anotar', userId: MEMBER });
    expect(
      tables.close_events?.filter((e) => (e as Row).kind === 'bloqueado').length,
    ).toBeGreaterThanOrEqual(1);

    // La ventana de cambios: sólo un administrador, con motivo, y queda anotada.
    await expect(
      openOverrideWindow(db, { period: '2026-09', userId: MEMBER, reason: 'corregir' }),
    ).rejects.toThrow(/administrador/);
    await openOverrideWindow(db, {
      period: '2026-09',
      userId: ADMIN,
      reason: 'Faltó la factura del arriendo',
    });
    await assertPeriodOpen(db, '2026-09-15', { action: 'anotar', userId: MEMBER });
    expect(tables.close_events?.some((e) => (e as Row).kind === 'ventana')).toBe(true);

    // Reabrir: con motivo, y vuelve a en_cierre.
    const reopened = await reopenPeriod(db, {
      period: '2026-09',
      userId: ADMIN,
      reason: 'Llegó una nota crédito',
    });
    expect(reopened.status).toBe('en_cierre');
    expect(tables.audit_events?.some((e) => (e as Row).tool_id === 'close.reopen')).toBe(true);
  });
});

describe('registrar en el programa: idempotente y nunca dos veces', () => {
  const ctxFor = (db: SupabaseClient) => ({ db, organizationId: ORG, userId: ADMIN });

  it('causa una compra aprobada una sola vez, aunque se pida dos', async () => {
    const p = payable();
    const { db, tables } = world({ accounting_connections: [SIIGO_CONN], payable_invoices: [p] });
    const queue = await loadWritebackQueue(db, { period: '2026-09' });
    expect(queue.items.map((i) => [i.kind, i.sourceId])).toEqual([['compra', p.id]]);

    const fake = fakeSession();
    const first = await executeWriteback(ctxFor(db), 'compra', p.id as string, {
      openSession: fake.openSession,
    });
    expect(first).toMatchObject({ status: 'registrada', providerNumber: 'FC-2-22' });
    const second = await executeWriteback(ctxFor(db), 'compra', p.id as string, {
      openSession: fake.openSession,
    });
    expect(second.status).toBe('ya_registrada');
    expect(fake.send).toHaveBeenCalledTimes(1);
    const row = tables.accounting_writebacks?.[0] as Row;
    expect(row).toMatchObject({
      status: 'registrada',
      provider_id: 'siigo-purchase-1',
      kind: 'compra',
    });
    expect(String(row.idempotency_key)).toMatch(/^CXW[0-9a-f]{27}$/);
    // Ya no está en la cola.
    expect((await loadWritebackQueue(db, { period: '2026-09' })).items).toEqual([]);
  });

  it('la red se corta: queda incierta, no se repite sola, y al repetir primero se busca', async () => {
    const p = payable();
    const { db, tables } = world({ accounting_connections: [SIIGO_CONN], payable_invoices: [p] });
    const cut = fakeSession({
      send: vi.fn(async () => {
        throw new ProviderUncertainError('La conexión con Siigo se cortó');
      }),
    });
    await expect(
      executeWriteback(ctxFor(db), 'compra', p.id as string, { openSession: cut.openSession }),
    ).rejects.toThrow(/se cortó/);
    expect((tables.accounting_writebacks?.[0] as Row).status).toBe('incierta');
    await expect(
      executeWriteback(ctxFor(db), 'compra', p.id as string, { openSession: cut.openSession }),
    ).rejects.toThrow(/pide reintentar/);

    const found = fakeSession({
      find: vi.fn(async () => ({ id: 'siigo-found', number: 'FC-2-23' })),
    });
    const out = await executeWriteback(ctxFor(db), 'compra', p.id as string, {
      openSession: found.openSession,
      retryUncertain: true,
    });
    expect(out).toMatchObject({ status: 'ya_registrada', providerNumber: 'FC-2-23' });
    expect(found.send).not.toHaveBeenCalled();
  });

  it('un problema de la vista previa no manda nada; un mes cerrado tampoco', async () => {
    const p = payable();
    const { db } = world({
      accounting_connections: [SIIGO_CONN],
      payable_invoices: [p],
      close_periods: [
        {
          id: 'cp-1',
          organization_id: ORG,
          period: '2026-09',
          status: 'cerrado',
          closed_at: '2026-10-02T00:00:00Z',
          override_until: null,
          summary: {},
        },
      ],
    });
    const blocked = fakeSession();
    await expect(
      executeWriteback(ctxFor(db), 'compra', p.id as string, { openSession: blocked.openSession }),
    ).rejects.toBeInstanceOf(PeriodLockedError);
    expect(blocked.send).not.toHaveBeenCalled();

    const { db: db2 } = world({
      accounting_connections: [SIIGO_CONN],
      payable_invoices: [payable({ supplier_nit: null })],
    });
    const p2 = (await loadWritebackQueue(db2)).items[0];
    const s2 = fakeSession();
    await expect(
      executeWriteback(ctxFor(db2), 'compra', p2?.sourceId as string, {
        openSession: s2.openSession,
      }),
    ).rejects.toThrow(/no tiene NIT/);
    expect(s2.send).not.toHaveBeenCalled();
  });

  it('una factura que no está aprobada no se causa', async () => {
    const p = payable({ status: 'por_aprobar' });
    const { db } = world({ accounting_connections: [SIIGO_CONN], payable_invoices: [p] });
    await expect(
      executeWriteback(ctxFor(db), 'compra', p.id as string, {
        openSession: fakeSession().openSession,
      }),
    ).rejects.toThrow(/no está aprobada/);
  });

  it('el pago a proveedor sólo aparece cuando la compra ya está en el programa', async () => {
    const p = payable({
      status: 'pagada',
      paid_at: '2026-09-28',
      paid_evidence: { kind: 'bank', movementId: null, reference: 'PAGO PROV CONDOR' },
    });
    const { db } = world({ accounting_connections: [SIIGO_CONN], payable_invoices: [p] });
    let q = await loadWritebackQueue(db, { period: '2026-09' });
    expect(q.items.map((i) => i.kind)).toEqual(['compra']);
    await executeWriteback(ctxFor(db), 'compra', p.id as string, {
      openSession: fakeSession().openSession,
    });
    q = await loadWritebackQueue(db, { period: '2026-09' });
    expect(q.items.map((i) => i.kind)).toEqual(['pago_proveedor']);
    expect(q.done.map((i) => i.kind)).toEqual(['compra']);
  });
});
