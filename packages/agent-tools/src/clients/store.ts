import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  COMMITMENT_COLUMNS,
  type CommitmentRow,
  bogotaToday,
  deriveState,
} from '../commitments/shape';
import {
  CLIENT_COLUMNS,
  CONTACT_COLUMNS,
  type Candidate,
  type ClientRow,
  type ClientService,
  type ClientStatus,
  type ContactRow,
  type CustomsRole,
  DOMAIN_COLUMNS,
  type DomainRow,
  InvalidNitError,
  LINK_COLUMNS,
  type LinkEntityKind,
  type LinkMethod,
  type LinkRow,
  type LinkState,
  type MatchableClient,
  METHOD_CONFIDENCE,
  domainOf,
  isPublicDomain,
  matchByText,
  methodApplies,
  nameKey,
  normalizeDomain,
  normalizeEmail,
  normalizeNit,
  parseNit,
  strictNameKey,
} from './shape';

/**
 * Every read and write of a client, in one module.
 *
 * The tools, the web screens and anything else that grows on top all come
 * through here, which is what keeps the two rules that matter from having three
 * implementations:
 *
 *   1. A client is identified by its NIT, and a NIT that fails its own check
 *      digit never reaches the database.
 *   2. A link is APPLIED only when it repeats something a person stated. Every
 *      other signal proposes. `applyOrPropose` is the single function that
 *      decides, and it decides by asking `methodApplies`, which is a set of
 *      method names and not a confidence threshold — so widening the automatic
 *      path takes an edit somebody has to justify, not a nudged constant.
 *
 * `db` is always a workspace-scoped handle. Nothing here filters by
 * organization_id by hand, and nothing here should ever be handed a raw client.
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Names, not ids — a card that says "8f3c-…-a1 answers for this" says nothing. */
export async function hydrate(db: SupabaseClient, rows: ClientRow[]): Promise<ClientRow[]> {
  if (rows.length === 0) return rows;
  const userIds = [...new Set(rows.map((r) => r.owner_user_id).filter(Boolean))] as string[];
  if (userIds.length === 0) return rows;

  const { data } = await db.from('users').select('id, name, email').in('id', userIds);
  const byId = new Map(
    ((data ?? []) as Array<{ id: string; name: string | null; email: string }>).map((u) => [
      u.id,
      u.name?.trim() || u.email,
    ]),
  );
  return rows.map((r) => ({
    ...r,
    owner_name: r.owner_user_id ? (byId.get(r.owner_user_id) ?? null) : null,
  }));
}

export interface ListClientsOptions {
  statuses?: ClientStatus[];
  ownerUserId?: string;
  service?: ClientService;
  limit?: number;
}

