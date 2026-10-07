import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type ClientIndex,
  type IdentityAlias,
  type IdentityClient,
  type IdentityContact,
  type IdentityDomain,
  type ResolveCandidate,
  type ResolveInput,
  type ResolveResult,
  buildClientIndex,
  nitVariants,
  resolveAgainst,
} from './identity';
import {
  type Candidate,
  type LinkEntityKind,
  type LinkMethod,
  METHOD_CONFIDENCE,
  type MatchableClient,
  matchByText,
  nameKey,
} from './shape';
import { isUniqueViolation, matchCommitmentsToClients } from './store';

/**
 * EL BARRIDO: colgar de cada cliente lo que Cortex ya tenía guardado.
 *
 * Un solo punto de entrada, `linkClientRecords`, que corre el trabajo diario
 * (clients/link-workspace), el botón «Buscar vínculos ahora» de /clients y el
 * final de cada sincronización contable. Es IDEMPOTENTE: sólo escribe una
 * columna `client_id` que está vacía y sólo propone lo que nadie propuso por
 * esa misma ruta, así que correrlo dos veces cambia nada la segunda.
 *
 * Y es CONSERVADOR, en el sentido de 0075:
 *
 *   - Aplica SOLO lo que repite una afirmación: el NIT del campo
 *     estructurado de una factura, un pago o un movimiento; el correo de un
 *     contacto registrado; un dominio registrado; un alias que una persona
 *     confirmó. Eso llena la columna `client_id` de la tabla dueña (o un
 *     vínculo `confirmed` con su testigo, para lo que no tiene columna).
 *   - TODO lo demás PROPONE: queda en `client_links` como `suggested`, en la
 *     pestaña «Por confirmar», y no cuenta en ninguna cifra.
 *   - Un nombre que calza con dos clientes propone a los dos, que compiten;
 *     nunca se escoge uno, y nunca se unen dos clientes solos.
 *
 * Cada sección corre aparte: si una tabla no se puede leer, el resto sigue y
 * el informe dice cuál falló.
 */

// ---------------------------------------------------------------------------
// El índice, leído de la base
// ---------------------------------------------------------------------------

/** Todo lo que identifica a los clientes del espacio, en una ida a la base. */
export async function loadClientIndex(db: SupabaseClient): Promise<ClientIndex> {
  const [clients, aliases, domains, contacts] = await Promise.all([
    db.from('clients').select('id, name, legal_name, tax_id').limit(5000),
    db.from('client_aliases').select('client_id, alias, verified_by').limit(10000),
    db.from('client_domains').select('client_id, domain, verified_by').limit(5000),
    db
      .from('client_contacts')
      .select('client_id, email, created_by')
      .not('email', 'is', null)
      .limit(10000),
  ]);
  if (clients.error) throw clients.error;
  if (domains.error) throw domains.error;
  if (contacts.error) throw contacts.error;
  return buildClientIndex({
    clients: (clients.data ?? []) as IdentityClient[],
    // Sin 0179 aplicada no hay alias: se sigue sin ellos en vez de caerse.
    aliases: aliases.error ? [] : ((aliases.data ?? []) as IdentityAlias[]),
    domains: (domains.data ?? []) as IdentityDomain[],
    contacts: (contacts.data ?? []) as IdentityContact[],
  });
}

/**
 * A qué cliente apunta una contraparte: el resolvedor que usan las rutas de
 * ingesta. Pasa `index` cuando vas a resolver muchas filas seguidas.
 */
export async function resolveClient(
  db: SupabaseClient,
  input: ResolveInput,
  index?: ClientIndex,
): Promise<ResolveResult> {
  return resolveAgainst(index ?? (await loadClientIndex(db)), input);
}

// ---------------------------------------------------------------------------
// Las tablas que tienen su propia columna client_id
// ---------------------------------------------------------------------------

/**
 * Para estas clases de cosa, el vínculo de verdad es la columna `client_id`
 * de la tabla dueña: es lo que leen la cartera, los pagos y el libro. Un
 * vínculo confirmado en `client_links` también la llena.
 */
export const OWNER_COLUMN: Partial<
  Record<LinkEntityKind, { table: string; extra?: Record<string, unknown> }>
> = {
  invoice: { table: 'accounting_invoices' },
  // Las dos tablas de 0076/0098 exigen `client_match_state = 'matched'` cuando
  // hay cliente. Una persona confirmando es la coincidencia más fuerte que hay.
  extraction: { table: 'document_extractions', extra: { client_match_state: 'matched' } },
  payment: { table: 'payments', extra: { client_match_state: 'matched' } },
  ledger_movement: { table: 'ledger_movements', extra: { client_matched_by: 'person' } },
  commitment: { table: 'commitments' },
  action: { table: 'actions' },
};

