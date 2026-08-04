import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classify, decide } from '../../security/policy';
import type { ToolContext } from '../../types';
import { vehiclesCheckRunt } from '../check-runt';
import { vehiclesCheckSimit } from '../check-simit';
import type { RawFine } from '../client';
import { vehiclesGet } from '../get';
import { vehiclesList } from '../list';
import { vehiclesRecentlyChanged } from '../recently-changed';
import { vehiclesRegister } from '../register';

const USER = '00000000-0000-0000-0000-000000000001';
const OTHER_USER = '00000000-0000-0000-0000-0000000000ff';
const SCRAPER = 'http://scraper.test';

// ---------------------------------------------------------------------------
// A database double that behaves like the schema, not like a canned response.
//
// Every vehicles tool is a merge: register is an upsert, the SIMIT check
// diffs a snapshot against history, and the watch report reads what both left
// behind. None of that can be tested against a stub returning fixed rows — the
// interesting bugs are all "the second call did the wrong thing". So this
// implements the handful of Postgres behaviours the tools rely on: filters,
// ordering, insert defaults, and conflict handling on (vehicle_id, comparendo).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}-${++idSeq}`;

const DEFAULTS: Record<string, () => Row> = {
  vehicles: () => ({
    id: nextId('veh'),
    label: null,
    owner_doc_type: null,
    owner_doc_number: null,
    brand: null,
    line: null,
    model_year: null,
    notes: null,
    runt_estado: null,
    soat_expires_at: null,
    rtm_expires_at: null,
    last_runt_sync: null,
    last_simit_sync: null,
    total_pending_cop: 0,
    archived: false,
  }),
  vehicle_fines: () => ({
    id: nextId('fine'),
    description: '',
    amount_cop: 0,
    issued_at: null,
    status: 'PENDING',
    location: null,
    secretaria: null,
    comparendo: null,
    detected_at: new Date().toISOString(),
  }),
  vehicle_consults: () => ({
    id: nextId('con'),
    message: null,
    fines_found: 0,
    ran_at: new Date().toISOString(),
  }),
};

type Op = 'select' | 'insert' | 'update' | 'upsert';
type Filter =
  | { kind: 'eq' | 'gte'; col: string; value: unknown }
  | { kind: 'in'; col: string; values: unknown[] };

