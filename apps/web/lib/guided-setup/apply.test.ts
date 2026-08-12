import type { SetupItem } from '@/lib/guided-setup-shape';
import { createOrgScopedClient } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  type Tables,
  createFakeSupabase,
} from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { type CreateContext, createOne, undoOne } from './apply';
import { getSession, listItems, pickProposed, savePlan } from './store';

/**
 * LAS CUATRO COSAS QUE ESTA PANTALLA NO PUEDE HACER MAL.
 *
 * Se prueba contra el fake de PostgREST de tenancy y, encima, contra el cliente
 * con alcance de verdad — el mismo `createOrgScopedClient` que corre en
 * producción. Eso importa para el último bloque: si el aislamiento se probara
 * con un doble, se estaría probando el doble.
 *
 * El fake no genera ids ni defaults, así que `withIds` los pone al insertar,
 * que es lo único que Postgres hace y él no. Todo lo demás — filtros, orden,
 * `single`, cuentas — es la implementación real del fake.
 */

const ACME = 'org-acme';
const GLOBEX = 'org-globex';
const USER = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-03-10';

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** Le pone `id` y `created_at` a lo que se inserte, como haría la base. */
function withIds(client: SupabaseClient): SupabaseClient {
  const inner = client as unknown as { from: (t: string) => Record<string, unknown> };
  return {
    from(table: string) {
      const builder = inner.from(table);
      const original = builder.insert as (rows: unknown) => unknown;
      builder.insert = (rows: unknown) => {
        const list = Array.isArray(rows) ? rows : [rows];
        for (const row of list as Record<string, unknown>[]) {
          row.id ??= id(table);
          row.created_at ??= new Date().toISOString();
          row.updated_at ??= row.created_at;
        }
        return original.call(builder, list);
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

function world(tables: Tables = {}) {
  const fake = createFakeSupabase(tables);
  const raw = withIds(fake.client);
  return {
    tables,
    acme: createOrgScopedClient(raw, ACME),
    globex: createOrgScopedClient(raw, GLOBEX),
  };
}

function ctx(db: SupabaseClient, over: Partial<CreateContext> = {}): CreateContext {
  return {
    db,
    userId: USER,
    agentId: 'agent-1',
    canCreateGlobalSpace: true,
    today: TODAY,
    ...over,
  };
}

const COMMITMENT = {
  kind: 'commitment' as const,
  title: 'SOAT del WGX-123',
  rationale: 'Dijiste que se vence en abril',
  payload: { title: 'SOAT del WGX-123', dueOn: '2026-04-18', kind: 'soat' as const },
};

const ROUTINE = {
  kind: 'routine' as const,
  title: 'Revisión de los lunes',
  rationale: 'Los lunes revisan despachos',
  payload: {
    name: 'Revisión de los lunes',
    cron: '0 7 * * 1',
    timezone: 'America/Bogota',
    instruction: 'Dime qué despachos quedaron abiertos.',
  },
};

/** El primero del plan, con el fallo explícito si el plan salió vacío. */
function only(items: SetupItem[]): SetupItem {
  const item = items[0];
  if (!item) throw new Error('el plan no guardó nada');
  return item;
}

async function seedPlan(db: SupabaseClient, sessionId: string, items: unknown[]) {
  return savePlan(db, sessionId, {
    summary: 'Una empresa de carga.',
    items: items as never,
    outOfScope: [],
    handoffs: [],
  });
}

// ---------------------------------------------------------------------------

describe('proponer no es crear', () => {
  it('guarda el plan sin tocar un solo módulo', async () => {
    const w = world({ guided_setup_sessions: [{ id: 's1', organization_id: ACME }] });

    const items = await seedPlan(w.acme, 's1', [COMMITMENT, ROUTINE]);

    expect(items).toHaveLength(2);
    expect(items.every((i) => i.status === 'proposed')).toBe(true);

    // Lo que importa: ninguna tabla de ningún módulo se tocó.
    expect(w.tables.commitments ?? []).toHaveLength(0);
    expect(w.tables.scheduled_jobs ?? []).toHaveLength(0);
    expect(w.tables.pipelines ?? []).toHaveLength(0);
    expect(w.tables.clients ?? []).toHaveLength(0);
    expect(w.tables.kb_collections ?? []).toHaveLength(0);
  });

  it('sólo se puede confirmar lo que la propia sesión propuso', async () => {
    const w = world({
      guided_setup_sessions: [
        { id: 's1', organization_id: ACME },
        { id: 's2', organization_id: ACME },
      ],
    });
    const mine = await seedPlan(w.acme, 's1', [COMMITMENT]);
    const other = await seedPlan(w.acme, 's2', [ROUTINE]);

    // El id existe y es de la misma empresa, pero es de otra sesión: no sale.
    const picked = await pickProposed(w.acme, 's1', [only(mine).id, only(other).id]);
    expect(picked.map((i) => i.id)).toEqual([only(mine).id]);
  });

  it('un ítem ya decidido no se vuelve a crear', async () => {
    const w = world({
      guided_setup_sessions: [{ id: 's1', organization_id: ACME }],
      guided_setup_items: [
        {
          id: 'i1',
          organization_id: ACME,
          session_id: 's1',
          kind: 'commitment',
          title: 'Ya creado',
          rationale: '',
          payload: {},
          status: 'created',
          created_at: '2026-03-01T00:00:00Z',
        },
      ],
    });
    expect(await pickProposed(w.acme, 's1', ['i1'])).toHaveLength(0);
  });
});

describe('lo que se crea, se crea de verdad y se puede deshacer', () => {
  it('un vencimiento nace con fuente y desaparece al deshacerlo', async () => {
    const w = world({ guided_setup_sessions: [{ id: 's1', organization_id: ACME }] });
    const item = only(await seedPlan(w.acme, 's1', [COMMITMENT]));

    const outcome = await createOne(ctx(w.acme), item);
    expect(outcome.ok).toBe(true);
    expect(outcome.targetTable).toBe('commitments');

    const row = (w.tables.commitments ?? [])[0] as Record<string, unknown>;
    // El módulo no acepta una fecha sin procedencia. Aquí la persona es la fuente.
    expect(row.source_kind).toBe('manual');
    expect(row.source_user_id).toBe(USER);
    expect(row.organization_id).toBe(ACME);

    const created: SetupItem = {
      ...item,
      status: 'created',
      targetTable: outcome.targetTable ?? null,
      targetId: outcome.targetId ?? null,
    };
    expect((await undoOne(w.acme, created)).ok).toBe(true);
    expect(w.tables.commitments).toHaveLength(0);
  });

  it('una rutina nace apagada para escribir sola', async () => {
    const w = world({ guided_setup_sessions: [{ id: 's1', organization_id: ACME }] });
    const item = only(await seedPlan(w.acme, 's1', [ROUTINE]));

    const outcome = await createOne(ctx(w.acme), item);
    expect(outcome.ok).toBe(true);

    const row = (w.tables.scheduled_jobs ?? [])[0] as Record<string, unknown>;
    expect(row.kind).toBe('agent');
    expect(row.allow_unattended_writes).toBe(false);
    expect(row.next_run_at).toBeTruthy();
  });

  it('sin agente no inventa una rutina: lo dice', async () => {
    const w = world({ guided_setup_sessions: [{ id: 's1', organization_id: ACME }] });
    const item = only(await seedPlan(w.acme, 's1', [ROUTINE]));

    const outcome = await createOne(ctx(w.acme, { agentId: null }), item);
    expect(outcome.ok).toBe(false);
    expect(w.tables.scheduled_jobs ?? []).toHaveLength(0);
  });

  it('un espacio lo crea sólo un administrador', async () => {
    const w = world({ guided_setup_sessions: [{ id: 's1', organization_id: ACME }] });
    const item = only(await seedPlan(w.acme, 's1', [
      {
        kind: 'space',
        title: 'Contratos de transporte',
        rationale: '',
        payload: { name: 'Contratos de transporte', description: '' },
      },
    ]));

    const refused = await createOne(ctx(w.acme, { canCreateGlobalSpace: false }), item);
    expect(refused.ok).toBe(false);
    expect(w.tables.kb_collections ?? []).toHaveLength(0);

    const done = await createOne(ctx(w.acme), item);
    expect(done.ok).toBe(true);
    expect(w.tables.kb_collections).toHaveLength(1);
  });

  it('el payload se vuelve a pasar por el catálogo antes de escribir', async () => {
    // Una fila manipulada entre proponer y confirmar no llega al módulo.
    const w = world({ guided_setup_sessions: [{ id: 's1', organization_id: ACME }] });
    const tampered: SetupItem = {
      id: 'i1',
      kind: 'commitment',
      title: 'Sin fecha',
      rationale: '',
      payload: { title: 'Sin fecha' } as never,
      status: 'proposed',
      targetTable: null,
      targetId: null,
      error: null,
    };
    const outcome = await createOne(ctx(w.acme), tampered);
    expect(outcome.ok).toBe(false);
    expect(w.tables.commitments ?? []).toHaveLength(0);
  });
});

describe('deshacer no destruye lo que no era nuestro', () => {
  const client: SetupItem = {
    id: 'i1',
    kind: 'client',
    title: 'Alpina',
    rationale: '',
    payload: { name: 'Alpina' },
    status: 'created',
    targetTable: 'clients',
    targetId: 'c1',
    error: null,
  };

  it('no borra un cliente que ya existía antes de la entrevista', async () => {
    const w = world({ clients: [{ id: 'c1', organization_id: ACME, name: 'Alpina' }] });
    const result = await undoOne(w.acme, { ...client, status: 'merged' });
    expect(result.ok).toBe(false);
    expect(w.tables.clients).toHaveLength(1);
  });

  it('no borra un cliente al que ya le colgaron un contacto', async () => {
    const w = world({
      clients: [{ id: 'c1', organization_id: ACME, name: 'Alpina' }],
      client_contacts: [{ id: 'ct1', organization_id: ACME, client_id: 'c1' }],
    });
    const result = await undoOne(w.acme, client);
    expect(result.ok).toBe(false);
    expect(w.tables.clients).toHaveLength(1);
  });

  it('no borra un espacio con documentos adentro', async () => {
    const w = world({
      kb_collections: [{ id: 'k1', organization_id: ACME, name: 'Contratos' }],
      kb_documents: [{ id: 'd1', organization_id: ACME, collection_id: 'k1' }],
    });
    const result = await undoOne(w.acme, {
      ...client,
      kind: 'space',
      targetTable: 'kb_collections',
      targetId: 'k1',
    });
    expect(result.ok).toBe(false);
    expect(w.tables.kb_collections).toHaveLength(1);
  });
});

describe('una empresa no ve la configuración de otra', () => {
  it('no lee la sesión de otra empresa aunque tenga el id', async () => {
    const w = world({
      guided_setup_sessions: [
        { id: 's1', organization_id: ACME, status: 'proposed', created_at: '2026-03-01' },
      ],
    });
    expect(await getSession(w.acme, 's1')).not.toBeNull();
    expect(await getSession(w.globex, 's1')).toBeNull();
  });

  it('no lista ni puede confirmar los ítems de otra empresa', async () => {
    const w = world({
      guided_setup_sessions: [
        { id: 's1', organization_id: ACME },
        { id: 's9', organization_id: GLOBEX },
      ],
    });
    const acmeItems = await seedPlan(w.acme, 's1', [COMMITMENT]);
    await seedPlan(w.globex, 's9', [ROUTINE]);

    expect(await listItems(w.acme, 's1')).toHaveLength(1);
    expect(await listItems(w.globex, 's1')).toHaveLength(0);
    // Con el id exacto en la mano, la otra empresa sigue sin poder confirmarlo.
    expect(await pickProposed(w.globex, 's1', [only(acmeItems).id])).toHaveLength(0);
  });

  it('no deshace lo que creó otra empresa', async () => {
    const w = world({ guided_setup_sessions: [{ id: 's1', organization_id: ACME }] });
    const item = only(await seedPlan(w.acme, 's1', [COMMITMENT]));
    const outcome = await createOne(ctx(w.acme), item);

    const created: SetupItem = {
      ...item,
      status: 'created',
      targetTable: outcome.targetTable ?? null,
      targetId: outcome.targetId ?? null,
    };
    // Globex tiene el puntero exacto y aun así el borrado no alcanza la fila.
    await undoOne(w.globex, created);
    expect(w.tables.commitments).toHaveLength(1);

    await undoOne(w.acme, created);
    expect(w.tables.commitments).toHaveLength(0);
  });

  it('lo que una empresa escribe queda marcado con la suya', async () => {
    const w = world({ guided_setup_sessions: [{ id: 's9', organization_id: GLOBEX }] });
    await seedPlan(w.globex, 's9', [COMMITMENT]);
    const rows = (w.tables.guided_setup_items ?? []) as Record<string, unknown>[];
    expect(rows.every((r) => r.organization_id === GLOBEX)).toBe(true);
  });
});