/**
 * Llena la columna del dueño, sólo si está vacía. Nunca le quita una fila a
 * otro cliente: si ya tenía uno, se deja y se devuelve false.
 */
export async function writeOwnerColumn(
  db: SupabaseClient,
  kind: LinkEntityKind,
  entityId: string,
  clientId: string,
  extra?: Record<string, unknown>,
): Promise<boolean> {
  const owner = OWNER_COLUMN[kind];
  if (!owner) return false;
  const { data, error } = await db
    .from(owner.table)
    .update({ client_id: clientId, ...(owner.extra ?? {}), ...(extra ?? {}) })
    .eq('id', entityId)
    .is('client_id', null)
    .select('id');
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

// ---------------------------------------------------------------------------
// El informe
// ---------------------------------------------------------------------------

export interface LinkRunReport {
  /** Clientes creados desde el programa contable porque faltaban. */
  created: number;
  /** Filas vinculadas solas, por clase de cosa. */
  applied: Partial<Record<LinkEntityKind | 'email', number>>;
  /** Propuestas nuevas que quedaron «por confirmar». */
  proposed: number;
  /** Cosas que calzaban con más de un cliente: se propusieron todos. */
  ambiguous: number;
  /** El NIT de la fila contradice al del cliente que el nombre señalaba. */
  conflicts: number;
  /** Secciones que no se pudieron leer (la tabla no está, un error). */
  failed: string[];
}

export interface LinkRunOptions {
  /** Quién corre el barrido. Queda como autor de los clientes creados. */
  userId?: string | null;
  /** Crear clientes desde el programa contable cuando faltan. Por defecto, sí. */
  autoCreate?: boolean;
  /** Tope de propuestas nuevas por corrida, para no inundar la revisión. */
  proposalCap?: number;
}

const SCAN = 2000;

interface Ctx {
  db: SupabaseClient;
  index: ClientIndex;
  matchable: MatchableClient[];
  report: LinkRunReport;
  /** `kind\0entity_id\0client_id\0method` ya existentes en client_links. */
  known: Set<string>;
  /** `kind\0entity_id` ya confirmados a alguien. */
  settled: Set<string>;
  pending: Array<Record<string, unknown>>;
  cap: number;
  userId: string | null;
}

function bump(report: LinkRunReport, kind: LinkEntityKind | 'email') {
  report.applied[kind] = (report.applied[kind] ?? 0) + 1;
}

/** Deja una propuesta en la cola si nadie la hizo por esta misma ruta. */
function propose(
  ctx: Ctx,
  kind: LinkEntityKind,
  entityId: string,
  candidate: Pick<Candidate, 'clientId' | 'method' | 'evidence'>,
  label: string | null,
  occurredAt: string | null,
) {
  if (ctx.settled.has(`${kind}\u0000${entityId}`)) return;
  const key = `${kind}\u0000${entityId}\u0000${candidate.clientId}\u0000${candidate.method}`;
  if (ctx.known.has(key)) return;
  if (ctx.report.proposed >= ctx.cap) return;
  ctx.known.add(key);
  ctx.report.proposed += 1;
  ctx.pending.push({
    client_id: candidate.clientId,
    entity_kind: kind,
    entity_id: entityId,
    entity_ref: null,
    label: label?.slice(0, 300) ?? null,
    occurred_at: occurredAt,
    state: 'suggested',
    method: candidate.method,
    evidence: candidate.evidence?.slice(0, 600) ?? null,
    confidence: METHOD_CONFIDENCE[candidate.method] ?? null,
    created_by: ctx.userId,
  });
}

/** Un vínculo aplicado en client_links (para lo que no tiene columna propia). */
async function applyLink(
  ctx: Ctx,
  kind: LinkEntityKind,
  entityId: string,
  hit: ResolveCandidate,
  label: string | null,
  occurredAt: string | null,
): Promise<boolean> {
  if (ctx.settled.has(`${kind}\u0000${entityId}`)) return false;
  // Sin testigo no hay vínculo aplicado (0075): queda como propuesta.
  if (!hit.witness) {
    propose(ctx, kind, entityId, hit, label, occurredAt);
    return false;
  }
  const now = new Date().toISOString();
  const { error } = await ctx.db.from('client_links').insert({
    client_id: hit.clientId,
    entity_kind: kind,
    entity_id: entityId,
    entity_ref: null,
    label: label?.slice(0, 300) ?? null,
    occurred_at: occurredAt,
    state: 'confirmed',
    method: hit.method,
    evidence: hit.evidence.slice(0, 600),
    confidence: METHOD_CONFIDENCE[hit.method] ?? null,
    confirmed_by: hit.witness,
    confirmed_at: now,
    created_by: hit.witness,
  });
  if (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
  ctx.settled.add(`${kind}\u0000${entityId}`);
  bump(ctx.report, kind);
  return true;
}

/** Las propuestas encoladas, en tandas; una tanda que choca se reintenta fila a fila. */
async function flush(ctx: Ctx) {
  const rows = ctx.pending.splice(0);
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { error } = await ctx.db.from('client_links').insert(batch);
    if (!error) continue;
    if (!isUniqueViolation(error)) throw error;
    for (const row of batch) {
      const one = await ctx.db.from('client_links').insert(row);
      if (one.error && !isUniqueViolation(one.error)) throw one.error;
      if (one.error) ctx.report.proposed -= 1;
    }
  }
}

/** Lo que ya existe en client_links, para no repetir propuestas ni pisar decisiones. */
async function loadKnownLinks(db: SupabaseClient) {
  const { data, error } = await db
    .from('client_links')
    .select('entity_kind, entity_id, client_id, method, state')
    .not('entity_id', 'is', null)
    .limit(50000);
  if (error) throw error;
  const known = new Set<string>();
  const settled = new Set<string>();
  for (const r of (data ?? []) as Array<{
    entity_kind: string;
    entity_id: string;
    client_id: string;
    method: string;
    state: string;
  }>) {
    known.add(`${r.entity_kind}\u0000${r.entity_id}\u0000${r.client_id}\u0000${r.method}`);
    if (r.state === 'confirmed') settled.add(`${r.entity_kind}\u0000${r.entity_id}`);
  }
  return { known, settled };
}

/** Propone a cada candidato de un nombre (y cuenta si eran varios). */
function proposeAll(
  ctx: Ctx,
  kind: LinkEntityKind,
  entityId: string,
  result: Pick<ResolveResult, 'candidates' | 'ambiguous' | 'conflict'>,
  label: string | null,
  occurredAt: string | null,
) {
  if (result.conflict) ctx.report.conflicts += 1;
  if (result.candidates.length === 0) return;
  if (result.ambiguous) ctx.report.ambiguous += 1;
  for (const c of result.candidates) propose(ctx, kind, entityId, c, label, occurredAt);
}

/** `matchByText` como resultado del resolvedor (para títulos y asuntos). */
function textCandidates(
  ctx: Ctx,
  text: string | null | undefined,
  allowed: ReadonlySet<LinkMethod> = new Set(['tax_id', 'name_exact', 'name_partial']),
) {
  const match = matchByText(text, ctx.matchable);
  const candidates = match.candidates.filter((c) => allowed.has(c.method));
  return {
    candidates: candidates.map((c) => ({ ...c, name: '', matchedBy: 'name' as const })),
    ambiguous: candidates.length > 1,
    conflict: false,
  };
}

async function section(ctx: Ctx, name: string, work: () => Promise<void>) {
  try {
    await work();
    await flush(ctx);
  } catch {
    ctx.pending.splice(0);
    ctx.report.failed.push(name);
  }
}

// ---------------------------------------------------------------------------
// Crear clientes desde el programa contable
// ---------------------------------------------------------------------------

interface AccountingCustomer {
  taxId: string;
  name: string;
  system: string;
}

/**
 * Los clientes que el programa contable conoce y Cortex no: de la tabla de
 * clientes que la sincronización llena («Clientes (Siigo)») y de las facturas
 * por cobrar que traen un NIT sin ficha.
 *
 * Sólo se crea con un NIT que se pueda leer sin dudas y un nombre. Si ya hay un
 * cliente con ese nombre (aunque sin NIT), NO se crea otro ni se le pone el NIT
 * al que está: eso sería unir por nombre. Queda como conflicto, y el nombre
 * sigue proponiendo por su lado.
 */
export async function accountingCustomersMissing(
  db: SupabaseClient,
  index: ClientIndex,
): Promise<{ missing: AccountingCustomer[]; conflicts: AccountingCustomer[] }> {
  const found = new Map<string, AccountingCustomer>();
  const invoiceNits = new Set<string>();

  const invoices = await db
    .from('accounting_invoices')
    .select('client_nit, counterparty_name, source_system')
    .is('client_id', null)
    .eq('annulled', false)
    .limit(SCAN);
  if (invoices.error) throw invoices.error;
  for (const r of (invoices.data ?? []) as Array<{
    client_nit: string | null;
    counterparty_name: string | null;
    source_system: string;
  }>) {
    const variants = nitVariants(r.client_nit);
    // `client_nit` ya viene sin DV (0165): la primera lectura es la buena.
    const taxId = variants[0];
    if (!taxId) continue;
    invoiceNits.add(taxId);
    const name = r.counterparty_name?.trim();
    if (name && !found.has(taxId)) found.set(taxId, { taxId, name, system: r.source_system });
  }

  const connections = await db
    .from('accounting_connections')
    .select('provider, trackers')
    .limit(10);
  if (!connections.error) {
    for (const conn of (connections.data ?? []) as Array<{
      provider: string;
      trackers: Record<string, string> | null;
    }>) {
      const trackerId = conn.trackers?.customers;
      if (!trackerId) continue;
      const rows = await db
        .from('tracker_rows')
        .select('values')
        .eq('tracker_id', trackerId)
        .limit(SCAN);
      if (rows.error) continue;
      for (const r of (rows.data ?? []) as Array<{ values: Record<string, unknown> | null }>) {
        const v = r.values ?? {};
        if (String(v.estado ?? '') === 'Inactivo') continue;
        if (v.relacion && v.relacion !== 'Cliente') continue;
        const name = typeof v.nombre === 'string' ? v.nombre.trim() : '';
        const variants = nitVariants(v.nit == null ? null : String(v.nit));
        // Con el DV pegado hay dos lecturas: vale la que una factura confirme.
        const taxId =
          variants.length === 1 ? variants[0] : variants.find((x) => invoiceNits.has(x));
        if (!taxId || !name) continue;
        if (!found.has(taxId)) found.set(taxId, { taxId, name, system: conn.provider });
      }
    }
  }

  const missing: AccountingCustomer[] = [];
  const conflicts: AccountingCustomer[] = [];
  for (const c of found.values()) {
    if (index.byTaxId.has(c.taxId)) continue;
    if (c.name.length < 2) continue;
    const taken = (index.byLooseName.get(nameKey(c.name)) ?? new Set()).size > 0;
    (taken ? conflicts : missing).push(c);
  }
  return { missing, conflicts };
}

const SYSTEM_LABEL: Record<string, string> = {
  siigo: 'Siigo',
  alegra: 'Alegra',
  quickbooks: 'QuickBooks',
};

async function autoCreate(ctx: Ctx) {
  const { missing, conflicts } = await accountingCustomersMissing(ctx.db, ctx.index);
  ctx.report.conflicts += conflicts.length;
  for (const c of missing.slice(0, 300)) {
    const { error } = await ctx.db.from('clients').insert({
      name: c.name.slice(0, 160),
      tax_id: c.taxId,
      status: 'active',
      source: 'accounting',
      source_detail: `Creado desde ${SYSTEM_LABEL[c.system] ?? c.system}`,
      created_by: ctx.userId,
    });
    if (error) {
      // Otro barrido lo creó primero, o el nombre ya existe con otra grafía.
      if (isUniqueViolation(error)) continue;
      throw error;
    }
    ctx.report.created += 1;
  }
}

// ---------------------------------------------------------------------------
// Cada tabla
// ---------------------------------------------------------------------------

async function linkAccountingInvoices(ctx: Ctx) {
  const { data, error } = await ctx.db
    .from('accounting_invoices')
    .select('id, client_nit, counterparty_name, doc_number, issued_on')
    .is('client_id', null)
    .limit(SCAN);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{
    id: string;
    client_nit: string | null;
    counterparty_name: string | null;
    doc_number: string;
    issued_on: string | null;
  }>) {
    const res = resolveAgainst(ctx.index, { taxId: r.client_nit, name: r.counterparty_name });
    if (res.client && res.applies) {
      if (await writeOwnerColumn(ctx.db, 'invoice', r.id, res.client.clientId)) {
        bump(ctx.report, 'invoice');
      }
      continue;
    }
    proposeAll(ctx, 'invoice', r.id, res, `Factura ${r.doc_number}`, r.issued_on);
  }
}