class Builder implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: Op | null = null;
  private payload: Row[] = [];
  private filters: Filter[] = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private rowMode: 'many' | 'single' | 'maybe' = 'many';
  private conflictCols: string[] = [];
  private ignoreDuplicates = false;

  constructor(
    private readonly store: Record<string, Row[]>,
    private readonly table: string,
  ) {}

  select(_cols?: string) {
    if (this.op === null) this.op = 'select';
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = 'insert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  update(patch: Row) {
    this.op = 'update';
    this.payload = [patch];
    return this;
  }
  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = 'upsert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.conflictCols = (opts?.onConflict ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    this.ignoreDuplicates = !!opts?.ignoreDuplicates;
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters.push({ kind: 'eq', col, value });
    return this;
  }
  gte(col: string, value: unknown) {
    this.filters.push({ kind: 'gte', col, value });
    return this;
  }
  in(col: string, values: unknown[]) {
    this.filters.push({ kind: 'in', col, values });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  single() {
    this.rowMode = 'single';
    return this;
  }
  maybeSingle() {
    this.rowMode = 'maybe';
    return this;
  }

  private rows(): Row[] {
    const existing = this.store[this.table];
    if (existing) return existing;
    const created: Row[] = [];
    this.store[this.table] = created;
    return created;
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => {
      if (f.kind === 'eq') return row[f.col] === f.value;
      if (f.kind === 'in') return f.values.includes(row[f.col]);
      return String(row[f.col] ?? '') >= String(f.value);
    });
  }

  private run(): Row[] {
    const table = this.rows();
    if (this.op === 'insert' || this.op === 'upsert') {
      const written: Row[] = [];
      for (const incoming of this.payload) {
        if (this.op === 'upsert' && this.conflictCols.length) {
          const keyed = this.conflictCols.every(
            (c) => incoming[c] !== null && incoming[c] !== undefined,
          );
          const clash =
            keyed && table.find((r) => this.conflictCols.every((c) => r[c] === incoming[c]));
          if (clash) {
            // `ignoreDuplicates` maps to Prefer: resolution=ignore-duplicates —
            // the row is skipped and never appears in the returned set, which
            // is precisely how check_simit knows a fine is not new.
            if (!this.ignoreDuplicates) Object.assign(clash, incoming);
            continue;
          }
        }
        const row = { ...(DEFAULTS[this.table]?.() ?? { id: nextId('row') }), ...incoming };
        table.push(row);
        written.push(row);
      }
      return written;
    }
    if (this.op === 'update') {
      const hit = table.filter((r) => this.matches(r));
      for (const r of hit) Object.assign(r, this.payload[0]);
      return hit;
    }
    let out = table.filter((r) => this.matches(r));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out = [...out].sort((a, b) => {
        const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
        return asc ? cmp : -cmp;
      });
    }
    return out;
  }

  // biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are thenables; the stub must be one to stand in for them.
  then<R1 = { data: unknown; error: unknown }, R2 = never>(
    onfulfilled?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    let result: { data: unknown; error: unknown };
    try {
      const rows = this.run().map((r) => ({ ...r }));
      if (this.rowMode === 'single') {
        result = rows.length
          ? { data: rows[0], error: null }
          : { data: null, error: { message: 'no rows returned' } };
      } else if (this.rowMode === 'maybe') {
        result = { data: rows[0] ?? null, error: null };
      } else {
        result = { data: rows, error: null };
      }
    } catch (err) {
      result = { data: null, error: err };
    }
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

function makeDb(seed: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = {
    vehicles: [],
    vehicle_fines: [],
    vehicle_consults: [],
    ...seed,
  };
  return { store, client: { from: (table: string) => new Builder(store, table) } };
}

type Db = ReturnType<typeof makeDb>;

let db: Db;

const fakeCtx = (userId = USER): ToolContext =>
  ({
    userId,
    agentId: '00000000-0000-0000-0000-000000000002',
    db: db.client as unknown as ToolContext['db'],
    integrations: {
      getAccessToken: async () => ({ token: 't', scopes: [] }),
      hasScopes: async () => true,
    },
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    },
  }) as unknown as ToolContext;

// ---------------------------------------------------------------------------
// The consult service
// ---------------------------------------------------------------------------

const RUNT_URL = `${SCRAPER}/consult/runt`;
const SIMIT_URL = `${SCRAPER}/consult/simit`;

const RUNT_OK = {
  source: 'RUNT',
  plate: 'ABC123',
  consultedAt: '2026-08-01T12:00:00.000Z',
  estado: 'ACTIVO',
  // RUNT hands dates back as dd/mm/yyyy at least as often as ISO.
  soatVigenteHasta: '31/12/2026',
  rtmVigenteHasta: '10/08/2026',
  marca: 'MAZDA',
  linea: 'CX-5 TOURING',
  info: { modelo: '2019', color: 'ROJO', clase: 'AUTOMOVIL' },
};

const FINE_A: RawFine = {
  code: 'C14',
  description: 'Transitar por sitios restringidos',
  amountCop: 522_000,
  issuedAt: '2026-05-04T00:00:00.000Z',
  status: 'PENDING',
  location: 'Bogotá',
  secretaria: 'Secretaría de Movilidad',
  comparendo: '11001000000012345678',
};

const FINE_B: RawFine = {
  code: 'D02',
  description: 'Conducir sin licencia vigente',
  amountCop: 1_160_000,
  issuedAt: '2026-07-19T00:00:00.000Z',
  status: 'PENDING',
  location: 'Chía',
  secretaria: 'Secretaría de Movilidad',
  comparendo: '25175000000098765432',
};

