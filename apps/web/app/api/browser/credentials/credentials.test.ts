import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * UNA CONTRASEÑA NO VUELVE NUNCA AL NAVEGADOR.
 *
 * Ésta es la única propiedad de este módulo que no se puede arreglar después.
 * Un trámite mal leído se vuelve a enseñar; una clave de la empresa que salió
 * una vez por una respuesta JSON ya salió, y nadie sabe a dónde.
 *
 * El diseño la sostiene en dos capas, y aquí se comprueban las dos por
 * separado, porque una sola no bastaría:
 *
 *   1. LO QUE SE PIDE. Todo lo que lee credenciales selecciona una lista
 *      explícita de columnas donde `secret_encrypted` no está. El test mira la
 *      cadena de columnas que sale hacia PostgREST.
 *   2. LO QUE SE DEVUELVE. Y aun así, el falso Postgres de abajo contesta con
 *      la FILA COMPLETA —secreto incluido— para responder la pregunta que de
 *      verdad importa: si mañana alguien cambia la lista de columnas por un
 *      `*`, ¿se escapa? La respuesta tiene que seguir siendo no, porque el
 *      mapeo a `CredentialSummary` construye un objeto nuevo con seis campos.
 *
 * Y la tercera, que no es del secreto sino de la persona: el POST es de
 * administradores, y eso se responde ANTES de enseñar un campo de contraseña.
 */

const KEY = vi.hoisted(() => {
  process.env.TOKEN_ENCRYPTION_KEY = 'Ao9v3nQ0ZK7mXn2bR5tY8uI1oP4aS6dF9gH0jK2lM3Q=';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.SUPABASE_DB_URL = 'postgres://localhost:54322/postgres';
  process.env.APP_BASE_URL = 'http://localhost:3000';
  process.env.GOOGLE_CLIENT_ID = 'x';
  process.env.GOOGLE_CLIENT_SECRET = 'x';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/cb';
  return process.env.TOKEN_ENCRYPTION_KEY;
});

/** La contraseña de mentira que no puede aparecer en ninguna respuesta. */
const PASSWORD = 'no-debe-salir-de-aqui-9f3a';
const USERNAME = '900123456-1';

const ORG = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const FLOW = '00000000-0000-4000-8000-000000000003';
const OTHER_FLOW = '00000000-0000-4000-8000-000000000004';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  role: 'org_admin' as 'org_admin' | 'member',
  store: {} as Record<string, Row[]>,
  /** Cada `select` que salió hacia PostgREST, como «tabla:columnas». */
  selects: [] as string[],
}));

vi.mock('@/lib/session', () => ({
  requireSession: async () => ({
    id: USER,
    email: 'quien@acme.co',
    name: 'Quien Sea',
    role: state.role,
    organization: { id: ORG, name: 'Acme' },
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  getOrgScopedClient: () => fakeDb(),
}));

/**
 * El Postgres de mentira, deliberadamente generoso: devuelve la fila entera,
 * mire lo que mire el `select`. Un doble que filtrara por columnas escondería
 * exactamente el fallo que este archivo existe para cazar.
 */
function fakeDb(): SupabaseClient {
  const rows = (table: string): Row[] => {
    state.store[table] ??= [];
    return state.store[table] as Row[];
  };

  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    let mode: 'select' | 'insert' | 'update' = 'select';
    let payload: Row = {};

    const run = (): Row[] => {
      if (mode === 'insert') {
        const created = { id: randomUUID(), ...payload };
        rows(table).push(created);
        return [created];
      }
      const matched = rows(table).filter((r) => filters.every((f) => f(r)));
      if (mode === 'update') for (const row of matched) Object.assign(row, payload);
      return matched;
    };

    const query = {
      select(columns?: string) {
        state.selects.push(`${table}:${columns ?? '*'}`);
        return query;
      },
      insert(next: Row) {
        mode = 'insert';
        payload = next;
        return query;
      },
      update(next: Row) {
        mode = 'update';
        payload = next;
        return query;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return query;
      },
      order() {
        return query;
      },
      limit() {
        return query;
      },
      async single() {
        return { data: run()[0] ?? null, error: null };
      },
      async maybeSingle() {
        return { data: run()[0] ?? null, error: null };
      },
      // biome-ignore lint/suspicious/noThenProperty: que el objeto sea «awaitable» es justo lo que hace el builder de PostgREST, y es lo que este doble tiene que imitar
      then<T>(resolve: (value: { data: Row[]; error: null }) => T) {
        return Promise.resolve({ data: run(), error: null }).then(resolve);
      },
    };
    return query;
  };

  return { from } as unknown as SupabaseClient;
}

function post(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  state.role = 'org_admin';
  state.store = {
    browser_flows: [
      {
        id: FLOW,
        organization_id: ORG,
        slug: 'declaracion-iva',
        name: 'Declaración de IVA',
        description: '',
        start_url: 'https://muisca.dian.gov.co/entrar',
        host: 'https://muisca.dian.gov.co',
        effect: 'read',
        status: 'draft',
        source: 'recording',
        credential_id: null,
        login_required: true,
        variables: [],
        steps: [],
        version: 1,
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
      },
      {
        id: OTHER_FLOW,
        organization_id: ORG,
        slug: 'consulta-placa',
        name: 'Consulta de placa',
        description: '',
        start_url: 'https://www.runt.gov.co/consulta',
        host: 'https://www.runt.gov.co',
        effect: 'read',
        status: 'ready',
        source: 'recording',
        credential_id: null,
        login_required: false,
        variables: [],
        steps: [],
        version: 1,
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
      },
    ],
  };
  state.selects = [];
});

