import type { ActiveOrganization, OrgRole } from '@cortex/core';

/**
 * EL SELECTOR DE ESPACIOS, COMO DATO. LA PINTURA ESTÁ EN
 * `components/nav/WorkspaceSwitcher.tsx`.
 *
 * ===========================================================================
 * QUÉ ESTABA MAL
 * ===========================================================================
 * Una cuenta puede pertenecer hasta a cinco espacios de trabajo y no había
 * NINGUNA forma de verlo ni de cambiar: `listMemberships()` y
 * `setActiveOrganization()` llevaban meses en `lib/organization.ts` sin un solo
 * llamador. Peor todavía, el nombre del espacio activo no se pintaba en ningún
 * sitio del shell, así que alguien invitado a dos empresas leía las cifras de
 * una creyendo que eran las de la otra y no tenía cómo enterarse. Un producto
 * multiempresa que no dice en qué empresa estás no es multiempresa: es una
 * ruleta.
 *
 * ===========================================================================
 * POR QUÉ ESTO ES UN `.ts` Y NO VIVE EN EL COMPONENTE
 * ===========================================================================
 * Por lo mismo que `nav-shape.ts`: el runner de este paquete corre en Node sin
 * DOM (`vitest.config.ts`, `environment: 'node'`), así que lo único que se
 * puede probar de verdad es lo que sea una función pura. Y aquí lo que puede
 * salir mal en silencio es justo eso — en qué orden se leen los espacios, qué
 * se enseña cuando sólo hay uno, y qué se promete antes de saber nada — no el
 * aspecto del menú.
 */

/** Un espacio tal y como lo devuelve `GET /api/organizations`. */
export interface Workspace {
  id: string;
  name: string;
  slug: string | null;
  role: OrgRole;
}

/** La respuesta entera de `GET /api/organizations`. */
export interface WorkspaceListPayload {
  workspaces: Workspace[];
  activeId: string;
  canCreate: boolean;
  /** Cuántos espacios admite una cuenta. Sale del servidor; aquí no se inventa. */
  limit: number;
}

/**
 * EN QUÉ DE LOS TRES ESTADOS ESTÁ EL SELECTOR.
 *
 * `unknown` no es un detalle de implementación que se pueda colapsar contra
 * `alone`: el shell pinta el nombre del espacio ANTES de preguntar por los
 * demás (ver más abajo), así que entre el primer pintado y la respuesta del
 * servidor no se sabe si hay entre qué elegir. Decir «éste es tu único espacio»
 * en ese hueco es afirmar algo que nadie ha comprobado, y decirlo justo antes
 * de listar otros cuatro.
 */
export type WorkspaceMenuState = 'unknown' | 'alone' | 'choice';

export interface WorkspaceMenu {
  /** El espacio en el que está pintada esta pantalla. Nunca falta. */
  active: Workspace;
  /** Los demás, ya ordenados para leerlos. Vacío mientras no se sepa. */
  others: Workspace[];
  state: WorkspaceMenuState;
  /**
   * Si se puede crear otro y, si no, la frase que lo explica. `null` mientras
   * no se sepa: un tope que no se ha consultado no se anuncia.
   */
  create: { can: boolean; reason: string | null };
}

/**
 * El espacio activo, tal y como lo conoce el servidor, convertido en fila.
 *
 * `ActiveOrganization` y `Workspace` son el mismo dato con dos orígenes —la
 * sesión y el endpoint— y esta función es el único sitio donde se cruzan.
 */
function fromSession(active: ActiveOrganization): Workspace {
  return { id: active.id, name: active.name, slug: active.slug, role: active.role };
}

/**
 * QUÉ ENSEÑA EL MENÚ, DADO LO QUE SE SABE.
 *
 * @param active lo que el shell ya sabía al renderizar en el servidor. Es la
 *   fuente de verdad de «dónde estoy», y no el `activeId` del endpoint: esta
 *   pantalla está pintada ENTERA contra este espacio, así que si la sesión se
 *   movió en otra pestaña mientras tanto, lo honesto es seguir diciendo el
 *   nombre de lo que se está viendo. La discrepancia se resuelve sola en la
 *   siguiente carga.
 * @param data la respuesta del endpoint, o `null` si todavía no ha llegado (o
 *   si falló).
 */
export function buildWorkspaceMenu(
  active: ActiveOrganization,
  data: WorkspaceListPayload | null,
): WorkspaceMenu {
  const mine = fromSession(active);
  if (!data) {
    return { active: mine, others: [], state: 'unknown', create: { can: false, reason: null } };
  }

  // El endpoint puede traer el nombre o el rol cambiados desde que se emitió
  // la sesión (a alguien lo ascendieron, o renombraron la empresa). Ese dato es
  // más nuevo que el de la cookie, así que gana; la IDENTIDAD del activo, no.
  const fresher = data.workspaces.find((w) => w.id === mine.id);
  const current = fresher ?? mine;

  // Si el activo NO viene en la lista, se queda igualmente. Pasa cuando a
  // alguien lo sacaron del espacio con la pantalla abierta: quitarlo de aquí
  // dejaría el selector enseñando el nombre de un espacio que no está en su
  // propio menú, que es la peor manera de contar esa expulsión.
  const others = sortWorkspaces(data.workspaces.filter((w) => w.id !== current.id));

  return {
    active: current,
    others,
    state: others.length > 0 ? 'choice' : 'alone',
    create: data.canCreate
      ? { can: true, reason: null }
      : { can: false, reason: limitReason(data.limit) },
  };
}

/**
 * Por nombre, no por antigüedad.
 *
 * `listMemberships()` devuelve en orden de `createdAt`, que es el orden en que
 * ocurrió la historia y no significa nada para quien lee: en una lista de
 * cinco nombres lo único que sirve es poder encontrar el tuyo mirando. El
 * desempate por id existe para que dos espacios llamados igual no se cambien
 * de sitio entre renders.
 */
function sortWorkspaces(list: Workspace[]): Workspace[] {
  return [...list].sort(
    (a, b) =>
      a.name.localeCompare(b.name, 'es', { sensitivity: 'base', numeric: true }) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Por qué no hay botón de crear.
 *
 * El número sale del endpoint y no de una constante de este archivo: el tope
 * lo pone `organizationLimit` en la configuración de better-auth, y una copia
 * aquí sería una cifra que se queda vieja el día que se suba el plan, en la
 * única frase del producto que existe para explicar precisamente esa cifra.
 */
export function limitReason(limit: number): string {
  if (limit <= 1) return 'Una cuenta sólo puede tener un espacio de trabajo.';
  return `Una cuenta puede tener hasta ${limit} espacios de trabajo, y ya están los ${limit}.`;
}

/** Cómo se dice cada rol en la lista. En minúscula: es una nota, no un título. */
export function roleLabel(role: OrgRole): string {
  if (role === 'owner') return 'dueño';
  if (role === 'admin') return 'administrador';
  return 'miembro';
}

/**
 * La letra que representa al espacio cuando el rail está contraído.
 *
 * La PRIMERA LETRA O CIFRA, no el primer carácter: un espacio llamado
 * «⚡ Vertix» o «(Nuevo) Acme» daría un símbolo, y una columna de 56px con un
 * paréntesis dentro no identifica nada. Se recorre por puntos de código para
 * no partir un emoji ni una letra acentuada por la mitad.
 */
export function workspaceInitial(name: string): string {
  for (const char of Array.from(name)) {
    if (/[\p{L}\p{N}]/u.test(char)) return char.toLocaleUpperCase('es');
  }
  return '·';
}