const simitBody = (fines: RawFine[], totalPendingCop: number) => ({
  source: 'SIMIT',
  plate: 'ABC123',
  consultedAt: '2026-08-01T12:05:00.000Z',
  fines,
  totalPendingCop,
});

const server = setupServer(
  http.post(RUNT_URL, () => HttpResponse.json(RUNT_OK)),
  http.post(SIMIT_URL, () => HttpResponse.json(simitBody([FINE_A], FINE_A.amountCop))),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
  server.resetHandlers();
  db = makeDb();
  process.env.VEHICLES_SCRAPER_URL = SCRAPER;
  process.env.VEHICLES_SCRAPER_API_KEY = 'test-key';
});
afterEach(() => {
  process.env.VEHICLES_SCRAPER_URL = '';
  process.env.VEHICLES_SCRAPER_API_KEY = '';
});

const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function register(plate = 'ABC123', extra: Record<string, unknown> = {}) {
  return vehiclesRegister.handler(
    { plate, ownerDocType: 'CC', ownerDocNumber: '1020304050', ...extra } as Parameters<
      typeof vehiclesRegister.handler
    >[0],
    fakeCtx(),
  );
}

// ---------------------------------------------------------------------------

describe('Vehicles tools — not configured', () => {
  beforeEach(() => {
    process.env.VEHICLES_SCRAPER_URL = '';
    process.env.VEHICLES_SCRAPER_API_KEY = '';
  });

  it('every tool fails soft with a human sentence', async () => {
    const registered = await register();
    expect(registered.created).toBe(true);

    const results = [
      registered,
      await vehiclesList.handler({ includeArchived: false, warnDays: 30 }, fakeCtx()),
      await vehiclesGet.handler({ plate: 'ABC123', includePaidFines: false }, fakeCtx()),
      await vehiclesCheckRunt.handler({ plate: 'ABC123' }, fakeCtx()),
      await vehiclesCheckSimit.handler({ plate: 'ABC123' }, fakeCtx()),
      await vehiclesRecentlyChanged.handler({ sinceDays: 7, expiringWithinDays: 30 }, fakeCtx()),
    ];

    for (const out of results) {
      expect(out.configured).toBe(false);
      expect(out.reason).toBeTruthy();
      // A sentence a non-technical person can read — no env var names, no codes.
      expect(out.reason).not.toMatch(/VEHICLES_SCRAPER|undefined|Error|fetch/);
      expect(out.guidance).toBeTruthy();
    }
  });

  it('still registers and lists vehicles, because only the lookups are missing', async () => {
    await register('xyz 987', { label: 'la moto' });
    const list = await vehiclesList.handler({ includeArchived: false, warnDays: 30 }, fakeCtx());
    expect(list.configured).toBe(false);
    expect(list.vehicles.map((v) => v.plate)).toEqual(['XYZ987']);
    expect(list.vehicles[0]?.label).toBe('la moto');
  });

  it('records the failed consult rather than losing it', async () => {
    await register();
    await vehiclesCheckSimit.handler({ plate: 'ABC123' }, fakeCtx());
    const consults = db.store.vehicle_consults ?? [];
    expect(consults).toHaveLength(1);
    expect(consults[0]).toMatchObject({ source: 'SIMIT', status: 'error' });
  });
});