async function linkExtractions(ctx: Ctx) {
  const { data, error } = await ctx.db
    .from('document_extractions')
    .select('id, counterparty_nit, counterparty_name, doc_number, issued_on, review_state')
    .is('client_id', null)
    .neq('review_state', 'rejected')
    .limit(SCAN);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{
    id: string;
    counterparty_nit: string | null;
    counterparty_name: string | null;
    doc_number: string | null;
    issued_on: string | null;
  }>) {
    if (!r.counterparty_nit && !r.counterparty_name) continue;
    const res = resolveAgainst(ctx.index, {
      taxId: r.counterparty_nit,
      name: r.counterparty_name,
    });
    // Sólo el NIT llena la columna aquí: 0076 promete que una extracción se
    // vincula por NIT y nunca por nombre. El alias también queda propuesto.
    if (res.client?.matchedBy === 'tax_id') {
      const nit = nitVariants(r.counterparty_nit).find((v) => ctx.index.byTaxId.has(v)) ?? null;
      if (
        await writeOwnerColumn(ctx.db, 'extraction', r.id, res.client.clientId, {
          client_nit: nit,
        })
      ) {
        bump(ctx.report, 'extraction');
      }
      continue;
    }
    const label = r.doc_number ? `Factura ${r.doc_number}` : 'Documento leído';
    proposeAll(
      ctx,
      'extraction',
      r.id,
      res.client && res.applies
        ? { candidates: [res.client], ambiguous: false, conflict: false }
        : res,
      label,
      r.issued_on,
    );
  }
}

