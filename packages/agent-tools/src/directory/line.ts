/**
 * La línea de mando, como cálculo. Ni base de datos, ni reloj, ni red.
 *
 * ===========================================================================
 * POR QUÉ ESTO ES UN ARCHIVO PURO Y NO TRES CONSULTAS
 * ===========================================================================
 * Lo que se decide aquí es A QUIÉN LE LLEGA UN CORREO POR ENCIMA DE TU CABEZA.
 * Un escalado que va a la persona equivocada no se ve roto en ninguna pantalla:
 * la fila existe, el aviso salió, el diario dice «entregado», y el único síntoma
 * es que la persona que tenía que enterarse no se enteró. No hay forma de
 * descubrir eso mirando el producto, así que tiene que descubrirse mirando una
 * prueba — y para eso la regla tiene que ser una función que recibe un mapa y
 * devuelve un id, sin nada que levantar.
 *
 * Es la misma disciplina que `commitments/shape.ts` (`noticesOwed`) y
 * `company/shape.ts`, y por el mismo motivo: la parte del producto que decide
 * quién recibe qué se prueba caso por caso en Node.
 *
 * ===========================================================================
 * TODA LECTURA DE LA CADENA VA ACOTADA. LAS DOS COSAS, NO UNA
 * ===========================================================================
 * La 0106 impide crear un ciclo con un disparador. Aun así, cada recorrido de
 * aquí lleva un TOPE DE PROFUNDIDAD y un CONJUNTO DE VISITADOS, porque una fila
 * mala escrita por una migración, por una restauración parcial o a mano no la
 * para ninguna validación de escritura — y el sitio donde se leería esa fila es
 * el vigilante nocturno, sin nadie delante. Un `while` sin tope ahí no da un
 * error: deja de mandar los avisos de toda la empresa, en silencio, hasta que
 * alguien mire por qué.
 */

/** Lo mínimo que hace falta para recorrer la cadena: una fila y su jefe. */
export interface ManagerLink {
  id: string;
  managerId: string | null;
}

/** id → id de su jefe (o null). Es lo que consume todo este archivo. */
export type ManagerMap = ReadonlyMap<string, string | null>;

/**
 * Lo más alto que se sube por una cadena.
 *
 * Doce. No es una cota teórica: es «más escalones que los que tiene cualquier
 * empresa que quepa en este producto», con margen de sobra. Una organización
 * colombiana de cuarenta personas tiene tres o cuatro niveles; doce deja pasar
 * cualquier jerarquía real y corta en seco cualquier cosa que no lo sea.
 */
export const MAX_LINE_DEPTH = 12;

export function managerMapOf(links: readonly ManagerLink[]): ManagerMap {
  return new Map(links.map((l) => [l.id, l.managerId]));
}

export interface Chain {
  /** Los jefes, del más cercano al más lejano. Nunca incluye a la persona. */
  above: string[];
  /** La cadena se cortó por el tope de profundidad. */
  capped: boolean;
  /** Se volvió a pasar por alguien: los datos tienen un ciclo. */
  cycle: boolean;
}

/**
 * Toda la línea por encima de alguien, acotada.
 *
 * `cycle` y `capped` se devuelven en vez de lanzarse porque quien llama casi
 * siempre puede seguir trabajando con lo que sí se pudo recorrer —el escalado
 * necesita UN nombre, no la cadena entera— y una excepción aquí convertiría una
 * fila mala de una persona en un fallo del barrido de toda la empresa.
 */
export function chainAbove(
  managers: ManagerMap,
  userId: string,
  maxDepth: number = MAX_LINE_DEPTH,
): Chain {
  const above: string[] = [];
  const seen = new Set<string>([userId]);
  let walker = managers.get(userId) ?? null;

  while (walker) {
    if (seen.has(walker)) return { above, capped: false, cycle: true };
    if (above.length >= maxDepth) return { above, capped: true, cycle: false };
    seen.add(walker);
    above.push(walker);
    walker = managers.get(walker) ?? null;
  }
  return { above, capped: false, cycle: false };
}

/**
 * ¿Poner a `candidate` de jefe de `userId` cerraría un círculo?
 *
 * La puerta de escritura. Contesta que sí también cuando la persona se elige a
 * sí misma: es el ciclo de longitud uno y merece el mismo mensaje que los
 * demás, no un error distinto por un caso que la gente comete a diario
 * eligiendo mal en un desplegable.
 *
 * Una cadena que YA tiene un ciclo por encima del candidato también cuenta como
 * sí: colgar una rama nueva de una cadena rota es propagar el problema.
 */
export function wouldCycle(managers: ManagerMap, userId: string, candidate: string): boolean {
  if (userId === candidate) return true;
  const chain = chainAbove(managers, candidate);
  if (chain.cycle) return true;
  return chain.above.includes(userId);
}

// ---------------------------------------------------------------------------
// El destinatario de un escalado
// ---------------------------------------------------------------------------

/** Por dónde se resolvió el destinatario. Se guarda para poder explicarlo. */
export type EscalationVia = 'named' | 'manager' | 'admin' | 'none';

export interface EscalationTarget {
  userId: string | null;
  via: EscalationVia;
}

export interface EscalationInput {
  /** Lo nombrado a mano en ese compromiso (`commitments.escalate_to_user_id`). */
  escalateToUserId: string | null;
  /** Quién responde por el compromiso (`commitments.owner_user_id`). */
  ownerUserId: string | null;
  managers: ManagerMap;
  /** Los administradores del espacio, EN UN ORDEN ESTABLE. Ver `orgAdmins`. */
  admins: readonly string[];
}