describe('vehicles.register', () => {
  it('normalizes the plate and stores it once per user', async () => {
    const first = await register('abc-123', { label: 'the red Mazda' });
    expect(first.created).toBe(true);
    expect(first.vehicle.plate).toBe('ABC123');
    expect(first.vehicle.ownerDocOnFile).toBe(true);

    const again = await vehiclesRegister.handler(
      { plate: 'ABC 123', label: 'the Mazda' } as Parameters<typeof vehiclesRegister.handler>[0],
      fakeCtx(),
    );
    expect(again.created).toBe(false);
    expect(db.store.vehicles).toHaveLength(1);
    // A partial re-registration updates the label and must NOT drop the owner
    // document — losing it would silently disable every future RUNT consult.
    expect(again.vehicle.label).toBe('the Mazda');
    expect(again.vehicle.ownerDocOnFile).toBe(true);
    expect(again.guidance).toMatch(/already on the list/i);
  });

  it('never echoes the owner document number back', async () => {
    const out = await register('ABC123');
    expect(JSON.stringify(out)).not.toContain('1020304050');
  });

  it('says plainly that RUNT cannot run without an owner document', async () => {
    const out = await vehiclesRegister.handler(
      { plate: 'JKL456' } as Parameters<typeof vehiclesRegister.handler>[0],
      fakeCtx(),
    );
    expect(out.vehicle.ownerDocOnFile).toBe(false);
    expect(out.guidance).toMatch(/document/i);
    expect(out.guidance).toMatch(/SIMIT/);
  });

  it("keeps one person's plates out of another's list", async () => {
    await register('ABC123');
    const theirs = await vehiclesList.handler(
      { includeArchived: false, warnDays: 30 },
      fakeCtx(OTHER_USER),
    );
    expect(theirs.vehicles).toEqual([]);
    expect(theirs.count).toBe(0);
  });
});

describe('vehicles.list', () => {
  it('turns stored dates into a verdict and leads with what is wrong', async () => {
    await register('ABC123', { label: 'the Mazda' });
    await register('XYZ987');
    const [a, b] = db.store.vehicles as Row[];
    Object.assign(a as Row, {
      soat_expires_at: daysFromNow(-3),
      rtm_expires_at: daysFromNow(120),
      last_runt_sync: new Date().toISOString(),
      total_pending_cop: 522_000,
    });
    Object.assign(b as Row, {
      soat_expires_at: daysFromNow(12),
      last_runt_sync: new Date().toISOString(),
    });
    (db.store.vehicle_fines as Row[]).push(
      { id: 'f1', vehicle_id: (a as Row).id, status: 'PENDING' },
      { id: 'f2', vehicle_id: (a as Row).id, status: 'PAID' },
    );

    const out = await vehiclesList.handler({ includeArchived: false, warnDays: 30 }, fakeCtx());
    expect(out.count).toBe(2);
    const mazda = out.vehicles.find((v) => v.plate === 'ABC123');
    expect(mazda?.soat.status).toBe('expired');
    expect(mazda?.soat.daysLeft).toBeLessThan(0);
    expect(mazda?.rtm.status).toBe('valid');
    expect(mazda?.pendingFines).toBe(1);
    expect(out.vehicles.find((v) => v.plate === 'XYZ987')?.soat.status).toBe('expiring');
    expect(out.guidance).toMatch(/needs attention/i);
    expect(out.guidance).toMatch(/SOAT expired/);
    expect(out.guidance).toMatch(/COP/);
  });

  it('reports an unchecked vehicle as unknown, not as clean', async () => {
    await register('ABC123');
    const out = await vehiclesList.handler({ includeArchived: false, warnDays: 30 }, fakeCtx());
    expect(out.vehicles[0]?.soat.status).toBe('unknown');
    expect(out.guidance).toMatch(/never been checked/i);
  });
});