export async function listClients(
  db: SupabaseClient,
  opts: ListClientsOptions = {},
): Promise<ClientRow[]> {
  let q = db.from('clients').select(CLIENT_COLUMNS);
  if (opts.statuses?.length) q = q.in('status', opts.statuses);
  if (opts.ownerUserId) q = q.eq('owner_user_id', opts.ownerUserId);
  if (opts.service) q = q.contains('services', [opts.service]);
  const { data, error } = await q
    .order('updated_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (error) throw error;
  return hydrate(db, (data ?? []) as ClientRow[]);
}

export async function getClient(db: SupabaseClient, id: string): Promise<ClientRow | null> {
  const { data, error } = await db
    .from('clients')
    .select(CLIENT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const [row] = await hydrate(db, [data as ClientRow]);
  return row ?? null;
}

export async function findClientByNit(
  db: SupabaseClient,
  nit: string,
): Promise<ClientRow | null> {
  const digits = normalizeNit(nit);
  if (!digits) return null;
  const { data, error } = await db
    .from('clients')
    .select(CLIENT_COLUMNS)
    .eq('tax_id', digits)
    .maybeSingle();
  if (error) throw error;
  return (data as ClientRow | null) ?? null;
}

/**
 * Find a client by the way somebody wrote its name.
 *
 * Two passes, and they are not the same question. The first asks the database
 * for the strict key — an index lookup, exact. The second folds the legal
 * suffix off and compares in memory, which is how "Coltrans" finds "Coltrans
 * S.A.S." without a LIKE scan and without the database and TypeScript needing
 * to agree on what a suffix is.
 */
export async function findClientByName(
  db: SupabaseClient,
  name: string,
): Promise<ClientRow | null> {
  const strict = strictNameKey(name);
  if (!strict) return null;

  const { data: exact } = await db
    .from('clients')
    .select(CLIENT_COLUMNS)
    .eq('name_key', strict)
    .limit(1);
  const hit = (exact ?? [])[0] as ClientRow | undefined;
  if (hit) return hit;

  const key = nameKey(name);
  const all = await listClients(db, { limit: 1000 });
  const loose = all.filter((c) => nameKey(c.name) === key || nameKey(c.legal_name ?? '') === key);
  // One match or none. Two clients whose names fold together is exactly the
  // situation where guessing is worst.
  return loose.length === 1 ? (loose[0] as ClientRow) : null;
}

export interface SearchHit {
  client: ClientRow;
  /** Why this row came back: what the query touched. */
  matchedOn: 'nit' | 'name' | 'legal_name' | 'domain' | 'contact';
}

/**
 * The search box, and `clients.search`.
 *
 * Deliberately searches more than the name. Somebody looking for Coltrans may
 * type the NIT off an invoice, the domain off an email signature or the name of
 * the person they always write to, and every one of those is a better handle
 * than the trade name for whoever is holding the document in front of them.
 */
export async function searchClients(
  db: SupabaseClient,
  query: string,
  limit = 10,
): Promise<SearchHit[]> {
  const raw = query.trim();
  if (!raw) return [];
  const hits = new Map<string, SearchHit>();
  const add = (client: ClientRow, matchedOn: SearchHit['matchedOn']) => {
    if (!hits.has(client.id)) hits.set(client.id, { client, matchedOn });
  };

  // 1. A NIT, if that is what this is.
  const digits = normalizeNit(raw);
  if (digits.length >= 6) {
    const byNit = await findClientByNit(db, digits);
    if (byNit) add(byNit, 'nit');
    // "830025281-7" typed whole: the trailing DV is not part of tax_id.
    if (!byNit && digits.length >= 7) {
      const withoutDv = await findClientByNit(db, digits.slice(0, -1));
      if (withoutDv) add(withoutDv, 'nit');
    }
  }

  // 2. A domain or an address.
  const domain = raw.includes('@') ? domainOf(raw) : normalizeDomain(raw);
  if (domain?.includes('.')) {
    const { data } = await db
      .from('client_domains')
      .select('client_id')
      .eq('domain', domain)
      .limit(1);
    const row = (data ?? [])[0] as { client_id: string } | undefined;
    if (row) {
      const client = await getClient(db, row.client_id);
      if (client) add(client, 'domain');
    }
  }
  const email = normalizeEmail(raw);
  if (email) {
    const { data } = await db
      .from('client_contacts')
      .select('client_id')
      .eq('email', email)
      .limit(1);
    const row = (data ?? [])[0] as { client_id: string } | undefined;
    if (row) {
      const client = await getClient(db, row.client_id);
      if (client) add(client, 'contact');
    }
  }

  // 3. The name — folded, in memory, over the workspace's own client list.
  //
  // NOT an `ilike '%coltrans%'`, and the reason is not performance. A LIKE
  // cannot see through an accent or a legal suffix, so "coltrans" would miss
  // "Coltráns S.A.S." — which is exactly the spelling somebody is searching
  // for when they type it plainly. Folding in memory uses the SAME `nameKey`
  // the matcher uses, so the search box and the automatic matcher can never
  // disagree about what counts as the same company; a workspace's client list
  // is hundreds of rows, not millions, and `clients_org_name_key_idx` is there
  // for the exact lookups that do go to the database.
  if (hits.size < limit) {
    const key = nameKey(raw);
    const typed = raw.toLowerCase();
    if (key.length >= 2) {
      for (const client of await listClients(db, { limit: 1000 })) {
        if (hits.size >= limit) break;
        const inName = nameKey(client.name).includes(key);
        const inLegal = nameKey(client.legal_name ?? '').includes(key);
        if (inName || inLegal || client.name.toLowerCase().includes(typed)) {
          add(client, inName || client.name.toLowerCase().includes(typed) ? 'name' : 'legal_name');
        }
      }
    }
  }

  const rows = [...hits.values()].slice(0, limit);
  const hydrated = await hydrate(
    db,
    rows.map((h) => h.client),
  );
  return rows.map((h, i) => ({ ...h, client: hydrated[i] ?? h.client }));
}

// ---------------------------------------------------------------------------
// Writing the client itself
// ---------------------------------------------------------------------------

export interface ClientInput {
  name: string;
  legalName?: string | null;
  /** As a person wrote it. Refused if the verification digit contradicts it. */
  nit?: string | null;
  status?: ClientStatus;
  city?: string | null;
  department?: string | null;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
  services?: ClientService[];
  customsRole?: CustomsRole | null;
  paymentTermsDays?: number | null;
  creditLimitCop?: number | null;
  ownerUserId?: string | null;
  since?: string | null;
  notes?: string | null;
}

function clientColumns(input: Partial<ClientInput>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.legalName !== undefined) patch.legal_name = input.legalName?.trim() || null;
  if (input.nit !== undefined) patch.tax_id = input.nit ? parseNit(input.nit).digits : null;
  if (input.status !== undefined) patch.status = input.status;
  if (input.city !== undefined) patch.city = input.city?.trim() || null;
  if (input.department !== undefined) patch.department = input.department?.trim() || null;
  if (input.address !== undefined) patch.address = input.address?.trim() || null;
  if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;
  if (input.website !== undefined) patch.website = input.website?.trim() || null;
  if (input.services !== undefined) patch.services = input.services;
  if (input.customsRole !== undefined) patch.customs_role = input.customsRole ?? null;
  if (input.paymentTermsDays !== undefined) patch.payment_terms_days = input.paymentTermsDays;
  if (input.creditLimitCop !== undefined) patch.credit_limit_cop = input.creditLimitCop;
  if (input.ownerUserId !== undefined) patch.owner_user_id = input.ownerUserId;
  if (input.since !== undefined) patch.since = input.since || null;
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
  return patch;
}

export interface RegisterResult {
  client: ClientRow;
  created: boolean;
  /**
   * Clients whose names fold to the same key. Not an error — two legal entities
   * can share a trade name — but the one thing worth saying out loud before a
   * second Coltrans exists, because after that the card is split in half and
   * neither half looks wrong.
   */
  nearDuplicates: ClientRow[];
}

/**
 * Register a client, or update the one that is already there.
 *
 * Idempotent by identity rather than by id: registering the same NIT twice
 * updates, because "registra a Coltrans" is a sentence people repeat and the
 * second attempt must not produce a twin. The NIT wins over the name when both
 * are supplied and they disagree — the NIT is the identity, and a company that
 * changed its trade name is still the same company.
 */
export async function registerClient(
  db: SupabaseClient,
  input: ClientInput & { createdBy: string },
): Promise<RegisterResult> {
  const name = input.name?.trim();
  if (!name || name.length < 2) throw new ValidationError('El cliente necesita un nombre.');

  // Throws InvalidNitError with a sentence when the check digit disagrees.
  const nit = input.nit ? parseNit(input.nit) : null;

  const existing =
    (nit ? await findClientByNit(db, nit.digits) : null) ?? (await findClientByName(db, name));

  const patch = clientColumns(input);
  if (existing) {
    // Never blank a field by omission. A partial update is the normal way
    // somebody adds a phone number six months later.
    const { data, error } = await db
      .from('clients')
      .update(patch)
      .eq('id', existing.id)
      .select(CLIENT_COLUMNS)
      .single();
    if (error) throw error;
    const [row] = await hydrate(db, [data as ClientRow]);
    return { client: row ?? (data as ClientRow), created: false, nearDuplicates: [] };
  }

  const { data, error } = await db
    .from('clients')
    .insert({ ...patch, created_by: input.createdBy })
    .select(CLIENT_COLUMNS)
    .single();
  if (error) throw error;
  const [row] = await hydrate(db, [data as ClientRow]);
  const client = row ?? (data as ClientRow);

  const key = nameKey(name);
  const nearDuplicates = (await listClients(db, { limit: 1000 })).filter(
    (c) => c.id !== client.id && nameKey(c.name) === key,
  );
  return { client, created: true, nearDuplicates };
}

export async function updateClient(
  db: SupabaseClient,
  id: string,
  input: Partial<ClientInput>,
): Promise<ClientRow> {
  const patch = clientColumns(input);
  if (Object.keys(patch).length === 0) {
    const current = await getClient(db, id);
    if (!current) throw new NotFoundError('Ese cliente ya no existe.');
    return current;
  }
  const { data, error } = await db
    .from('clients')
    .update(patch)
    .eq('id', id)
    .select(CLIENT_COLUMNS)
    .single();
  if (error) throw error;
  const [row] = await hydrate(db, [data as ClientRow]);
  return row ?? (data as ClientRow);
}

// ---------------------------------------------------------------------------
// Domains: the statement everything automatic rests on
// ---------------------------------------------------------------------------

export async function listDomains(
  db: SupabaseClient,
  clientId?: string,
): Promise<DomainRow[]> {
  let q = db.from('client_domains').select(DOMAIN_COLUMNS);
  if (clientId) q = q.eq('client_id', clientId);
  const { data, error } = await q.order('domain', { ascending: true }).limit(500);
  if (error) throw error;
  return (data ?? []) as DomainRow[];
}

/**
 * Record that a domain belongs to a client.
 *
 * This is the single most consequential write in the module: every future
 * email from that domain will be attached to this client automatically, with no
 * further review. So it refuses two things outright rather than warning about
 * them — a public provider, which would sweep up every personal address the
 * company writes to, and a domain already registered to somebody else, which
 * would make the "one thing, one client" guarantee resolvable two ways.
 */
export async function addDomain(
  db: SupabaseClient,
  input: { clientId: string; domain: string; userId: string; note?: string | null },
): Promise<DomainRow> {
  const domain = normalizeDomain(input.domain);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new ValidationError(`"${input.domain}" no es un dominio. Escribe algo como coltrans.com.`);
  }
  if (isPublicDomain(domain)) {
    throw new ValidationError(
      `${domain} es un correo público, no el dominio de una empresa. Si lo registras, todo lo que llegue de una cuenta personal quedaría atribuido a este cliente. Registra el dominio propio del cliente, o agrega la dirección exacta como contacto.`,
    );
  }

  const { data: taken } = await db
    .from('client_domains')
    .select('client_id')
    .eq('domain', domain)
    .maybeSingle();
  const owner = taken as { client_id: string } | null;
  if (owner && owner.client_id !== input.clientId) {
    const other = await getClient(db, owner.client_id);
    throw new ValidationError(
      `${domain} ya está registrado a nombre de ${other?.name ?? 'otro cliente'}. Un dominio solo puede ser de un cliente: si está mal, quítalo de allá primero.`,
    );
  }
  if (owner) return (await listDomains(db, input.clientId)).find((d) => d.domain === domain) as DomainRow;

  const { data, error } = await db
    .from('client_domains')
    .insert({
      client_id: input.clientId,
      domain,
      verified_by: input.userId,
      note: input.note?.trim() || null,
    })
    .select(DOMAIN_COLUMNS)
    .single();
  if (error) throw error;
  return data as DomainRow;
}

