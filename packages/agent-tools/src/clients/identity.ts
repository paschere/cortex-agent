import {
  type LinkMethod,
  METHOD_CONFIDENCE,
  domainOf,
  fullNit,
  isPublicDomain,
  nameKey,
  nitDv,
  normalizeDomain,
  normalizeEmail,
  strictNameKey,
} from './shape';

/**
 * QUIÉN ES ESTE CLIENTE: la identidad, sin base de datos.
 *
 * Lo que entra por una integración —una factura de Siigo, una línea del
 * extracto, un pago, un correo— trae su contraparte escrita a su manera:
 * «830.025.281-7», «8300252817», «COLTRANS S.A.S.», «Coltráns», un remitente
 * @coltrans.com. Este archivo decide, con reglas puras y comprobables, a qué
 * cliente apunta cada una de esas formas, y —tan importante como eso— CUÁNDO
 * NO SE PUEDE DECIR.
 *
 * LA REGLA DE 0075 SIGUE MANDANDO: un vínculo que no se ganó es peor que
 * ninguno. Por eso cada respuesta trae `applies`:
 *
 *   true   el dato repite algo que una persona o el sistema de origen YA
 *          afirmó: el NIT del campo estructurado de la factura (la DIAN lo
 *          exige), el dominio que alguien registró, el correo de un contacto
 *          registrado, o un alias que una persona confirmó. Se aplica solo.
 *   false  es una inferencia: un nombre parecido, un nombre que calza con dos
 *          clientes, un NIT citado dentro de un texto libre. Queda «por
 *          confirmar» y no cuenta en ninguna cifra hasta que alguien diga sí.
 *
 * Dos candidatos igual de buenos NUNCA producen respuesta: `client` es null y
 * `ambiguous` es true. Elegir uno sería lanzar una moneda y guardarla como
 * hecho.
 */

// ---------------------------------------------------------------------------
// El NIT, con y sin dígito de verificación
// ---------------------------------------------------------------------------

/**
 * Las formas posibles del NIT base (sin DV) que una cadena puede representar.
 *
 * «830.025.281-7» → ['830025281'] (el guion separa el DV, y debe cuadrar).
 * «8300252817»    → ['8300252817', '830025281'] — sin separador no se sabe si
 *                   el último dígito es el DV o parte del número; se ofrecen
 *                   las dos lecturas SOLO si el último dígito es justamente el
 *                   DV de los anteriores, que es lo que hacen Siigo y Alegra al
 *                   exportar el NIT pegado.
 * «830025281-3»   → [] — un DV escrito que contradice el número es un error
 *                   de digitación, y emparejar con él sería premiar el error.
 *
 * Los ceros a la izquierda se quitan: algunos sistemas rellenan a 10 o 15
 * dígitos y el NIT de la DIAN no los lleva.
 */
export function nitVariants(raw: string | null | undefined): string[] {
  const text = (raw ?? '').trim();
  if (!text) return [];
  const tail = text.match(/[-\s]\s*(\d)\s*$/);
  const strip = (d: string) => d.replace(/^0+(?=\d{4})/, '');
  if (tail) {
    const body = strip(text.slice(0, tail.index).replace(/\D/g, ''));
    if (!/^\d{4,15}$/.test(body)) return [];
    const given = Number(tail[1]);
    return nitDv(body) === given ? [body] : [];
  }
  const digits = strip(text.replace(/\D/g, ''));
  if (!/^\d{4,15}$/.test(digits)) return [];
  const out = [digits];
  const head = digits.slice(0, -1);
  if (head.length >= 4 && nitDv(head) === Number(digits.slice(-1))) out.push(head);
  return out;
}

// ---------------------------------------------------------------------------
// El índice: todo lo que identifica a un cliente, en memoria
// ---------------------------------------------------------------------------

export interface IdentityClient {
  id: string;
  name: string;
  legal_name?: string | null;
  tax_id?: string | null;
}

export interface IdentityAlias {
  client_id: string;
  alias: string;
  /** Quién lo confirmó. Un alias sin persona detrás es una sugerencia, no un alias. */
  verified_by?: string | null;
}

export interface IdentityDomain {
  client_id: string;
  domain: string;
  verified_by?: string | null;
}

export interface IdentityContact {
  client_id: string;
  email: string | null;
  /** Quién lo registró: el testigo de un vínculo aplicado por su correo. */
  created_by?: string | null;
}