describe('vehicles.get', () => {
  it('returns the vehicle with its outstanding fines and hides settled ones', async () => {
    await register('ABC123');
    const vehicleId = (db.store.vehicles as Row[])[0]?.id;
    (db.store.vehicle_fines as Row[]).push(
      {
        id: 'f1',
        vehicle_id: vehicleId,
        code: 'C14',
        description: 'Zona restringida',
        amount_cop: 522_000,
        issued_at: '2026-05-04T00:00:00Z',
        status: 'PENDING',
        comparendo: '110010000001',
        detected_at: '2026-05-10T00:00:00Z',
      },
      {
        id: 'f2',
        vehicle_id: vehicleId,
        code: 'B01',
        amount_cop: 120_000,
        issued_at: '2025-01-04T00:00:00Z',
        status: 'PAID',
        comparendo: '110010000002',
        detected_at: '2025-01-10T00:00:00Z',
      },
    );

    const out = await vehiclesGet.handler({ plate: 'abc123', includePaidFines: false }, fakeCtx());
    expect(out.found).toBe(true);
    expect(out.fines).toHaveLength(1);
    expect(out.fines[0]?.comparendo).toBe('110010000001');
    expect(out.guidance).toMatch(/comparendo/i);

    const withPaid = await vehiclesGet.handler(
      { plate: 'ABC123', includePaidFines: true },
      fakeCtx(),
    );
    expect(withPaid.fines).toHaveLength(2);
  });

  it('says what to do about a plate nobody registered', async () => {
    const out = await vehiclesGet.handler({ plate: 'QQQ111', includePaidFines: false }, fakeCtx());
    expect(out.found).toBe(false);
    expect(out.vehicle).toBeNull();
    expect(out.reason).toMatch(/not on your list/i);
  });
});

describe('vehicles.check_runt', () => {
  it('sends the plate with the owner document and persists what RUNT answered', async () => {
    let body: unknown;
    let apiKey: string | null = null;
    server.use(
      http.post(RUNT_URL, async ({ request }) => {
        body = await request.json();
        apiKey = request.headers.get('x-api-key');
        return HttpResponse.json(RUNT_OK);
      }),
    );
    await register('ABC123');

    const out = await vehiclesCheckRunt.handler({ plate: 'abc 123' }, fakeCtx());
    expect(body).toEqual({ plate: 'ABC123', docType: 'CC', docNumber: '1020304050' });
    expect(apiKey).toBe('test-key');

    expect(out.checked).toBe(true);
    expect(out.configured).toBe(true);
    expect(out.reason).toBeNull();
    expect(out.vehicle?.runtEstado).toBe('ACTIVO');
    expect(out.vehicle?.brand).toBe('MAZDA');
    expect(out.vehicle?.modelYear).toBe(2019);
    // dd/mm/yyyy is normalized on the way in, so no reader ever has to guess.
    expect(out.vehicle?.soat.expiresAt).toBe('2026-12-31');
    expect(out.vehicle?.rtm.expiresAt).toBe('2026-08-10');
    expect((db.store.vehicles as Row[])[0]?.last_runt_sync).toBe(RUNT_OK.consultedAt);
    expect(db.store.vehicle_consults).toMatchObject([{ source: 'RUNT', status: 'ok' }]);
    expect(out.guidance).toMatch(/SOAT/);
    expect(out.guidance).toMatch(/SIMIT/);
  });

  it('never lets a partial answer erase a date already on file', async () => {
    await register('ABC123');
    await vehiclesCheckRunt.handler({ plate: 'ABC123' }, fakeCtx());
    server.use(
      http.post(RUNT_URL, () =>
        HttpResponse.json({
          ...RUNT_OK,
          soatVigenteHasta: null,
          rtmVigenteHasta: null,
          marca: null,
        }),
      ),
    );

    const out = await vehiclesCheckRunt.handler({ plate: 'ABC123' }, fakeCtx());
    expect(out.vehicle?.soat.expiresAt).toBe('2026-12-31');
    expect(out.vehicle?.brand).toBe('MAZDA');
  });

  it('refuses without an owner document instead of calling RUNT', async () => {
    server.use(
      http.post(RUNT_URL, () => HttpResponse.json({ error: 'should not happen' }, { status: 500 })),
    );
    await vehiclesRegister.handler(
      { plate: 'JKL456' } as Parameters<typeof vehiclesRegister.handler>[0],
      fakeCtx(),
    );
    const out = await vehiclesCheckRunt.handler({ plate: 'JKL456' }, fakeCtx());
    expect(out.checked).toBe(false);
    expect(out.reason).toMatch(/document/i);
    expect(db.store.vehicle_consults).toHaveLength(0);
  });

  it('explains a captcha failure in plain words and keeps the last known state', async () => {
    await register('ABC123');
    await vehiclesCheckRunt.handler({ plate: 'ABC123' }, fakeCtx());
    server.use(
      http.post(RUNT_URL, () =>
        HttpResponse.json({ error: 'captcha', code: 'CAPTCHA_FAILED' }, { status: 502 }),
      ),
    );

    const out = await vehiclesCheckRunt.handler({ plate: 'ABC123' }, fakeCtx());
    expect(out.checked).toBe(false);
    expect(out.configured).toBe(true);
    expect(out.reason).toMatch(/captcha/i);
    expect(out.reason).not.toMatch(/502|Error/);
    expect(out.vehicle?.soat.expiresAt).toBe('2026-12-31');
    expect(out.guidance).toMatch(/last known state/i);
    expect(db.store.vehicle_consults).toMatchObject([
      { source: 'RUNT', status: 'ok' },
      { source: 'RUNT', status: 'error' },
    ]);
  });

  it('says an unknown plate is unknown rather than blaming the service', async () => {
    await register('ABC123');
    server.use(
      http.post(RUNT_URL, () =>
        HttpResponse.json({ error: 'no existe', code: 'NOT_FOUND' }, { status: 502 }),
      ),
    );
    const out = await vehiclesCheckRunt.handler({ plate: 'ABC123' }, fakeCtx());
    expect(out.reason).toMatch(/no record of that plate/i);
  });
});