export async function removeDomain(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from('client_domains').delete().eq('id', id);
  if (error) throw error;
}

export interface EmailOwner {
  clientId: string;
  method: Extract<LinkMethod, 'email_domain' | 'contact_email'>;
  evidence: string;
  /** The person whose statement this is. Carried onto any link it produces. */
  witnessUserId: string | null;
}

/**
 * Whose is this address?
 *
 * The contact is checked before the domain, and the order matters: a registered
 * contact is a statement about ONE person and a domain is a statement about a
 * whole company, so when both apply the narrower one is the better citation.
 *
 * Returns null for anything unregistered, including a domain that merely
 * resembles a client's name. There is no fallback and there should not be: the
 * whole reason this function may be trusted to apply a link without review is
 * that it never concludes anything nobody said.
 */
export async function clientForEmail(
  db: SupabaseClient,
  email: string,
): Promise<EmailOwner | null> {
  const address = normalizeEmail(email);
  if (!address) return null;

  const { data: contact } = await db
    .from('client_contacts')
    .select('client_id, created_by')
    .eq('email', address)
    .maybeSingle();
  const found = contact as { client_id: string; created_by: string | null } | null;
  if (found) {
    return {
      clientId: found.client_id,
      method: 'contact_email',
      evidence: address,
      witnessUserId: found.created_by,
    };
  }

  const domain = domainOf(address);
  if (!domain || isPublicDomain(domain)) return null;
  const { data: registered } = await db
    .from('client_domains')
    .select('client_id, domain, verified_by')
    .eq('domain', domain)
    .maybeSingle();
  const row = registered as { client_id: string; domain: string; verified_by: string } | null;
  if (!row) return null;
  return {
    clientId: row.client_id,
    method: 'email_domain',
    evidence: `${address} · @${row.domain}`,
    witnessUserId: row.verified_by,
  };
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export async function listContacts(
  db: SupabaseClient,
  clientId: string,
): Promise<ContactRow[]> {
  const { data, error } = await db
    .from('client_contacts')
    .select(CONTACT_COLUMNS)
    .eq('client_id', clientId)
    .order('is_primary', { ascending: false })
    .order('full_name', { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as ContactRow[];
}

export interface ContactInput {
  clientId: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  roleTitle?: string | null;
  isPrimary?: boolean;
  status?: 'active' | 'left' | 'unknown';
  source?: ContactRow['source'];
  sourceDetail?: string | null;
  notes?: string | null;
  createdBy: string;
  seenAt?: string | null;
}

/**
 * Add or update a person at the client, keyed on their address.
 *
 * The address is the identity, so seeing the same one twice updates rather than
 * duplicating — which is what makes it safe for an automatic path (a new
 * address in a thread) and a manual one (somebody filling in the card) to write
 * through the same function.
 */
export async function upsertContact(
  db: SupabaseClient,
  input: ContactInput,
): Promise<ContactRow> {
  const email = normalizeEmail(input.email);
  const name = input.fullName?.trim();
  if (!name || name.length < 2) throw new ValidationError('El contacto necesita un nombre.');

  const existing = email
    ? ((
        await db.from('client_contacts').select(CONTACT_COLUMNS).eq('email', email).maybeSingle()
      ).data as ContactRow | null)
    : null;

  const now = input.seenAt ?? new Date().toISOString();
  const patch: Record<string, unknown> = {
    client_id: input.clientId,
    full_name: name,
    email,
    last_seen_at: now,
  };
  if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;
  if (input.roleTitle !== undefined) patch.role_title = input.roleTitle?.trim() || null;
  if (input.isPrimary !== undefined) patch.is_primary = input.isPrimary;
  if (input.status !== undefined) patch.status = input.status;
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;

  if (existing) {
    // The source stays as it was first recorded. A contact Cortex noticed in a
    // thread does not become "typed by a person" because somebody later added a
    // phone number to it.
    const { data, error } = await db
      .from('client_contacts')
      .update(patch)
      .eq('id', existing.id)
      .select(CONTACT_COLUMNS)
      .single();
    if (error) throw error;
    return data as ContactRow;
  }

  // At most one primary per client, enforced by an index. Demote the incumbent
  // rather than letting the insert fail on it.
  if (input.isPrimary) await demotePrimary(db, input.clientId);

  const { data, error } = await db
    .from('client_contacts')
    .insert({
      ...patch,
      source: input.source ?? 'manual',
      source_detail: input.sourceDetail?.slice(0, 300) ?? null,
      first_seen_at: now,
      created_by: input.createdBy,
    })
    .select(CONTACT_COLUMNS)
    .single();
  if (error) throw error;
  return data as ContactRow;
}

async function demotePrimary(db: SupabaseClient, clientId: string): Promise<void> {
  await db
    .from('client_contacts')
    .update({ is_primary: false })
    .eq('client_id', clientId)
    .eq('is_primary', true);
}

// ---------------------------------------------------------------------------
// Links: applied, or proposed
// ---------------------------------------------------------------------------

export interface LinkTarget {
  kind: LinkEntityKind;
  /** For things that are rows in this database. */
  id?: string | null;
  /** For things that live in another system — a Gmail thread id. */
  ref?: string | null;
  /** What it is called. Denormalised so the card renders without the source. */
  label?: string | null;
  occurredAt?: string | null;
}

export interface LinkInput extends LinkTarget {
  clientId: string;
  method: LinkMethod;
  evidence?: string | null;
  /**
   * Who stands behind this link. Required for anything that will be applied —
   * a manual link's clicker, or the person who registered the domain that
   * matched. `applyOrPropose` refuses to apply without one rather than writing
   * a confirmed row with a null witness, which the database would reject
   * anyway; the point of checking here is that the refusal is a sentence.
   */
  witnessUserId?: string | null;
  createdBy?: string | null;
}

export interface LinkOutcome {
  link: LinkRow | null;
  /** What actually happened, in the words the screen uses. */
  outcome: 'applied' | 'proposed' | 'already_linked' | 'taken_by_another_client';
  /** Set when the entity is already confirmed to somebody else. */
  heldBy?: ClientRow | null;
}

/**
 * THE ONE PLACE THAT DECIDES WHETHER A LINK IS APPLIED.
 *
 * Every caller — the email matcher, the manual button, a future extraction —
 * comes through here, and here the question is asked in exactly one way:
 * `methodApplies(method)`. Not a confidence, not a flag the caller passes. A
 * caller cannot elect to apply a name match, because there is no argument that
 * would let it.
 *
 * Four outcomes, all of them safe:
 *
 *   already_linked            the entity is confirmed to THIS client. Nothing
 *                             to do, and saying so is better than a no-op.
 *   taken_by_another_client   it is confirmed elsewhere. Nothing is written —
 *                             not even a proposal, because a proposal to move
 *                             something that a person already decided is noise,
 *                             and unpicking it is a deliberate act (`unlink`).
 *   applied                   the method repeats a human statement.
 *   proposed                  everything else. Waits in the review list.
 */
export async function applyOrPropose(
  db: SupabaseClient,
  input: LinkInput,
): Promise<LinkOutcome> {
  const key = input.id ?? input.ref;
  if (!key) throw new ValidationError('No se puede vincular algo sin identificarlo.');
  if (input.kind === 'email_thread' && !input.ref) {
    throw new ValidationError('Un correo se identifica por el id del hilo, no por un uuid.');
  }
  if (input.kind !== 'email_thread' && !input.id) {
    throw new ValidationError(`Un ${input.kind} se identifica por su id interno.`);
  }

  // Is this thing already settled? One query, before anything is written.
  //
  // Filtered on the concrete column rather than on the generated `entity_key`:
  // the key exists so ONE unique index can cover both kinds of entity, and a
  // query is clearer — and portable to anything that is not Postgres, like the
  // fake this module is tested against — when it names the column the caller
  // actually supplied.
  const identityColumn = input.id ? 'entity_id' : 'entity_ref';

  const { data: settled } = await db
    .from('client_links')
    .select(LINK_COLUMNS)
    .eq('entity_kind', input.kind)
    .eq(identityColumn, key)
    .eq('state', 'confirmed')
    .maybeSingle();
  const confirmed = settled as LinkRow | null;
  if (confirmed) {
    if (confirmed.client_id === input.clientId) {
      return { link: confirmed, outcome: 'already_linked' };
    }
    return {
      link: null,
      outcome: 'taken_by_another_client',
      heldBy: await getClient(db, confirmed.client_id),
    };
  }

  // The same proposal, by the same route, twice. A sweep that runs every hour
  // must not fill the review list with copies of one suggestion. The unique
  // index is still the guarantee — this only makes the common case a read
  // rather than a caught error.
  const { data: repeat } = await db
    .from('client_links')
    .select(LINK_COLUMNS)
    .eq('entity_kind', input.kind)
    .eq(identityColumn, key)
    .eq('client_id', input.clientId)
    .eq('method', input.method)
    .maybeSingle();
  const priorSameRoute = repeat as LinkRow | null;
  if (priorSameRoute) {
    return {
      link: priorSameRoute,
      outcome: priorSameRoute.state === 'confirmed' ? 'already_linked' : 'proposed',
    };
  }

  const applies = methodApplies(input.method) || input.method === 'manual';
  const witness = input.witnessUserId ?? null;
  if (applies && !witness) {
    throw new ValidationError(
      'Un vínculo aplicado tiene que quedar a nombre de alguien. Sin esa persona solo puede quedar como propuesta.',
    );
  }

  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    client_id: input.clientId,
    entity_kind: input.kind,
    entity_id: input.id ?? null,
    entity_ref: input.ref ?? null,
    label: input.label?.slice(0, 300) ?? null,
    occurred_at: input.occurredAt ?? null,
    state: applies ? 'confirmed' : 'suggested',
    method: input.method,
    evidence: input.evidence?.slice(0, 600) ?? null,
    confidence: METHOD_CONFIDENCE[input.method] ?? null,
    confirmed_by: applies ? witness : null,
    confirmed_at: applies ? now : null,
    created_by: input.createdBy ?? witness,
  };

  const { data, error } = await db
    .from('client_links')
    .insert(row)
    .select(LINK_COLUMNS)
    .single();

  if (error) {
    // The same proposal by the same route already exists. Idempotent by index,
    // so a re-run of a sweep costs nothing and changes nothing.
    if (isUniqueViolation(error)) {
      const { data: prior } = await db
        .from('client_links')
        .select(LINK_COLUMNS)
        .eq('entity_kind', input.kind)
        .eq(identityColumn, key)
        .eq('client_id', input.clientId)
        .eq('method', input.method)
        .maybeSingle();
      const existing = prior as LinkRow | null;
      return {
        link: existing,
        outcome: existing?.state === 'confirmed' ? 'already_linked' : 'proposed',
      };
    }
    throw error;
  }

  return { link: data as LinkRow, outcome: applies ? 'applied' : 'proposed' };
}

/** A person accepts a proposal. The only path from suggested to confirmed. */
export async function confirmLink(
  db: SupabaseClient,
  input: { id: string; userId: string },
): Promise<LinkRow> {
  const { data: current } = await db
    .from('client_links')
    .select(LINK_COLUMNS)
    .eq('id', input.id)
    .maybeSingle();
  const link = current as LinkRow | null;
  if (!link) throw new NotFoundError('Ese vínculo ya no existe.');
  if (link.state === 'confirmed') return link;

  const now = new Date().toISOString();
  const { data, error } = await db
    .from('client_links')
    .update({ state: 'confirmed', confirmed_by: input.userId, confirmed_at: now })
    .eq('id', input.id)
    .select(LINK_COLUMNS)
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new ValidationError(
        'Eso ya quedó vinculado a otro cliente. Quítalo de allá primero: una misma cosa no puede ser de dos clientes.',
      );
    }
    throw error;
  }
  return data as LinkRow;
}

