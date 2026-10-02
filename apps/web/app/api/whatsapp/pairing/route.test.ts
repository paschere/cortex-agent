import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VINCULAR BAJO PEDIDO, DE PUNTA A PUNTA ENTRE LAS DOS RUTAS.
 *
 * `/api/whatsapp/pairing` deja la petición; el latido del puente la lee y
 * devuelve el código. Se prueban juntas porque el contrato es entre ellas: lo
 * que una escribe es lo que la otra tiene que entender. La base falsa aplica los
 * filtros de verdad (empresa, `gt`) en vez de devolver filas fijas, porque el
 * fallo que se teme es que falte uno: renovar una petición vencida, o tocar la
 * fila de otra empresa.
 */

const MINE = 'org-acme';
const THEIRS = 'org-rival';

const state = vi.hoisted(() => ({
  role: 'org_admin' as 'org_admin' | 'member',
  sessions: new Map<string, Record<string, unknown>>(),
  scopedTo: [] as string[],
}));

vi.mock('@/lib/session', () => ({
  requireSession: async () => ({ id: 'u-1', role: state.role, organization: { id: MINE } }),
}));

vi.mock('@/lib/supabase/service', () => {
  class Builder {
    private op: 'select' | 'update' | 'upsert' = 'select';
    private patch: Record<string, unknown> = {};
    private filters: Array<(row: Record<string, unknown>) => boolean> = [];
    private single = false;

    constructor(
      private readonly table: string,
      private readonly org: string,
    ) {}

    select() {
      return this;
    }
    update(patch: Record<string, unknown>) {
      this.op = 'update';
      this.patch = patch;
      return this;
    }
    upsert(patch: Record<string, unknown>) {
      this.op = 'upsert';
      this.patch = patch;
      return this;
    }
    gt(column: string, value: string) {
      this.filters.push(
        (row) => typeof row[column] === 'string' && (row[column] as string) > value,
      );
      return this;
    }
    or() {
      return this;
    }
    maybeSingle() {
      this.single = true;
      return this;
    }

    private run(): { data: unknown; error: null } {
      if (this.table !== 'whatsapp_sessions') return { data: [], error: null };
      if (this.op === 'upsert') {
        const row = state.sessions.get(this.org) ?? { organization_id: this.org };
        Object.assign(row, this.patch);
        state.sessions.set(this.org, row);
        return { data: null, error: null };
      }
      // The scoped client's own filter: only this workspace's row exists here.
      const own = state.sessions.get(this.org);
      const matched = own && this.filters.every((f) => f(own)) ? [own] : [];
      if (this.op === 'update') for (const row of matched) Object.assign(row, this.patch);
      const copies = matched.map((row) => ({ ...row }));
      return { data: this.single ? (copies[0] ?? null) : copies, error: null };
    }

    // biome-ignore lint/suspicious/noThenProperty: el constructor de consultas de supabase-js ES un «thenable», así que el doble también.
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
  }

  return {
    getOrgScopedClient: (organizationId: string) => {
      state.scopedTo.push(organizationId);
      return { from: (table: string) => new Builder(table, organizationId) };
    },
  };
});

const { POST: pairing } = await import('./route');
const { POST: heartbeat } = await import('../bridge/heartbeat/route');

const TOKEN = 'secreto-de-prueba';