async function linkPayments(ctx: Ctx) {
  const { data, error } = await ctx.db
    .from('payments')
    .select('id, client_nit')
    .is('client_id', null)
    .not('client_nit', 'is', null)
    .limit(SCAN);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{ id: string; client_nit: string | null }>) {
    const res = resolveAgainst(ctx.index, { taxId: r.client_nit });
    if (res.client?.matchedBy !== 'tax_id') continue;
    if (await writeOwnerColumn(ctx.db, 'payment', r.id, res.client.clientId)) {
      bump(ctx.report, 'payment');
    }
  }
}

/**
 * El libro: sólo lo que ENTRA de un cliente (facturas por cobrar e ingresos).
 * Lo que sale es de proveedores, y un proveedor con nombre parecido a un
 * cliente es justo el error que no se puede cometer solo.
 */
async function linkLedger(ctx: Ctx) {
  const { data, error } = await ctx.db
    .from('ledger_movements')
    .select('id, counterparty_name, counterparty_tax_id, description, date, kind')
    .is('client_id', null)
    .eq('direction', 'in')
    .in('kind', ['receivable', 'income'])
    .is('duplicate_of', null)
    .neq('status', 'cancelled')
    .order('date', { ascending: false })
    .limit(SCAN);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{
    id: string;
    counterparty_name: string | null;
    counterparty_tax_id: string | null;
    description: string;
    date: string;
  }>) {
    if (!r.counterparty_name && !r.counterparty_tax_id) continue;
    const res = resolveAgainst(ctx.index, {
      taxId: r.counterparty_tax_id,
      name: r.counterparty_name,
    });
    if (res.client && res.applies) {
      const by = res.client.matchedBy === 'tax_id' ? 'tax_id' : 'alias';
      if (
        await writeOwnerColumn(ctx.db, 'ledger_movement', r.id, res.client.clientId, {
          client_matched_by: by,
        })
      ) {
        bump(ctx.report, 'ledger_movement');
      }
      continue;
    }
    proposeAll(ctx, 'ledger_movement', r.id, res, r.counterparty_name ?? r.description, r.date);
  }
}