export async function rejectLink(
  db: SupabaseClient,
  input: { id: string; userId: string; reason?: string | null },
): Promise<LinkRow> {
  const { data, error } = await db
    .from('client_links')
    .update({
      state: 'rejected',
      rejected_by: input.userId,
      rejected_at: new Date().toISOString(),
      rejected_reason: input.reason?.trim().slice(0, 300) || null,
    })
    .eq('id', input.id)
    .select(LINK_COLUMNS)
    .single();
  if (error) throw error;
  return data as LinkRow;
}

export interface ListLinksOptions {
  clientId?: string;
  state?: LinkState;
  kinds?: LinkEntityKind[];
  limit?: number;
}

export async function listLinks(
  db: SupabaseClient,
  opts: ListLinksOptions = {},
): Promise<LinkRow[]> {
  let q = db.from('client_links').select(LINK_COLUMNS);
  if (opts.clientId) q = q.eq('client_id', opts.clientId);
  if (opts.state) q = q.eq('state', opts.state);
  if (opts.kinds?.length) q = q.in('entity_kind', opts.kinds);
  const { data, error } = await q
    .order('occurred_at', { ascending: false, nullsFirst: false })
    .limit(opts.limit ?? 200);
  if (error) throw error;
  return (data ?? []) as LinkRow[];
}