/** Guarda una credencial por la puerta de siempre y devuelve su respuesta. */
async function saveCredential() {
  const { POST } = await import('./route');
  const response = await POST(
    post({
      label: 'DIAN — contabilidad',
      host: 'https://muisca.dian.gov.co/entrar',
      fields: { usuario: USERNAME, clave: PASSWORD },
    }),
  );
  return { response, body: (await response.json()) as Record<string, unknown> };
}

describe('guardar la cuenta de un portal', () => {
  /**
   * VEINTE SEGUNDOS, Y NO ES PEREZA.
   *
   * Esta prueba cifra de verdad, y el cifrado de una credencial es LENTO A
   * PROPÓSITO: ése es el trabajo que le cuesta a quien robe la tabla. Sola
   * tarda ~2,1 s; con el resto de la suite corriendo en paralelo en la misma
   * máquina, medido, se va a ~8,7 s — y el tope por defecto de vitest son 5.
   *
   * Así que fallaba según lo ocupado que estuviera el portátil, que es la peor
   * clase de prueba roja: la que enseña a la siguiente persona que un rojo se
   * vuelve a lanzar en vez de leerse. Y lo que guarda —que la clave no vuelve
   * en la respuesta ni entera ni en pedazos— es de lo más importante que hay
   * probado en este repositorio.
   *
   * El tope se sube en ESTE caso y no en la configuración global: subirlo para
   * todos convertiría un cuelgue de verdad en veinte segundos de espera en cada
   * prueba de la app.
   */
  it('la cifra y no la devuelve, ni entera ni en pedazos', { timeout: 20_000 }, async () => {
    expect(KEY).toBeTruthy();
    const { response, body } = await saveCredential();
    expect(response.status).toBe(200);

    // La respuesta completa, como texto. Ni la clave, ni el usuario.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain(PASSWORD);
    expect(wire).not.toContain(USERNAME);
    // Los NOMBRES de los campos sí viajan: hay que poder decir qué se guardó.
    expect(body.credential).toMatchObject({
      label: 'DIAN — contabilidad',
      host: 'https://muisca.dian.gov.co',
      fieldNames: ['usuario', 'clave'],
    });
    expect(Object.keys(body.credential as Row)).not.toContain('secretEncrypted');

    // Y en la tabla quedó cifrada, no en claro.
    const stored = (state.store.browser_credentials ?? [])[0] as Row;
    expect(String(stored.secret_encrypted)).not.toContain(PASSWORD);
    expect(stored.field_names).toEqual(['usuario', 'clave']);
  });

  it('no le pide a Postgres la columna del secreto', async () => {
    await saveCredential();
    const asked = state.selects.filter((s) => s.startsWith('browser_credentials:'));
    expect(asked.length).toBeGreaterThan(0);
    for (const columns of asked) expect(columns).not.toContain('secret_encrypted');
  });

  it('lo dice antes, no después: quien no es administrador no puede guardarla', async () => {
    state.role = 'member';
    const { response, body } = await saveCredential();
    expect(response.status).toBe(403);
    expect(String(body.error)).toContain('administrador');
    // Un rechazo tampoco es un lugar donde una clave pueda asomarse.
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
    expect(state.store.browser_credentials ?? []).toHaveLength(0);
  });
});