describe('vehicles.check_simit', () => {
  it('stores the snapshot and reports every fine as new the first time', async () => {
    server.use(
      http.post(SIMIT_URL, () =>
        HttpResponse.json(simitBody([FINE_A, FINE_B], FINE_A.amountCop + FINE_B.amountCop)),
      ),
    );
    await register('ABC123');

    const out = await vehiclesCheckSimit.handler({ plate: 'ABC123' }, fakeCtx());
    expect(out.checked).toBe(true);
    expect(out.newCount).toBe(2);
    expect(out.fines).toHaveLength(2);
    expect(out.totalPendingCop).toBe(1_682_000);
    expect(db.store.vehicle_fines).toHaveLength(2);
    expect((db.store.vehicles as Row[])[0]?.total_pending_cop).toBe(1_682_000);
    expect((db.store.vehicles as Row[])[0]?.last_simit_sync).toBe('2026-08-01T12:05:00.000Z');
    expect(db.store.vehicle_consults).toMatchObject([
      { source: 'SIMIT', status: 'ok', fines_found: 2 },
    ]);
    expect(out.guidance).toMatch(/NEW fine/);
  });

  it('deduplicates by comparendo, so a second look reports nothing new', async () => {
    server.use(
      http.post(SIMIT_URL, () =>
        HttpResponse.json(simitBody([FINE_A, FINE_B], FINE_A.amountCop + FINE_B.amountCop)),
      ),
    );
    await register('ABC123');
    await vehiclesCheckSimit.handler({ plate: 'ABC123' }, fakeCtx());
    const detectedFirst = (db.store.vehicle_fines as Row[])[0]?.detected_at;

    const second = await vehiclesCheckSimit.handler({ plate: 'ABC123' }, fakeCtx());
    expect(second.newCount).toBe(0);
    expect(second.newFines).toEqual([]);
    expect(db.store.vehicle_fines).toHaveLength(2);
    // detected_at is when WE first saw it — re-checking must not reset it, or
    // "any new fines this week?" would answer yes forever.
    expect((db.store.vehicle_fines as Row[])[0]?.detected_at).toBe(detectedFirst);
    expect(second.guidance).toMatch(/nothing new/i);
  });

  it('picks up only the fine that appeared since last time', async () => {
    await register('ABC123');
    await vehiclesCheckSimit.handler({ plate: 'ABC123' }, fakeCtx());
    server.use(
      http.post(SIMIT_URL, () =>
        HttpResponse.json(simitBody([FINE_A, FINE_B], FINE_A.amountCop + FINE_B.amountCop)),
      ),
    );

    const out = await vehiclesCheckSimit.handler({ plate: 'ABC123' }, fakeCtx());
    expect(out.newCount).toBe(1);
    expect(out.newFines[0]?.comparendo).toBe(FINE_B.comparendo);
    expect(out.guidance).toMatch(/1 NEW fine/);
  });

  it('refreshes a fine that was paid without inventing a new one', async () => {
    await register('ABC123');
    await vehiclesCheckSimit.handler({ plate: 'ABC123' }, fakeCtx());
    server.use(
      http.post(SIMIT_URL, () => HttpResponse.json(simitBody([{ ...FINE_A, status: 'PAID' }], 0))),
    );

    const out = await vehiclesCheckSimit.handler({ plate: 'ABC123' }, fakeCtx());
    expect(out.newCount).toBe(0);
    expect(out.fines).toEqual([]);
    expect(out.totalPendingCop).toBe(0);
    expect((db.store.vehicle_fines as Row[])[0]?.status).toBe('PAID');
    expect(out.guidance).toMatch(/nothing outstanding/i);
  });

  it('deduplicates a fine whose comparendo the scrape lost', async () => {
    const noComparendo: RawFine = { ...FINE_A, comparendo: undefined };
    server.use(http.post(SIMIT_URL, () => HttpResponse.json(simitBody([noComparendo], 522_000))));
    await register('ABC123');

    await vehiclesCheckSimit.handler({ plate: 'ABC123' }, fakeCtx());
    const second = await vehiclesCheckSimit.handler({ plate: 'ABC123' }, fakeCtx());
    expect(second.newCount).toBe(0);
    expect(db.store.vehicle_fines).toHaveLength(1);
  });

  it('refuses to pass a failed lookup off as a clean plate', async () => {
    await register('ABC123');
    server.use(http.post(SIMIT_URL, () => new HttpResponse(null, { status: 429 })));

    const out = await vehiclesCheckSimit.handler({ plate: 'ABC123' }, fakeCtx());
    expect(out.checked).toBe(false);
    expect(out.reason).toMatch(/rate-limiting/i);
    expect(out.guidance).toMatch(/do not report "no fines"/i);
    expect(db.store.vehicle_fines).toHaveLength(0);
  });
});