/**
 * A quién se le sube un compromiso que nadie atendió.
 *
 * ===========================================================================
 * EL ORDEN, Y POR QUÉ ES ESE
 * ===========================================================================
 *   1. LO NOMBRADO A MANO GANA SIEMPRE. Alguien se sentó a decir «si esto se
 *      cae, avisa a Marcela». Ninguna jerarquía derivada tiene derecho a
 *      contradecir una instrucción explícita sobre esa fila concreta, y respetar
 *      esto es lo que hace que la 0106 no toque ni un compromiso existente.
 *
 *   2. EL JEFE DEL RESPONSABLE. Un escalón, no la cadena entera: subir al jefe
 *      del jefe cuando el jefe existe es saltárselo, y el escalado dejaría de
 *      ser «tu jefe se enteró» para ser «te acusaron ante el gerente».
 *
 *   3. EL PRIMER ADMINISTRADOR, en un orden estable. Es lo que había y sigue
 *      siendo el suelo, pero ahora sólo lo pisa quien no tiene jefe puesto.
 *
 * ===========================================================================
 * LAS DOS GUARDAS QUE PARECEN PARANOIA Y NO LO SON
 * ===========================================================================
 * UN JEFE QUE ES LA PROPIA PERSONA NO ES UN ESCALADO. La 0106 lo impide en la
 * base, pero esto se lee en un cron sobre datos que pueden venir de una
 * restauración, y «escalar» a la misma persona que ya recibió el aviso de
 * vencido y no contestó es exactamente el fallo silencioso que este módulo
 * existe para cerrar: dos correos idénticos y nadie por encima enterándose.
 *
 * UN JEFE QUE NO ESTÁ EN EL MAPA NO EXISTE. El mapa se lee con el handle con
 * alcance del espacio de trabajo, así que un id que no aparece en él es un id de
 * otra empresa o de una cuenta borrada. En los dos casos la respuesta correcta
 * es bajar al escalón siguiente, no mandarle un correo.
 */
export function escalationTarget(input: EscalationInput): EscalationTarget {
  if (input.escalateToUserId) return { userId: input.escalateToUserId, via: 'named' };

  const owner = input.ownerUserId;
  if (owner) {
    const manager = input.managers.get(owner) ?? null;
    if (manager && manager !== owner && input.managers.has(manager)) {
      return { userId: manager, via: 'manager' };
    }
  }

  const admin = input.admins[0] ?? null;
  return admin ? { userId: admin, via: 'admin' } : { userId: null, via: 'none' };
}

// ---------------------------------------------------------------------------
// El árbol, para enseñarlo
// ---------------------------------------------------------------------------

export type DirectoryRole = 'member' | 'team_admin' | 'org_admin';

export interface DirectoryPerson {
  id: string;
  email: string;
  name: string | null;
  role: DirectoryRole;
  managerId: string | null;
}

export interface LineNode {
  person: DirectoryPerson;
  reports: LineNode[];
  /**
   * Su jefe forma un ciclo, así que se dibuja como raíz y se dice en pantalla.
   * Debería ser siempre `false`: la 0106 no deja crear ciclos.
   */
  broken: boolean;
}

export interface OrgLine {
  /** Quien no tiene jefe (o lo tiene roto), con su gente colgando debajo. */
  roots: LineNode[];
  /** Cuánta gente no tiene jefe puesto. Es la cifra que mide si esto se usa. */
  unmanaged: number;
  /** Ids implicados en un ciclo. Vacío salvo que los datos estén mal. */
  cycles: string[];
  /** Escalones del árbol más profundo. 1 cuando nadie tiene jefe. */
  depth: number;
}

/**
 * El directorio, dibujado como línea.
 *
 * NUNCA CUELGA Y NUNCA PIERDE A NADIE, y las dos cosas cuestan lo mismo: cada
 * persona se comprueba con `chainAbove` antes de colgarla de su jefe, y quien
 * esté en un ciclo se dibuja como raíz marcada en vez de desaparecer del árbol.
 * Una pantalla de personas a la que le falta gente es peor que una que enseña
 * un dato malo, porque la ausencia no se nota.
 *
 * El orden es por nombre en español, con la gente sin nombre puesto ordenada por
 * su correo — que es lo que la pantalla enseña de ellos.
 */
export function buildOrgLine(people: readonly DirectoryPerson[]): OrgLine {
  const managers = managerMapOf(people.map((p) => ({ id: p.id, managerId: p.managerId })));
  const cycles: string[] = [];

  const nodes = new Map<string, LineNode>();
  for (const person of people) {
    const broken = person.managerId ? chainAbove(managers, person.id).cycle : false;
    if (broken) cycles.push(person.id);
    nodes.set(person.id, { person, reports: [], broken });
  }

  const roots: LineNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.broken ? null : node.person.managerId;
    const parent = parentId ? nodes.get(parentId) : undefined;
    // Un jefe que no está en el mapa es de otro espacio o ya no existe. La
    // persona se queda como raíz en vez de perderse: ver arriba.
    if (parent) parent.reports.push(node);
    else roots.push(node);
  }

  const label = (n: LineNode) => n.person.name?.trim() || n.person.email;
  const sort = (list: LineNode[]) => {
    list.sort((a, b) => label(a).localeCompare(label(b), 'es'));
    for (const n of list) sort(n.reports);
  };
  sort(roots);

  const deep = (n: LineNode, level: number): number =>
    n.reports.reduce((max, r) => Math.max(max, deep(r, level + 1)), level);

  return {
    roots,
    unmanaged: people.filter((p) => !p.managerId).length,
    cycles,
    depth: roots.reduce((max, r) => Math.max(max, deep(r, 1)), 0),
  };
}

/** Cómo se nombra a alguien en pantalla y en una respuesta del chat. */
export function personLabel(person: Pick<DirectoryPerson, 'name' | 'email'>): string {
  return person.name?.trim() || person.email;
}