async function linkCommitments(ctx: Ctx) {
  const result = await matchCommitmentsToClients(ctx.db);
  if (result.matched)
    ctx.report.applied.commitment = (ctx.report.applied.commitment ?? 0) + result.matched;
  if (result.ambiguous === 0) return;
  const { data, error } = await ctx.db
    .from('commitments')
    .select('id, counterparty, title, due_on')
    .is('client_id', null)
    .not('counterparty', 'is', null)
    .limit(SCAN);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{
    id: string;
    counterparty: string | null;
    title: string;
    due_on: string;
  }>) {
    const m = textCandidates(ctx, r.counterparty);
    if (m.candidates.length > 1) proposeAll(ctx, 'commitment', r.id, m, r.title, r.due_on);
  }
}

async function linkActions(ctx: Ctx) {
  const { data, error } = await ctx.db
    .from('actions')
    .select('id, recipient')
    .is('client_id', null)
    .limit(SCAN);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{ id: string; recipient: string | null }>) {
    const res = resolveAgainst(ctx.index, { email: r.recipient });
    if (!res.client || !res.applies) continue;
    if (await writeOwnerColumn(ctx.db, 'action', r.id, res.client.clientId)) {
      bump(ctx.report, 'action');
    }
  }
}

/** Correos ya archivados cuyo dominio se registró después. */
async function linkMail(ctx: Ctx, table: 'gmail_thread_ingests' | 'microsoft_mail_ingests') {
  const { data, error } = await ctx.db
    .from(table)
    .select('id, counterpart_domain')
    .is('client_id', null)
    .not('counterpart_domain', 'is', null)
    .limit(SCAN);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{ id: string; counterpart_domain: string | null }>) {
    const res = resolveAgainst(ctx.index, { domain: r.counterpart_domain });
    if (!res.client || res.client.matchedBy !== 'domain') continue;
    const up = await ctx.db
      .from(table)
      .update({ client_id: res.client.clientId })
      .eq('id', r.id)
      .is('client_id', null);
    if (up.error) throw up.error;
    bump(ctx.report, 'email');
  }
}

async function linkWhatsappGroups(ctx: Ctx) {
  const { data, error } = await ctx.db
    .from('whatsapp_groups')
    .select('id, subject, last_message_at')
    .limit(SCAN);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{
    id: string;
    subject: string | null;
    last_message_at: string | null;
  }>) {
    if (!r.subject) continue;
    const exact = resolveAgainst(ctx.index, { name: r.subject });
    if (exact.client && exact.applies) {
      await applyLink(ctx, 'whatsapp_group', r.id, exact.client, r.subject, r.last_message_at);
      continue;
    }
    proposeAll(
      ctx,
      'whatsapp_group',
      r.id,
      textCandidates(ctx, r.subject),
      r.subject,
      r.last_message_at,
    );
  }
}