describe('vehicles.recently_changed', () => {
  it('reports new fines and lapsing documents, worst first, ready to read out', async () => {
    await register('ABC123', { label: 'the Mazda' });
    await register('XYZ987');
    const [mazda, moto] = db.store.vehicles as Row[];
    Object.assign(mazda as Row, {
      soat_expires_at: daysFromNow(-2),
      last_runt_sync: new Date().toISOString(),
      last_simit_sync: new Date().toISOString(),
    });
    Object.assign(moto as Row, {
      rtm_expires_at: daysFromNow(9),
      last_runt_sync: new Date().toISOString(),
      last_simit_sync: new Date().toISOString(),
    });
    (db.store.vehicle_fines as Row[]).push(
      {
        id: 'f1',
        vehicle_id: (mazda as Row).id,
        code: 'C14',
        description: 'Zona restringida',
        amount_cop: 522_000,
        status: 'PENDING',
        comparendo: '110010000001',
        detected_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
      // Older than the window: already reported once, not news again.
      {
        id: 'f2',
        vehicle_id: (mazda as Row).id,
        code: 'B01',
        amount_cop: 120_000,
        status: 'PENDING',
        comparendo: '110010000002',
        detected_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      },
    );

    const out = await vehiclesRecentlyChanged.handler(
      { sinceDays: 7, expiringWithinDays: 30 },
      fakeCtx(),
    );
    expect(out.changeCount).toBe(3);
    expect(out.vehiclesChecked).toBe(2);
    // A lapsed SOAT leads: it is the one that stops the car being legal today.
    expect(out.changes.map((c) => c.kind)).toEqual(['soat_expired', 'new_fine', 'rtm_expiring']);
    expect(out.changes[0]?.urgency).toBe('urgent');
    expect(out.changes[0]?.detail).toMatch(/SOAT on ABC123 \(the Mazda\) expired 2 days ago/);
    expect(out.changes[1]?.detail).toMatch(/New fine on ABC123 \(the Mazda\)/);
    expect(out.changes[1]?.detail).toMatch(/comparendo 110010000001/);
    expect(out.changes[2]?.detail).toMatch(/RTM on XYZ987 expires in 9 days/);
    expect(out.guidance).toMatch(/1 new fine/);
    expect(out.guidance).toMatch(/2 documents expired or expiring/);
  });

  it('flags vehicles nobody has checked, so silence is not mistaken for clean', async () => {
    await register('ABC123');
    const out = await vehiclesRecentlyChanged.handler(
      { sinceDays: 7, expiringWithinDays: 30 },
      fakeCtx(),
    );
    expect(out.changeCount).toBe(0);
    expect(out.guidance).toMatch(/not been checked/i);
    expect(out.guidance).toContain('ABC123');
  });

  it('says so plainly when there is nothing at all to watch', async () => {
    const out = await vehiclesRecentlyChanged.handler(
      { sinceDays: 7, expiringWithinDays: 30 },
      fakeCtx(),
    );
    expect(out.changes).toEqual([]);
    expect(out.guidance).toMatch(/nothing to report/i);
  });
});

describe('Vehicles tools — security classification', () => {
  const at = (id: string, input: unknown, surface: 'web' | 'schedule' = 'web') =>
    classify({
      tool: { id },
      input,
      ctx: { now: new Date(Date.UTC(2026, 0, 1, 17, 0, 0)) },
      surface,
    });

  it('treats a plate and its documents as internal bookkeeping, not client data', () => {
    const c = at('vehicles.list', { includeArchived: false });
    expect(c.sensitivity).toBe('internal');
    expect(c.blastRadius).toBe('read');
    expect(c.riskLevel).toBe('low');
    expect(decide(c)).toBe('allow');
  });

  it("classifies registration as personal data — it carries the owner's document", () => {
    const c = at('vehicles.register', {
      plate: 'ABC123',
      ownerDocType: 'CC',
      ownerDocNumber: '1020304050',
    });
    expect(c.sensitivity).toBe('pii');
    expect(c.blastRadius).toBe('internal_write');
    expect(c.riskLevel).toBe('medium');
    expect(decide(c)).toBe('allow');
  });

  it('keeps every lookup read-only — nothing here writes to RUNT or SIMIT', () => {
    for (const id of ['vehicles.check_runt', 'vehicles.check_simit', 'vehicles.get']) {
      const c = at(id, { plate: 'ABC123' });
      expect(c.blastRadius).toBe('read');
      expect(decide(c)).toBe('allow');
    }
  });

  it('lets the watch report run unattended, which is the whole point of it', () => {
    const c = at('vehicles.recently_changed', { sinceDays: 7 }, 'schedule');
    expect(c.signals).toContain('unattended');
    expect(c.riskLevel).toBe('low');
    expect(decide(c)).toBe('allow');
  });

  it('lets a scheduled SIMIT sweep run unattended too', () => {
    expect(decide(at('vehicles.check_simit', { plate: 'ABC123' }, 'schedule'))).toBe('allow');
  });
});
