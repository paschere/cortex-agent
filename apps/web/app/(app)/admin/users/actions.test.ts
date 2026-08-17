import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CANCELAR UNA INVITACIÓN ES LA ÚNICA PARTE DE ESTA PANTALLA QUE SERÍA UN
 * INCIDENTE SI SALE MAL, ASÍ QUE SE PRUEBA COMO TAL.
 *
 * Una acción de servidor tiene URL propia: se puede invocar sin haber pintado
 * nunca `/admin/users`, así que el 404 del layout no la protege. Y lo único que
 * llega de afuera es el id de la invitación — un valor que quien llama elige.
 * Las dos preguntas son entonces: ¿la puerta se comprueba aquí?, y ¿el id ajeno
 * hace algo?
 *
 * La base falsa aplica los filtros de verdad en vez de devolver filas fijas,
 * porque el fallo que se teme es que falte uno.
 */

const MINE = 'org-acme';
const THEIRS = 'org-rival';

interface Row {
  id: string;
  organizationId: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string;
}

const state = vi.hoisted(() => ({
  role: 'org_admin' as 'org_admin' | 'member',
  scopedTo: [] as string[],
  table: [] as Array<Record<string, unknown>>,
  revalidated: [] as string[],
}));

vi.mock('@/lib/session', () => ({
  requireSession: async () => ({
    id: 'u-1',
    role: state.role,
    organization: { id: MINE },
  }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    state.revalidated.push(path);
  },
}));

vi.mock('@/lib/supabase/service', () => ({
  getOrgScopedClient: (organizationId: string) => {
    state.scopedTo.push(organizationId);

    class Builder {
      filters: Array<[string, unknown]> = [];
      constructor(private readonly patch: Record<string, unknown> | null) {}
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
      // biome-ignore lint/suspicious/noThenProperty: el constructor de consultas de supabase-js ES un «thenable» (se espera con `await` sin llamar a `.then()`), así que un doble sin `then` no se podría probar contra el código real.
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        const matched = state.table.filter((row) =>
          this.filters.every(([column, value]) => row[column] === value),
        );
        if (this.patch) for (const row of matched) Object.assign(row, this.patch);
        return Promise.resolve({ data: matched.map((row) => ({ ...row })), error: null }).then(
          resolve,
          reject,
        );
      }
    }

    return {
      from: () => ({
        select: () => new Builder(null),
        update: (patch: Record<string, unknown>) => new Builder(patch),
      }),
    };
  },
}));

const { cancelInvitationAction } = await import('./actions');

function seed(): Row[] {
  const table: Row[] = [
    {
      id: 'i-mine',
      organizationId: MINE,
      email: 'ana@acme.com',
      role: 'member',
      status: 'pending',
      expiresAt: '2026-08-17T12:00:00.000Z',
    },
    {
      id: 'i-theirs',
      organizationId: THEIRS,
      email: 'ana@rival.com',
      role: 'admin',
      status: 'pending',
      expiresAt: '2026-08-17T12:00:00.000Z',
    },
  ];
  state.table = table as unknown as Array<Record<string, unknown>>;
  return table;
}

describe('cancelar una invitación desde Personas', () => {
  beforeEach(() => {
    state.role = 'org_admin';
    state.scopedTo = [];
    state.revalidated = [];
    seed();
  });

  it('no la cancela quien no administra el espacio, aunque la invitación sí sea suya', async () => {
    state.role = 'member';
    const result = await cancelInvitationAction('i-mine');
    expect(result.ok).toBe(false);
    expect(state.scopedTo).toEqual([]);
    expect(state.table.find((r) => r.id === 'i-mine')?.status).toBe('pending');
  });

  it('no toca la invitación de otro inquilino ni admite que existe', async () => {
    const result = await cancelInvitationAction('i-theirs');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ya no está pendiente/);
    expect(state.table.find((r) => r.id === 'i-theirs')?.status).toBe('pending');
  });

  it('abre la base con el espacio de la sesión y nunca con otro', async () => {
    await cancelInvitationAction('i-mine');
    expect(state.scopedTo).toEqual([MINE]);
  });

  it('cancela la propia y refresca las dos pantallas donde se ven los asientos', async () => {
    const result = await cancelInvitationAction('i-mine');
    expect(result.ok).toBe(true);
    expect(state.table.find((r) => r.id === 'i-mine')?.status).toBe('canceled');
    expect(state.revalidated).toEqual(['/admin/users', '/plan']);
  });

  it('se niega sin id, en vez de mandar un filtro vacío a la base', async () => {
    const result = await cancelInvitationAction('');
    expect(result.ok).toBe(false);
    expect(state.scopedTo).toEqual([]);
  });
});