/**
 * Reuniones. No hay correos de asistentes guardados (Meet da nombres), así que
 * «por dominio del asistente» no se puede: se propone por el título y por el
 * nombre de un contacto registrado entre los asistentes (`contact_name`).
 */
async function linkMeetings(ctx: Ctx) {
  const contacts = await ctx.db.from('client_contacts').select('client_id, full_name').limit(10000);
  if (contacts.error) throw contacts.error;
  const byPerson = new Map<string, Set<string>>();
  for (const c of (contacts.data ?? []) as Array<{ client_id: string; full_name: string }>) {
    // Sólo nombres de dos palabras o más: «Carlos» a secas es medio país.
    if (c.full_name.trim().split(/\s+/).length < 2) continue;
    const key = nameKey(c.full_name);
    const set = byPerson.get(key) ?? new Set<string>();
    set.add(c.client_id);
    byPerson.set(key, set);
  }

  const calls = await ctx.db
    .from('live_calls')
    .select('id, title, participants, started_at')
    .order('started_at', { ascending: false })
    .limit(300);
  if (calls.error) throw calls.error;
  for (const r of (calls.data ?? []) as Array<{
    id: string;
    title: string | null;
    participants: Array<{ name?: string | null; self?: boolean }> | null;
    started_at: string | null;
  }>) {
    const label = r.title || 'Reunión';
    proposeAll(ctx, 'meeting', r.id, textCandidates(ctx, r.title), label, r.started_at);
    for (const p of r.participants ?? []) {
      if (p.self || !p.name) continue;
      for (const clientId of byPerson.get(nameKey(p.name)) ?? []) {
        propose(
          ctx,
          'meeting',
          r.id,
          { clientId, method: 'contact_name', evidence: `Asistió ${p.name}` },
          label,
          r.started_at,
        );
      }
    }
  }
}

async function linkCases(ctx: Ctx) {
  const { data, error } = await ctx.db
    .from('management_cases')
    .select('id, data, created_at')
    .limit(500);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{
    id: string;
    data: { title?: string; state?: string } | null;
    created_at: string;
  }>) {
    const title = r.data?.title;
    if (!title || r.data?.state === 'cancelled') continue;
    proposeAll(ctx, 'case', r.id, textCandidates(ctx, title), title, r.created_at);
  }
}

async function linkWorkItems(ctx: Ctx) {
  const { data, error } = await ctx.db
    .from('work_items')
    .select('id, title, opened_at, source_kind')
    .eq('status', 'open')
    .limit(1000);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{
    id: string;
    title: string;
    opened_at: string | null;
    source_kind: string;
  }>) {
    // Lo que nace de un vencimiento o un caso ya llega a la ficha por ellos.
    if (r.source_kind === 'commitment' || r.source_kind === 'management_case') continue;
    proposeAll(ctx, 'work_item', r.id, textCandidates(ctx, r.title), r.title, r.opened_at);
  }
}

