import { describe, expect, it } from 'vitest';
import { CANCELED, cancelInvitation, listPendingInvitations } from './invitations';

/**
 * EL AISLAMIENTO POR INQUILINO DE LAS INVITACIONES, QUE NO TENÍA NINGUNA PRUEBA.
 *
 * `ba_invitation` está clasificada `shared(...)`, así que el manejador acotado
 * NO le añade el filtro de espacio: lo escribe esta capa a mano. Eso convierte
 * un descuido de una línea —borrar un `.eq('organizationId', …)` que parece
 * redundante al lado de los otros filtros— en ver y cancelar las invitaciones
 * de otra empresa, sin error, sin registro y sin nada que mirar.
 *
 * Por eso la base falsa de abajo no devuelve filas fijas: aplica los filtros que
 * la consulta pide, exactamente como haría PostgREST. Una prueba que simulara la
 * respuesta pasaría igual de bien con el filtro puesto que sin él, que es lo
 * único que aquí hay que comprobar.
 */

interface Row {
  id: string;
  organizationId: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string;
}

const MINE = 'org-acme';
const THEIRS = 'org-rival';

const HOY = new Date('2026-08-15T12:00:00.000Z');
const EN_48H = '2026-08-17T12:00:00.000Z';
const HACE_UN_DIA = '2026-08-14T12:00:00.000Z';

function rows(): Row[] {
  return [
    {
      id: 'i-1',
      organizationId: MINE,
      email: 'ana@acme.com',
      role: 'member',
      status: 'pending',
      expiresAt: EN_48H,
    },
    {
      id: 'i-2',
      organizationId: MINE,
      email: 'beto@acme.com',
      role: 'admin',
      status: 'pending',
      expiresAt: HACE_UN_DIA,
    },
    {
      id: 'i-3',
      organizationId: MINE,
      email: 'ya@acme.com',
      role: 'member',
      status: 'accepted',
      expiresAt: EN_48H,
    },
    {
      id: 'i-4',
      organizationId: THEIRS,
      email: 'ana@rival.com',
      role: 'admin',
      status: 'pending',
      expiresAt: EN_48H,
    },
  ];
}

/**
 * Una base de datos falsa que FILTRA. Sólo entiende lo que esta capa usa:
 * `.eq()`, `.order()` y `.select()`, en cualquier orden, sobre una tabla.
 */
function fakeDb(table: Row[]) {
  const queries: Array<{ table: string; filters: Array<[string, unknown]> }> = [];

  class Builder {
    filters: Array<[string, unknown]> = [];
    constructor(
      private readonly name: string,
      private readonly patch: Record<string, unknown> | null,
    ) {}
    eq(column: string, value: unknown) {
      this.filters.push([column, value]);
      return this;
    }
    order() {
      return this;
    }
    select() {
      return this;
    }
    private run() {
      queries.push({ table: this.name, filters: this.filters });
      const matched = table.filter((row) =>
        this.filters.every(
          ([column, value]) => (row as unknown as Record<string, unknown>)[column] === value,
        ),
      );
      if (this.patch) for (const row of matched) Object.assign(row, this.patch);
      return { data: matched.map((row) => ({ ...row })), error: null };
    }
    // biome-ignore lint/suspicious/noThenProperty: el constructor de consultas de supabase-js ES un «thenable» (se espera con `await` sin llamar a `.then()`), así que un doble sin `then` no se podría probar contra el código real.
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
  }

  const db = {
    from: (name: string) => ({
      select: (_columns?: string) => new Builder(name, null),
      update: (patch: Record<string, unknown>) => new Builder(name, patch),
    }),
  };

  // El tipo real es SupabaseClient; el doble implementa la parte que se usa.
  return { db: db as never, queries };
}

describe('leer las invitaciones pendientes', () => {
  it('no deja ver las de otra empresa', async () => {
    const { db } = fakeDb(rows());
    const pending = await listPendingInvitations(db, MINE, HOY);
    expect(pending.map((i) => i.email)).toEqual(['ana@acme.com', 'beto@acme.com']);
  });

  it('nombra el espacio en la consulta, porque el manejador acotado no lo hace por ella', async () => {
    const { db, queries } = fakeDb(rows());
    await listPendingInvitations(db, MINE, HOY);
    expect(queries[0]?.filters).toContainEqual(['organizationId', MINE]);
  });

  it('deja fuera las aceptadas y las canceladas, que no esperan a nadie', async () => {
    const { db } = fakeDb(rows());
    const pending = await listPendingInvitations(db, MINE, HOY);
    expect(pending.map((i) => i.id)).not.toContain('i-3');
  });

  it('mantiene las vencidas y las marca, en vez de hacerlas desaparecer', async () => {
    const { db } = fakeDb(rows());
    const pending = await listPendingInvitations(db, MINE, HOY);
    const vencida = pending.find((i) => i.id === 'i-2');
    expect(vencida?.expired).toBe(true);
    // Y la que todavía sirve no se marca.
    expect(pending.find((i) => i.id === 'i-1')?.expired).toBe(false);
  });

  it('se rompe en vez de devolver una lista vacía cuando la tabla no se puede leer', async () => {
    const roto = {
      from: () => ({
        select: () => ({
          eq() {
            return this;
          },
          order() {
            return this;
          },
          // biome-ignore lint/suspicious/noThenProperty: mismo motivo que arriba — el doble imita un constructor de consultas, que se espera con `await`.
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { message: 'column does not exist' } }).then(
              resolve,
            ),
        }),
      }),
    } as never;
    await expect(listPendingInvitations(roto, MINE, HOY)).rejects.toThrow(
      /las invitaciones pendientes/,
    );
  });
});

describe('cancelar una invitación', () => {
  it('no toca la de otra empresa aunque le pasen su id exacto', async () => {
    const table = rows();
    const { db } = fakeDb(table);
    const canceled = await cancelInvitation(db, MINE, 'i-4');
    expect(canceled).toBe(false);
    expect(table.find((r) => r.id === 'i-4')?.status).toBe('pending');
  });

  it('libera el asiento de la propia, dejándola de contar como pendiente', async () => {
    const table = rows();
    const { db } = fakeDb(table);
    expect(await cancelInvitation(db, MINE, 'i-1')).toBe(true);
    const pending = await listPendingInvitations(db, MINE, HOY);
    expect(pending.map((i) => i.id)).toEqual(['i-2']);
  });

  it('escribe el mismo estado que escribe better-auth, con una sola ele', async () => {
    const table = rows();
    const { db } = fakeDb(table);
    await cancelInvitation(db, MINE, 'i-1');
    expect(table.find((r) => r.id === 'i-1')?.status).toBe(CANCELED);
    expect(CANCELED).toBe('canceled');
  });

  it('no revive una ya aceptada: la persona está adentro y el botón no la saca', async () => {
    const table = rows();
    const { db } = fakeDb(table);
    expect(await cancelInvitation(db, MINE, 'i-3')).toBe(false);
    expect(table.find((r) => r.id === 'i-3')?.status).toBe('accepted');
  });
});