function ask(body: unknown) {
  return pairing(
    new Request('https://cortex.test/api/whatsapp/pairing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  );
}

function beat(body: unknown, org = MINE) {
  return heartbeat(
    new Request('https://cortex.test/api/whatsapp/bridge/heartbeat', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-cortex-organization': org,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }) as never,
  );
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(() => {
  process.env.WHATSAPP_BRIDGE_TOKEN = TOKEN;
  state.role = 'org_admin';
  state.scopedTo = [];
  state.sessions = new Map([
    [MINE, { organization_id: MINE, status: 'waiting', pairing_requested_at: null }],
    [THEIRS, { organization_id: THEIRS, status: 'waiting', pairing_requested_at: null }],
  ]);
});

describe('POST /api/whatsapp/pairing', () => {
  it('sólo un administrador puede pedir vincular', async () => {
    state.role = 'member';
    const res = await ask({ mode: 'qr' });
    expect(res.status).toBe(403);
    expect(state.sessions.get(MINE)?.pairing_requested_at).toBeNull();
  });

  it('rechaza un modo inventado y un número que no se entiende', async () => {
    expect((await ask({ mode: 'sms' })).status).toBe(400);
    expect((await ask({ mode: 'code', phone: '12' })).status).toBe(400);
  });

  it('pedir QR deja la petición en la fila de esta empresa y en ninguna otra', async () => {
    const res = await ask({ mode: 'qr' });
    expect(res.status).toBe(200);
    expect(state.sessions.get(MINE)?.pairing_requested_at).toEqual(expect.any(String));
    expect(state.sessions.get(MINE)?.pairing_phone).toBeNull();
    expect(state.sessions.get(THEIRS)?.pairing_requested_at).toBeNull();
    expect(new Set(state.scopedTo)).toEqual(new Set([MINE]));
  });

  it('pedir código guarda el número normalizado y retira un código de otro número', async () => {
    Object.assign(state.sessions.get(MINE) ?? {}, {
      pairing_phone: '573009998877',
      pairing_code: 'OLDC0DE1',
      pairing_code_expires_at: new Date(Date.now() + 30_000).toISOString(),
    });
    const res = await ask({ mode: 'code', phone: '+57 300 111 2233' });
    expect(res.status).toBe(200);
    const row = state.sessions.get(MINE);
    expect(row?.pairing_phone).toBe('573001112233');
    expect(row?.pairing_code).toBeNull();
  });

  it('sin fila de esta empresa no inventa una: el puente nunca reportó aquí', async () => {
    state.sessions.delete(MINE);
    const res = await ask({ mode: 'qr' });
    expect(res.status).toBe(409);
    expect(state.sessions.has(MINE)).toBe(false);
  });

  it('no pide vincular un número que ya está conectado', async () => {
    Object.assign(state.sessions.get(MINE) ?? {}, { status: 'connected' });
    expect((await ask({ mode: 'qr' })).status).toBe(409);
  });

  it('renovar mantiene viva una petición viva y nunca revive una vencida', async () => {
    Object.assign(state.sessions.get(MINE) ?? {}, { pairing_requested_at: minutesAgo(1) });
    const alive = await ask({ mode: 'keepalive' });
    expect(await alive.json()).toMatchObject({ alive: true });
    expect(Date.parse(state.sessions.get(MINE)?.pairing_requested_at as string)).toBeGreaterThan(
      Date.now() - 5_000,
    );

    const stale = minutesAgo(10);
    Object.assign(state.sessions.get(MINE) ?? {}, { pairing_requested_at: stale });
    const lapsed = await ask({ mode: 'keepalive' });
    expect(await lapsed.json()).toMatchObject({ alive: false });
    expect(state.sessions.get(MINE)?.pairing_requested_at).toBe(stale);
  });

  it('cancelar borra la petición y el código', async () => {
    Object.assign(state.sessions.get(MINE) ?? {}, {
      pairing_requested_at: minutesAgo(1),
      pairing_phone: '573001112233',
      pairing_code: 'ABCD1234',
    });
    expect((await ask({ mode: 'cancel' })).status).toBe(200);
    expect(state.sessions.get(MINE)).toMatchObject({
      pairing_requested_at: null,
      pairing_phone: null,
      pairing_code: null,
    });
  });
});

describe('el latido del puente', () => {
  it('sin petición, el puente sigue quieto', async () => {
    const reply = await (await beat({ status: 'waiting' })).json();
    expect(reply).toMatchObject({ pairingRequested: false, pairingPhone: null });
  });

  it('una petición viva llega en la respuesta, con el número si se pidió código', async () => {
    await ask({ mode: 'code', phone: '+57 300 111 2233' });
    const reply = await (await beat({ status: 'waiting' })).json();
    expect(reply).toMatchObject({ pairingRequested: true, pairingPhone: '573001112233' });
  });

  it('la petición de una empresa no le llega al puente de otra', async () => {
    await ask({ mode: 'qr' });
    const reply = await (await beat({ status: 'waiting' }, THEIRS)).json();
    expect(reply).toMatchObject({ pairingRequested: false });
  });

  it('una petición de hace más de tres minutos ya no cuenta', async () => {
    Object.assign(state.sessions.get(MINE) ?? {}, { pairing_requested_at: minutesAgo(4) });
    const reply = await (await beat({ status: 'pairing' })).json();
    expect(reply).toMatchObject({ pairingRequested: false });
  });

  it('guarda el código con vencimiento, y lo borra cuando el puente dice que ya no hay', async () => {
    await ask({ mode: 'code', phone: '573001112233' });
    await beat({ status: 'pairing', pairingCode: 'abcd1234' });
    expect(state.sessions.get(MINE)?.pairing_code).toBe('ABCD1234');
    expect(Date.parse(state.sessions.get(MINE)?.pairing_code_expires_at as string)).toBeGreaterThan(
      Date.now(),
    );

    await beat({ status: 'pairing', pairingCode: null });
    expect(state.sessions.get(MINE)?.pairing_code).toBeNull();

    await beat({ status: 'pairing', pairingCode: 'no vale' });
    expect(state.sessions.get(MINE)?.pairing_code).toBeNull();
  });

  it('un puente viejo que no conoce los códigos no borra nada', async () => {
    Object.assign(state.sessions.get(MINE) ?? {}, { pairing_code: 'ABCD1234' });
    await beat({ status: 'pairing' });
    expect(state.sessions.get(MINE)?.pairing_code).toBe('ABCD1234');
  });

  it('al conectar, la petición queda cumplida y no vuelve a abrir nada', async () => {
    await ask({ mode: 'code', phone: '573001112233' });
    await beat({ status: 'pairing', pairingCode: 'ABCD1234' });
    const reply = await (await beat({ status: 'connected', phoneNumber: '573001112233' })).json();
    expect(reply).toMatchObject({ pairingRequested: false });
    expect(state.sessions.get(MINE)).toMatchObject({
      status: 'connected',
      pairing_requested_at: null,
      pairing_phone: null,
      pairing_code: null,
    });
  });

  it('acepta el estado nuevo «waiting»', async () => {
    await beat({ status: 'waiting' });
    expect(state.sessions.get(MINE)?.status).toBe('waiting');
  });
});