/** Documentos del cerebro: sólo NIT o nombre completo en el título; lo parcial es ruido. */
async function linkDocuments(ctx: Ctx) {
  const { data, error } = await ctx.db
    .from('kb_documents')
    .select('id, title, created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  const strong = new Set<LinkMethod>(['tax_id', 'name_exact']);
  for (const r of (data ?? []) as Array<{ id: string; title: string | null; created_at: string }>) {
    if (!r.title) continue;
    proposeAll(ctx, 'document', r.id, textCandidates(ctx, r.title, strong), r.title, r.created_at);
  }
}

// ---------------------------------------------------------------------------
// El barrido
// ---------------------------------------------------------------------------

export async function linkClientRecords(
  db: SupabaseClient,
  opts: LinkRunOptions = {},
): Promise<LinkRunReport> {
  const report: LinkRunReport = {
    created: 0,
    applied: {},
    proposed: 0,
    ambiguous: 0,
    conflicts: 0,
    failed: [],
  };
  const ctx: Ctx = {
    db,
    index: await loadClientIndex(db),
    matchable: [],
    report,
    known: new Set(),
    settled: new Set(),
    pending: [],
    cap: opts.proposalCap ?? 600,
    userId: opts.userId ?? null,
  };

  if (opts.autoCreate !== false) {
    await section(ctx, 'clientes del programa contable', () => autoCreate(ctx));
    if (report.created > 0) ctx.index = await loadClientIndex(db);
  }
  ctx.matchable = [...ctx.index.clients.values()].map((c) => ({
    id: c.id,
    name: c.name,
    legal_name: c.legal_name ?? null,
    tax_id: c.tax_id ?? null,
  }));

  const known = await loadKnownLinks(db);
  ctx.known = known.known;
  ctx.settled = known.settled;

  await section(ctx, 'facturas del programa contable', () => linkAccountingInvoices(ctx));
  await section(ctx, 'facturas leídas de documentos', () => linkExtractions(ctx));
  await section(ctx, 'pagos', () => linkPayments(ctx));
  await section(ctx, 'libro de plata', () => linkLedger(ctx));
  await section(ctx, 'vencimientos', () => linkCommitments(ctx));
  await section(ctx, 'acciones de cobro', () => linkActions(ctx));
  await section(ctx, 'correos de Gmail', () => linkMail(ctx, 'gmail_thread_ingests'));
  await section(ctx, 'correos de Outlook', () => linkMail(ctx, 'microsoft_mail_ingests'));
  await section(ctx, 'grupos de WhatsApp', () => linkWhatsappGroups(ctx));
  await section(ctx, 'reuniones', () => linkMeetings(ctx));
  await section(ctx, 'casos', () => linkCases(ctx));
  await section(ctx, 'trabajo del equipo', () => linkWorkItems(ctx));
  await section(ctx, 'documentos', () => linkDocuments(ctx));
  return report;
}

/** El informe en una frase, para la pantalla y el trabajo programado. */
export function describeLinkRun(report: LinkRunReport): string {
  const applied = Object.values(report.applied).reduce((s, n) => s + (n ?? 0), 0);
  const parts: string[] = [];
  if (report.created)
    parts.push(
      `creé ${report.created} cliente${report.created === 1 ? '' : 's'} desde el programa contable`,
    );
  parts.push(
    applied
      ? `vinculé ${applied} cosa${applied === 1 ? '' : 's'} por NIT, correo, dominio o un nombre ya confirmado`
      : 'no encontré nada nuevo que vincular solo',
  );
  if (report.proposed) parts.push(`dejé ${report.proposed} por confirmar`);
  if (report.ambiguous) parts.push(`${report.ambiguous} calzaban con más de un cliente`);
  if (report.failed.length) parts.push(`no pude revisar: ${report.failed.join(', ')}`);
  const text = parts.join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

// ---------------------------------------------------------------------------
// Confirmar lo propuesto
// ---------------------------------------------------------------------------

export interface ConfirmOutcome {
  confirmed: number;
  /** Propuestas de OTROS clientes para lo mismo, descartadas al confirmar. */
  competitorsRejected: number;
  /** Filas cuya columna client_id quedó llena. */
  ownerColumns: number;
  /** El nombre quedó aprendido como alias (se aplicará solo la próxima vez). */
  aliasLearned: boolean;
}

/**
 * Una persona dice «sí, esto es de este cliente».
 *
 * Tres cosas, en este orden, y todas idempotentes:
 *   1. el vínculo pasa a `confirmed` con su nombre (0075: el único camino);
 *   2. las propuestas de OTROS clientes para la misma cosa se descartan — una
 *      cosa no puede ser de dos, y dejarlas vivas sería pedir la misma
 *      decisión otra vez;
 *   3. si la cosa tiene columna propia (factura, pago, movimiento…), se llena.
 */
export async function confirmClientLinks(
  db: SupabaseClient,
  input: { ids: string[]; userId: string; rememberAlias?: string | null },
): Promise<ConfirmOutcome> {
  const out: ConfirmOutcome = {
    confirmed: 0,
    competitorsRejected: 0,
    ownerColumns: 0,
    aliasLearned: false,
  };
  if (input.ids.length === 0) return out;
  const { data, error } = await db
    .from('client_links')
    .select('id, client_id, entity_kind, entity_id, state')
    .in('id', input.ids.slice(0, 500));
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    client_id: string;
    entity_kind: LinkEntityKind;
    entity_id: string | null;
    state: string;
  }>;
  const now = new Date().toISOString();
  for (const link of rows) {
    if (link.state !== 'confirmed') {
      const up = await db
        .from('client_links')
        .update({
          state: 'confirmed',
          confirmed_by: input.userId,
          confirmed_at: now,
          rejected_by: null,
          rejected_at: null,
          rejected_reason: null,
        })
        .eq('id', link.id);
      // Ya confirmada a otro cliente (el índice de 0075): se deja y se sigue.
      if (up.error) {
        if (isUniqueViolation(up.error)) continue;
        throw up.error;
      }
      out.confirmed += 1;
    }
    if (!link.entity_id) continue;
    const rivals = await db
      .from('client_links')
      .update({
        state: 'rejected',
        rejected_by: input.userId,
        rejected_at: now,
        rejected_reason: 'Se confirmó con otro cliente.',
      })
      .eq('entity_kind', link.entity_kind)
      .eq('entity_id', link.entity_id)
      .eq('state', 'suggested')
      .neq('client_id', link.client_id)
      .select('id');
    if (rivals.error) throw rivals.error;
    out.competitorsRejected += ((rivals.data ?? []) as unknown[]).length;
    if (OWNER_COLUMN[link.entity_kind]) {
      if (await writeOwnerColumn(db, link.entity_kind, link.entity_id, link.client_id)) {
        out.ownerColumns += 1;
      }
    }
  }

  const alias = input.rememberAlias?.trim();
  const clientId = rows[0]?.client_id;
  if (alias && clientId && alias.length >= 2) {
    const ins = await db.from('client_aliases').insert({
      client_id: clientId,
      alias: alias.slice(0, 200),
      source: 'confirmation',
      verified_by: input.userId,
      verified_at: now,
    });
    if (ins.error && !isUniqueViolation(ins.error)) throw ins.error;
    out.aliasLearned = !ins.error;
  }
  return out;
}

/** «No, esto no es de este cliente», para una o muchas propuestas. */
export async function rejectClientLinks(
  db: SupabaseClient,
  input: { ids: string[]; userId: string; reason?: string | null },
): Promise<number> {
  if (input.ids.length === 0) return 0;
  const { data, error } = await db
    .from('client_links')
    .update({
      state: 'rejected',
      rejected_by: input.userId,
      rejected_at: new Date().toISOString(),
      rejected_reason: input.reason?.trim().slice(0, 300) || null,
    })
    .in('id', input.ids.slice(0, 500))
    .eq('state', 'suggested')
    .select('id');
  if (error) throw error;
  return ((data ?? []) as unknown[]).length;
}

// ---------------------------------------------------------------------------
// «Por confirmar», agrupado
// ---------------------------------------------------------------------------

export interface ProposalGroup {
  /** Clave estable para la pantalla: cliente + clase + evidencia plegada. */
  key: string;
  clientId: string;
  clientName: string;
  kind: LinkEntityKind;
  method: LinkMethod;
  /** Lo que dicen las filas: «COLTRANS SAS BOGOTA», «Asistió Carlos Pérez». */
  evidence: string;
  ids: string[];
  /** Hasta cinco ejemplos: título y fecha. */
  samples: Array<{ label: string; occurredAt: string | null }>;
  /** Otros clientes que también reclaman alguna de estas cosas. */
  rivals: string[];
  newest: string | null;
}

/**
 * Las propuestas agrupadas por cliente y por lo que las justificó, para
 * decidir de a montones: «47 movimientos dicen "COLTRANS SAS BOGOTA" → ¿son
 * de Coltrans?». Confirmar el grupo puede, además, aprender el nombre.
 */
export function groupProposals(
  rows: Array<{
    id: string;
    client_id: string;
    entity_kind: LinkEntityKind;
    entity_id: string | null;
    entity_ref?: string | null;
    method: LinkMethod;
    evidence: string | null;
    label: string | null;
    occurred_at: string | null;
    created_at?: string | null;
  }>,
  clientNames: ReadonlyMap<string, string>,
): ProposalGroup[] {
  const groups = new Map<string, ProposalGroup>();
  const claimants = new Map<string, Set<string>>();
  for (const r of rows) {
    const entity = `${r.entity_kind}\u0000${r.entity_id ?? r.entity_ref ?? r.id}`;
    const set = claimants.get(entity) ?? new Set<string>();
    set.add(r.client_id);
    claimants.set(entity, set);
  }
  for (const r of rows) {
    const evidence = (r.evidence ?? r.label ?? '').trim();
    const key = `${r.client_id}|${r.entity_kind}|${r.method}|${nameKey(evidence) || evidence}`;
    const g = groups.get(key) ?? {
      key,
      clientId: r.client_id,
      clientName: clientNames.get(r.client_id) ?? 'Cliente',
      kind: r.entity_kind,
      method: r.method,
      evidence,
      ids: [],
      samples: [],
      rivals: [],
      newest: null,
    };
    g.ids.push(r.id);
    if (g.samples.length < 5)
      g.samples.push({ label: r.label ?? evidence, occurredAt: r.occurred_at });
    const when = r.occurred_at ?? r.created_at ?? null;
    if (when && (!g.newest || when > g.newest)) g.newest = when;
    const entity = `${r.entity_kind}\u0000${r.entity_id ?? r.entity_ref ?? r.id}`;
    for (const other of claimants.get(entity) ?? []) {
      if (other === r.client_id) continue;
      const name = clientNames.get(other) ?? 'otro cliente';
      if (!g.rivals.includes(name)) g.rivals.push(name);
    }
    groups.set(key, g);
  }
  return [...groups.values()].sort(
    (a, b) => b.ids.length - a.ids.length || (b.newest ?? '').localeCompare(a.newest ?? ''),
  );
}