describe('la lista de cuentas guardadas', () => {
  it('no trae el secreto ni cuando la base lo devuelve todo', async () => {
    await saveCredential();
    // El doble contesta con la fila entera: si el mapeo no filtrara, aquí se
    // vería. Es la pregunta «¿y si alguien cambia las columnas por un *?».
    const { GET } = await import('./route');
    const body = (await (await GET()).json()) as { credentials: Row[]; canSave: boolean };

    expect(JSON.stringify(body)).not.toContain(PASSWORD);
    expect(body.credentials).toHaveLength(1);
    // Nada fuera de los seis campos que `CredentialSummary` construye a mano.
    // La afirmación es sobre lo que NO puede aparecer, así que se escribe como
    // una lista cerrada y no como «no contiene la clave».
    const SAFE = ['id', 'label', 'host', 'fieldNames', 'createdAt', 'lastUsedAt'];
    for (const key of Object.keys(body.credentials[0] as Row)) expect(SAFE).toContain(key);
  });

  it('responde si esta persona puede guardar una, para no pedirle nada en vano', async () => {
    const { GET } = await import('./route');
    expect(((await (await GET()).json()) as { canSave: boolean }).canSave).toBe(true);
    state.role = 'member';
    expect(((await (await GET()).json()) as { canSave: boolean }).canSave).toBe(false);
  });
});

describe('vincular la cuenta al trámite', () => {
  async function bind(body: unknown) {
    const { POST } = await import('./bind/route');
    const response = await POST(post(body));
    return { response, body: (await response.json()) as Record<string, unknown> };
  }

  async function credentialId(): Promise<string> {
    const { body } = await saveCredential();
    return (body.credential as { id: string }).id;
  }

  it('la cuelga del trámite y no manda ningún secreto de vuelta', async () => {
    const id = await credentialId();
    const { response, body } = await bind({ flowId: FLOW, credentialId: id });
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain(PASSWORD);

    const flow = (state.store.browser_flows as Row[]).find((f) => f.id === FLOW);
    expect(flow?.credential_id).toBe(id);
  });

  it('se niega a colgar la clave de un portal de otro portal', async () => {
    // La misma comprobación que hace `unlockForRun`, veinte segundos antes: la
    // hora de descubrirlo no es una corrida desatendida.
    const id = await credentialId();
    const { response, body } = await bind({ flowId: OTHER_FLOW, credentialId: id });
    expect(response.status).toBe(409);
    expect(String(body.error)).toContain('runt.gov.co');

    const flow = (state.store.browser_flows as Row[]).find((f) => f.id === OTHER_FLOW);
    expect(flow?.credential_id).toBeNull();
  });

  it('acepta un null explícito como «quítasela»', async () => {
    // `nullish()` y no `optional()`: `JSON.stringify` serializa el null y omite
    // el undefined, así que la pantalla no tiene otra forma de decirlo.
    const id = await credentialId();
    await bind({ flowId: FLOW, credentialId: id });
    const { response } = await bind({ flowId: FLOW, credentialId: null });
    expect(response.status).toBe(200);
    const flow = (state.store.browser_flows as Row[]).find((f) => f.id === FLOW);
    expect(flow?.credential_id).toBeNull();
  });

  it('no deja que un no administrador decida con qué identidad actúa el robot', async () => {
    const id = await credentialId();
    state.role = 'member';
    const { response } = await bind({ flowId: FLOW, credentialId: id });
    expect(response.status).toBe(403);
    const flow = (state.store.browser_flows as Row[]).find((f) => f.id === FLOW);
    expect(flow?.credential_id).toBeNull();
  });
});
