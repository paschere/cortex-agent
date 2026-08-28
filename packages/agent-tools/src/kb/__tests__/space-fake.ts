/**
 * La frontera de acceso al cerebro, en memoria.
 *
 * Desde la 0123 «quién ve este espacio» no se deduce de una columna: se resuelve
 * en la base de datos, cruzando las concesiones de `kb_space_grants` con los
 * equipos de la persona y con su rol. Los dobles de prueba que fingen PostgREST
 * no pueden fingir eso tabla por tabla, así que lo fingen aquí, UNA vez, y con
 * las mismas reglas que el SQL — este archivo es el espejo de `kb_space_level`,
 * `kb_spaces_for` y `kb_space_for`, y hay que leerlos juntos.
 *
 * Que sea uno solo es el punto. Cuando cada test escribía su propio filtro de
 * visibilidad, lo que probaban era su filtro y no el del producto; el bug de
 * 0049 —cada llamador decidiendo por su cuenta qué podía ver— tenía esa misma
 * forma.
 */

// biome-ignore lint/suspicious/noExplicitAny: filas de un doble de base de datos
export type FakeRow = Record<string, any>;
export type FakeStore = Record<string, FakeRow[] | undefined>;

const RANK: Record<string, number> = { view: 1, contribute: 2, admin: 3 };

/** Mismo orden que `kb_grant_rank`: gana el nivel más alto de todos los caminos. */
function best(levels: string[]): string | null {
  let winner: string | null = null;
  for (const l of levels) {
    if (!winner || (RANK[l] ?? 0) > (RANK[winner] ?? 0)) winner = l;
  }
  return winner;
}

/** Espejo de `kb_space_level`. Null cuando no lo ve — incluido «es de otra empresa». */
export function fakeSpaceLevel(
  store: FakeStore,
  userId: string | null,
  spaceId: string,
): string | null {
  if (!userId) return null;
  const user = (store.users ?? []).find((u) => u.id === userId);
  if (!user) return null;
  const space = (store.kb_collections ?? []).find((c) => c.id === spaceId);
  if (!space) return null;
  // El aislamiento entre empresas primero, y sin excepción. Se comprueba sólo
  // cuando las dos filas dicen de qué empresa son: hay fixtures de una sola
  // empresa que no ponen la columna, y ahí la pregunta no se hace.
  if (
    space.organization_id &&
    user.organization_id &&
    space.organization_id !== user.organization_id
  ) {
    return null;
  }

  const levels: string[] = [];
  if (space.scope === 'user' && space.scope_id === userId) levels.push('admin');
  if (space.scope === 'global' && user.role === 'org_admin') levels.push('admin');

  const myTeams = new Set(
    (store.team_members ?? []).filter((tm) => tm.user_id === userId).map((tm) => tm.team_id),
  );
  for (const g of store.kb_space_grants ?? []) {
    if (g.space_id !== spaceId) continue;
    const reaches =
      g.subject_kind === 'everyone' ||
      (g.subject_kind === 'user' && g.subject_id === userId) ||
      (g.subject_kind === 'team' && myTeams.has(g.subject_id));
    if (reaches) levels.push(g.level ?? 'view');
  }

  return best(levels);
}

function shape(store: FakeStore, space: FakeRow, level: string): FakeRow {
  const grants = (store.kb_space_grants ?? []).filter((g) => g.space_id === space.id);
  return {
    id: space.id,
    name: space.name,
    scope: space.scope,
    scope_id: space.scope_id ?? null,
    description: space.description ?? null,
    created_by: space.created_by ?? null,
    created_at: space.created_at ?? '2026-01-01T00:00:00Z',
    level,
    everyone: grants.some((g) => g.subject_kind === 'everyone'),
    grant_count: grants.filter((g) => g.subject_kind !== 'everyone').length,
  };
}

/** Espejo de `kb_spaces_for`. */
export function fakeSpacesFor(store: FakeStore, userId: string | null): FakeRow[] {
  return (store.kb_collections ?? [])
    .map((space) => {
      const level = fakeSpaceLevel(store, userId, space.id);
      return level ? shape(store, space, level) : null;
    })
    .filter((r): r is FakeRow => r !== null);
}

/**
 * Los tres RPC de espacios, listos para enchufar a un doble de base de datos.
 * Se mezclan con los que el test defina, y los del test ganan: un test que
 * quiera probar qué pasa cuando la visibilidad contesta cualquier otra cosa
 * tiene que poder decirlo.
 */
export function fakeSpaceRpcs(
  storeOf: () => FakeStore,
): Record<string, (args: Record<string, unknown>) => unknown> {
  return {
    kb_space_level: (args) =>
      fakeSpaceLevel(storeOf(), (args.p_user_id as string) ?? null, args.p_space_id as string),
    kb_spaces_for: (args) => fakeSpacesFor(storeOf(), (args.p_user_id as string) ?? null),
    kb_space_for: (args) =>
      fakeSpacesFor(storeOf(), (args.p_user_id as string) ?? null).filter(
        (r) => r.id === args.p_space_id,
      ),
    kb_space_access: (args) => {
      const store = storeOf();
      const userId = (args.p_user_id as string) ?? null;
      const spaceId = args.p_space_id as string;
      if (fakeSpaceLevel(store, userId, spaceId) !== 'admin') return [];
      return (store.kb_space_grants ?? [])
        .filter((g) => g.space_id === spaceId)
        .map((g) => ({
          grant_id: g.id,
          subject_kind: g.subject_kind,
          subject_id: g.subject_id ?? null,
          subject_name:
            g.subject_kind === 'everyone'
              ? 'Toda la empresa'
              : g.subject_kind === 'team'
                ? ((store.teams ?? []).find((t) => t.id === g.subject_id)?.name ?? null)
                : ((store.users ?? []).find((u) => u.id === g.subject_id)?.name ?? null),
          level: g.level ?? 'view',
          granted_at: g.created_at ?? '2026-01-01T00:00:00Z',
        }));
    },
  };
}

/**
 * La concesión que la migración 0123 escribe para todo espacio que ya era
 * global. Un fixture que declare un espacio común y no la incluya está
 * describiendo un estado que en producción no existe, y todo el mundo dejaría
 * de ver ese espacio.
 */
export function everyoneGrant(spaceId: string, organizationId?: string): FakeRow {
  return {
    id: `grant_everyone_${spaceId}`,
    ...(organizationId ? { organization_id: organizationId } : {}),
    space_id: spaceId,
    subject_kind: 'everyone',
    subject_id: null,
    level: 'view',
    created_at: '2026-01-01T00:00:00Z',
  };
}