/** Proposals waiting on a person, newest first, with the client's name on them. */
export async function listProposals(db: SupabaseClient, limit = 100): Promise<LinkRow[]> {
  const { data, error } = await db
    .from('client_links')
    .select(LINK_COLUMNS)
    .eq('state', 'suggested')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as LinkRow[];
  if (rows.length === 0) return rows;

  const ids = [...new Set(rows.map((r) => r.client_id))];
  const { data: clients } = await db.from('clients').select('id, name').in('id', ids);
  const byId = new Map(
    ((clients ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  );
  return rows.map((r) => ({ ...r, client_name: byId.get(r.client_id) ?? null }));
}

// ---------------------------------------------------------------------------
// Attaching what already exists
// ---------------------------------------------------------------------------

export interface CounterpartyBacklog {
  counterparty: string;
  count: number;
  /** The candidates, if any. Shown so a person can pick rather than retype. */
  candidates: Candidate[];
}

/**
 * The free-text counterparties that no client answers for yet.
 *
 * This is the honest half of the migration story. `commitments.counterparty`
 * was free text for a reason — most counterparties are not clients — so the
 * screen's job is not to convert them all, it is to show what is UNCLAIMED and
 * let somebody claim the ones that should be.
 */
export async function unlinkedCounterparties(
  db: SupabaseClient,
  limit = 50,
): Promise<CounterpartyBacklog[]> {
  const { data, error } = await db
    .from('commitments')
    .select('counterparty')
    .is('client_id', null)
    .not('counterparty', 'is', null)
    .limit(2000);
  if (error) throw error;

  const counts = new Map<string, { label: string; count: number }>();
  for (const row of (data ?? []) as Array<{ counterparty: string | null }>) {
    const label = row.counterparty?.trim();
    if (!label) continue;
    const key = nameKey(label);
    if (!key) continue;
    const entry = counts.get(key) ?? { label, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  if (counts.size === 0) return [];

  const clients = await listClients(db, { limit: 1000 });
  const matchable: MatchableClient[] = clients.map((c) => ({
    id: c.id,
    name: c.name,
    legal_name: c.legal_name,
    tax_id: c.tax_id,
  }));

  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((entry) => ({
      counterparty: entry.label,
      count: entry.count,
      candidates: matchByText(entry.label, matchable).candidates,
    }));
}

export interface CounterpartyMatchResult {
  matched: number;
  ambiguous: number;
  unmatched: number;
}

/**
 * Attach the deadlines that already exist to the clients that already exist.
 *
 * The same job migration 0075 § 8 does once, done again whenever it can pay
 * off — chiefly the moment a client is registered, so "registra a Coltrans"
 * immediately adopts the four deadlines whose counterparty says Coltrans and
 * reports how many. Restricting it to one client (`onlyClientId`) is what makes
 * that possible without re-scanning the workspace.
 *
 * AMBIGUITY WRITES NOTHING. `matchByText` returns `only = null` whenever more
 * than one client matched equally well, and this function writes only `only`.
 * The ambiguous rows are counted and returned so the caller can say how many
 * were left alone, which is the sentence that makes the number trustworthy.
 */
export async function matchCommitmentsToClients(
  db: SupabaseClient,
  opts: { onlyClientId?: string; limit?: number } = {},
): Promise<CounterpartyMatchResult> {
  const clients = await listClients(db, { limit: 1000 });
  const pool = (opts.onlyClientId ? clients.filter((c) => c.id === opts.onlyClientId) : clients).map(
    (c): MatchableClient => ({
      id: c.id,
      name: c.name,
      legal_name: c.legal_name,
      tax_id: c.tax_id,
    }),
  );
  if (pool.length === 0) return { matched: 0, ambiguous: 0, unmatched: 0 };

  const { data, error } = await db
    .from('commitments')
    .select('id, counterparty')
    .is('client_id', null)
    .not('counterparty', 'is', null)
    .limit(opts.limit ?? 2000);
  if (error) throw error;

  let matched = 0;
  let ambiguous = 0;
  let unmatched = 0;
  for (const row of (data ?? []) as Array<{ id: string; counterparty: string | null }>) {
    // The full pool decides, even when only one client is being adopted: a
    // counterparty that matches two clients is ambiguous no matter which of
    // them prompted the run.
    const all = matchByText(row.counterparty, clients);
    const wanted = opts.onlyClientId
      ? all.only?.clientId === opts.onlyClientId
        ? all.only
        : null
      : all.only;
    if (!wanted) {
      if (all.ambiguous) ambiguous += 1;
      else unmatched += 1;
      continue;
    }
    const { error: updateError } = await db
      .from('commitments')
      .update({ client_id: wanted.clientId })
      .eq('id', row.id)
      .is('client_id', null);
    if (updateError) throw updateError;
    matched += 1;
  }
  return { matched, ambiguous, unmatched };
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface OverviewCommitment {
  id: string;
  title: string;
  kind: string;
  dueOn: string;
  state: string;
  amountCop: number | null;
  counterparty: string | null;
}

export interface ClientOverview {
  client: ClientRow;
  contacts: ContactRow[];
  domains: DomainRow[];
  /** Applied links, newest first. */
  links: LinkRow[];
  /** Waiting on somebody. */
  proposals: LinkRow[];
  commitments: OverviewCommitment[];
  counts: {
    documents: number;
    meetings: number;
    whatsappGroups: number;
    emailThreads: number;
    vehicles: number;
    openCommitments: number;
    overdueCommitments: number;
  };
}

/**
 * Everything Cortex knows about one client, in one round of queries.
 *
 * Nothing here is new memory. Every row was already stored — the difference is
 * that it is now reachable from the client instead of only from its own module,
 * which is the entire point of the migration.
 */
export async function clientOverview(
  db: SupabaseClient,
  clientId: string,
  today = bogotaToday(),
): Promise<ClientOverview> {
  const client = await getClient(db, clientId);
  if (!client) throw new NotFoundError('Ese cliente ya no existe.');

  const [contacts, domains, links, proposals, commitmentRows] = await Promise.all([
    listContacts(db, clientId),
    listDomains(db, clientId),
    listLinks(db, { clientId, state: 'confirmed', limit: 300 }),
    listLinks(db, { clientId, state: 'suggested', limit: 100 }),
    db
      .from('commitments')
      .select(COMMITMENT_COLUMNS)
      .eq('client_id', clientId)
      .eq('review_state', 'confirmed')
      .order('due_on', { ascending: true })
      .limit(200)
      .then(({ data, error }) => {
        if (error) throw error;
        return (data ?? []) as CommitmentRow[];
      }),
  ]);

  const commitments = commitmentRows.map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    dueOn: row.due_on,
    // Derived from the date rather than read off the cached column, exactly as
    // the commitments screen does — a card must never be a day stale.
    state: deriveState(row, today),
    amountCop: row.amount_cop,
    counterparty: row.counterparty,
  }));

  const countOf = (kind: LinkEntityKind) => links.filter((l) => l.entity_kind === kind).length;

  return {
    client,
    contacts,
    domains,
    links,
    proposals,
    commitments,
    counts: {
      documents: countOf('document'),
      meetings: countOf('meeting'),
      whatsappGroups: countOf('whatsapp_group'),
      emailThreads: countOf('email_thread'),
      vehicles: countOf('vehicle'),
      openCommitments: commitments.filter((c) => c.state !== 'met' && c.state !== 'dropped').length,
      overdueCommitments: commitments.filter((c) => c.state === 'overdue').length,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/**
 * PostgREST reports a unique-index collision as 23505. Two of this module's
 * guarantees — one confirmed link per thing, one proposal per route — are
 * enforced by indexes, so recognising this code is how "somebody got there
 * first" is told apart from "something is broken".
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  return e.code === '23505' || /duplicate key value/i.test(e.message ?? '');
}

export { InvalidNitError };