export interface ClientIndex {
  clients: Map<string, IdentityClient>;
  byTaxId: Map<string, string>;
  /** Clave estricta (sin sufijo plegado) → clientes. Un alias verificado entra aquí. */
  byAlias: Map<string, Set<string>>;
  /** Clave estricta de alias → quién lo afirmó. */
  aliasWitness: Map<string, string>;
  /** Clave suelta (sufijo legal fuera) → clientes, por nombre o razón social. */
  byLooseName: Map<string, Set<string>>;
  byDomain: Map<string, { clientId: string; witness: string | null }>;
  byEmail: Map<string, { clientId: string; witness: string | null }>;
}

function addTo(map: Map<string, Set<string>>, key: string, id: string) {
  if (!key) return;
  const set = map.get(key) ?? new Set<string>();
  set.add(id);
  map.set(key, set);
}

/** Arma el índice una vez; el barrido lo reutiliza para miles de filas. */
export function buildClientIndex(input: {
  clients: IdentityClient[];
  aliases?: IdentityAlias[];
  domains?: IdentityDomain[];
  contacts?: IdentityContact[];
}): ClientIndex {
  const index: ClientIndex = {
    clients: new Map(),
    byTaxId: new Map(),
    byAlias: new Map(),
    aliasWitness: new Map(),
    byLooseName: new Map(),
    byDomain: new Map(),
    byEmail: new Map(),
  };
  for (const c of input.clients) {
    index.clients.set(c.id, c);
    if (c.tax_id) index.byTaxId.set(c.tax_id, c.id);
    for (const n of [c.name, c.legal_name]) {
      if (!n) continue;
      addTo(index.byLooseName, nameKey(n), c.id);
    }
  }
  for (const a of input.aliases ?? []) {
    if (!index.clients.has(a.client_id)) continue;
    // Sólo los alias que una persona confirmó cuentan como afirmación. Los
    // demás también ayudan a encontrar, pero por la puerta suelta.
    if (a.verified_by) {
      const key = strictNameKey(a.alias);
      addTo(index.byAlias, key, a.client_id);
      index.aliasWitness.set(key, a.verified_by);
    }
    addTo(index.byLooseName, nameKey(a.alias), a.client_id);
  }
  for (const d of input.domains ?? []) {
    if (!index.clients.has(d.client_id)) continue;
    index.byDomain.set(normalizeDomain(d.domain), {
      clientId: d.client_id,
      witness: d.verified_by ?? null,
    });
  }
  for (const c of input.contacts ?? []) {
    const email = normalizeEmail(c.email);
    if (email && index.clients.has(c.client_id)) {
      index.byEmail.set(email, { clientId: c.client_id, witness: c.created_by ?? null });
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/** Cómo se llegó al cliente, en el vocabulario del encargo. */
export type MatchedBy = 'tax_id' | 'name' | 'email' | 'domain' | 'person';

export interface ResolveInput {
  /** El NIT tal como venga: con puntos, con o sin DV. */
  taxId?: string | null;
  /** El nombre tal como venga: «COLTRANS S.A.S.», «Coltráns». */
  name?: string | null;
  email?: string | null;
  domain?: string | null;
}

export interface ResolveCandidate {
  clientId: string;
  name: string;
  matchedBy: MatchedBy;
  /** El método de 0075 que se guarda en client_links.method. */
  method: LinkMethod;
  confidence: number;
  /** Lo literal que lo justifica: «NIT 830.025.281-7», «carlos@coltrans.com». */
  evidence: string;
  /**
   * La persona detrás de la afirmación que se repite: quien registró el
   * dominio, el contacto o el alias. Es el `confirmed_by` de un vínculo
   * aplicado en `client_links` (0075 exige testigo). Null para el NIT del
   * campo estructurado, que se guarda en la columna `client_id` de la tabla
   * dueña y no en `client_links`.
   */
  witness?: string | null;
}

export interface ResolveResult {
  /** El cliente, sólo si la respuesta es UNA. */
  client: ResolveCandidate | null;
  /** True cuando el vínculo repite algo afirmado y puede aplicarse solo. */
  applies: boolean;
  /** Todos los que calzan, el más fuerte primero. Para «por confirmar». */
  candidates: ResolveCandidate[];
  ambiguous: boolean;
  /**
   * El NIT de la entrada contradice al del cliente que el nombre señala.
   * Dos NIT distintos son dos empresas distintas para la DIAN; un nombre
   * parecido no gana a eso, y la fila queda sin vincular.
   */
  conflict: boolean;
}

const NONE: ResolveResult = {
  client: null,
  applies: false,
  candidates: [],
  ambiguous: false,
  conflict: false,
};

/**
 * A qué cliente apunta una contraparte, según lo que traiga.
 *
 * El orden es el de la fuerza de la evidencia y se corta en la primera que
 * contesta con UNO:
 *
 *   1. NIT del campo estructurado     → aplica.
 *   2. Correo de un contacto          → aplica.
 *   3. Dominio registrado             → aplica (nunca un dominio público).
 *   4. Alias confirmado por persona   → aplica, si es uno solo.
 *   5. Nombre/razón social (suelto)   → PROPONE, si es uno solo.
 *   6. Varios por nombre              → ambiguo: candidatos, sin respuesta.
 *
 * Si la entrada trae NIT y el nombre señala a un cliente que tiene OTRO NIT,
 * no se propone nada: son dos empresas.
 */
export function resolveAgainst(index: ClientIndex, input: ResolveInput): ResolveResult {
  const nameOf = (id: string) => index.clients.get(id)?.name ?? '';
  const variants = nitVariants(input.taxId);

  // 1. El NIT.
  for (const v of variants) {
    const id = index.byTaxId.get(v);
    if (id) {
      const hit: ResolveCandidate = {
        clientId: id,
        name: nameOf(id),
        matchedBy: 'tax_id',
        method: 'tax_id',
        confidence: 1,
        evidence: `NIT ${fullNit(v)}`,
      };
      return { client: hit, applies: true, candidates: [hit], ambiguous: false, conflict: false };
    }
  }

  // 2. El correo de un contacto registrado.
  const email = normalizeEmail(input.email);
  if (email) {
    const found = index.byEmail.get(email);
    if (found) {
      const hit: ResolveCandidate = {
        clientId: found.clientId,
        name: nameOf(found.clientId),
        matchedBy: 'email',
        method: 'contact_email',
        confidence: METHOD_CONFIDENCE.contact_email,
        evidence: email,
        witness: found.witness,
      };
      return { client: hit, applies: true, candidates: [hit], ambiguous: false, conflict: false };
    }
  }

  // 3. El dominio registrado. Un dominio público no identifica a nadie.
  const domain = input.domain ? normalizeDomain(input.domain) : domainOf(email);
  if (domain && !isPublicDomain(domain)) {
    const hit = index.byDomain.get(domain);
    if (hit) {
      const c: ResolveCandidate = {
        clientId: hit.clientId,
        name: nameOf(hit.clientId),
        matchedBy: 'domain',
        method: 'email_domain',
        confidence: METHOD_CONFIDENCE.email_domain,
        evidence: email ?? domain,
        witness: hit.witness,
      };
      return { client: c, applies: true, candidates: [c], ambiguous: false, conflict: false };
    }
  }

  const name = (input.name ?? '').trim();
  if (!name) return NONE;

  // Un cliente que ya tiene NIT distinto del que trae la entrada no es candidato
  // por nombre: la DIAN dice que son dos empresas.
  const contradicts = (id: string) => {
    if (variants.length === 0) return false;
    const own = index.clients.get(id)?.tax_id;
    return Boolean(own) && !variants.includes(own as string);
  };

  // 4. Un alias que una persona confirmó, tal cual (clave estricta).
  const strict = strictNameKey(name);
  const aliasHits = [...(index.byAlias.get(strict) ?? [])];
  const aliasOk = aliasHits.filter((id) => !contradicts(id));
  if (aliasOk.length === 1) {
    const id = aliasOk[0] as string;
    const hit: ResolveCandidate = {
      clientId: id,
      name: nameOf(id),
      matchedBy: 'name',
      method: 'alias',
      confidence: METHOD_CONFIDENCE.alias,
      evidence: name.slice(0, 200),
      witness: index.aliasWitness.get(strict) ?? null,
    };
    return { client: hit, applies: true, candidates: [hit], ambiguous: false, conflict: false };
  }

  // 5 y 6. El nombre suelto: propone, nunca aplica.
  const key = nameKey(name);
  if (key.length < 3) return NONE;
  const loose = [...new Set([...aliasHits, ...(index.byLooseName.get(key) ?? [])])];
  const ok = loose.filter((id) => !contradicts(id));
  if (ok.length === 0) {
    return { ...NONE, conflict: loose.length > 0 };
  }
  const candidates = ok.map(
    (id): ResolveCandidate => ({
      clientId: id,
      name: nameOf(id),
      matchedBy: 'name',
      method: 'name_exact',
      confidence: METHOD_CONFIDENCE.name_exact,
      evidence: name.slice(0, 200),
    }),
  );
  if (candidates.length > 1) {
    return { client: null, applies: false, candidates, ambiguous: true, conflict: false };
  }
  return {
    client: candidates[0] ?? null,
    applies: false,
    candidates,
    ambiguous: false,
    conflict: false,
  };
}
