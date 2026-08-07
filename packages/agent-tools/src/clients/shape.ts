import { z } from 'zod';

/**
 * The pure core of the clients module: identity, normalization, and the rule
 * about which signals may be APPLIED and which may only be PROPOSED.
 *
 * Everything in this file is a function of its arguments — no database, no
 * clock, no model. That is deliberate, and for the same reason it was
 * deliberate in commitments/shape.ts: the two things most likely to be wrong
 * here are the NIT arithmetic and the matcher, and neither is testable while it
 * is tangled up with the job that runs it.
 *
 * Read the header of migration 0075 first. The short version:
 *
 *   The NIT is the identity. The name is how people refer to it.
 *   A link that was not earned is worse than no link at all.
 */

// ---------------------------------------------------------------------------
// The NIT
// ---------------------------------------------------------------------------

/**
 * The verification digit of a Colombian NIT, from its digits.
 *
 * The DIAN's algorithm: each digit, read from the right, multiplied by a fixed
 * prime; sum modulo 11; subtract from 11 unless the remainder is 0 or 1.
 *
 * This is a mirror of `public.nit_dv` in migration 0075 — deliberately, because
 * the two run in different places for different reasons. The database computes
 * it into a stored column so the value on the row is never a typed guess; this
 * one computes it in the browser and in the tools so a person can be told
 * "ese NIT no cuadra" while they are still looking at the field, instead of
 * after a round trip. `__tests__/shape.test.ts` pins the algorithm against
 * published NITs so the two cannot drift on the only thing that matters.
 */
const NIT_WEIGHTS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

export function nitDv(digits: string): number | null {
  if (!/^\d{4,15}$/.test(digits)) return null;
  let total = 0;
  const reversed = [...digits].reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    total += Number(reversed[i]) * (NIT_WEIGHTS[i] as number);
  }
  const rest = total % 11;
  return rest <= 1 ? rest : 11 - rest;
}

/** Digits only: "830.025.281-7" and "8300252817" both need one representation. */
export function normalizeNit(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '');
}

export interface ParsedNit {
  /** The NIT without its verification digit — what goes in `clients.tax_id`. */
  digits: string;
  /** The digit the NIT implies. */
  dv: number;
  /** "830.025.281-7" — how a Colombian writes it. */
  formatted: string;
}

export class InvalidNitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNitError';
  }
}

/**
 * Read a NIT the way a person wrote it, and refuse it if it does not check out.
 *
 * THE WHOLE POINT IS THE REFUSAL. A NIT that was typed with two digits swapped
 * is still a plausible-looking number, and saved without checking it becomes a
 * second, ghost client that nothing will ever match against the first. The
 * verification digit exists precisely to catch that, and it only catches it if
 * somebody actually compares. So:
 *
 *   "830025281-7"   → accepted; the DV agrees with the digits.
 *   "830025281-3"   → REFUSED, by name: the digits imply 7.
 *   "830025281"     → accepted; no DV was offered, so there is nothing to
 *                     contradict, and the correct one is computed.
 *
 * The last case is not a loophole. A NIT with no DV is not a claim about a
 * check digit; a NIT with the WRONG DV is, and it is a claim that is false.
 */
export function parseNit(raw: string): ParsedNit {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new InvalidNitError('Escribe el NIT.');

  // A DV, when offered, is written after a dash or a space at the very end.
  const tail = trimmed.match(/[-\s]\s*(\d)\s*$/);
  const given = tail?.[1] ? Number(tail[1]) : null;
  const body = tail ? trimmed.slice(0, tail.index) : trimmed;
  const digits = normalizeNit(body);

  if (!/^\d{4,15}$/.test(digits)) {
    throw new InvalidNitError(
      `"${raw}" no parece un NIT. Son entre 4 y 15 dígitos, con o sin el dígito de verificación.`,
    );
  }
  const dv = nitDv(digits) as number;
  if (given !== null && given !== dv) {
    throw new InvalidNitError(
      `El NIT ${formatNit(digits)}-${dv} no cuadra con el dígito de verificación que escribiste (${given}). Revisa los números antes de guardarlo: un dígito cambiado crea un cliente repetido que después no empareja con nada.`,
    );
  }
  return { digits, dv, formatted: `${formatNit(digits)}-${dv}` };
}

/** "830025281" → "830.025.281". Grouping is how the number is read aloud. */
export function formatNit(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** The full, printable NIT including its verification digit, or null. */
export function fullNit(digits: string | null | undefined): string | null {
  if (!digits) return null;
  const dv = nitDv(digits);
  return dv === null ? formatNit(digits) : `${formatNit(digits)}-${dv}`;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Legal suffixes, which are noise for matching and signal for nothing.
 *
 * "COLTRANS S.A.S." on the invoice, "Coltrans" in the mail, "Coltrans Ltda" in
 * a contract written before the conversion. One company, three spellings, and
 * the suffix is the only thing that differs in most of them.
 */
const LEGAL_SUFFIXES = new Set([
  'sas',
  'sa',
  'ltda',
  'lta',
  'eu',
  'sca',
  'sencs',
  'scs',
  'cia',
  'compania',
  'ci',
  'bic',
  'esp',
  'inc',
  'llc',
  'corp',
  'sl',
  'srl',
  'ltd',
  'co',
]);

function fold(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * The STRICT key: casefolded, unaccented, punctuation-free, suffix intact.
 *
 * Mirrors `public.client_name_key` in migration 0075 exactly, and is what the
 * unattended backfill uses. "COLTRANS S.A.S." → "coltranssas".
 */
export function strictNameKey(raw: string | null | undefined): string {
  return fold(raw ?? '').replace(/[^a-z0-9]+/g, '');
}

/**
 * The MATCHING key: the strict key with legal suffixes removed.
 *
 * "COLTRANS S.A.S." and "Coltrans" both become "coltrans". Looser than the SQL
 * mirror on purpose, and only ever used where a person sees the result before
 * anything is written — a search box, the register form's duplicate warning,
 * the proposal list. The unattended path gets the strict rule; see the note
 * above `client_name_key` in the migration.
 *
 * A company literally called "SAS" would fold to nothing, so an empty result
 * falls back to the strict key rather than matching every other empty one.
 */
export function nameKey(raw: string | null | undefined): string {
  const words = tokenize(raw);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1] as string)) {
    words.pop();
  }
  const key = words.join('');
  return key || strictNameKey(raw);
}

/**
 * A name split into words, with runs of single letters glued back together.
 *
 * "S.A.S." punctuates into three one-letter words and a suffix list that
 * contains "sas" would never see it — which is the difference between
 * "COLTRANS S.A.S." folding to "coltrans" and folding to "coltranssas", and
 * therefore the difference between finding the client and creating a second
 * one. Colombian legal forms are almost all initialisms ("S.A.S.", "E.U.",
 * "C.I.", "S. en C."), so this is the normal case rather than an edge.
 */
function tokenize(raw: string | null | undefined): string[] {
  const words = fold(raw ?? '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  const merged: string[] = [];
  let run = '';
  for (const word of words) {
    if (word.length === 1) {
      run += word;
      continue;
    }
    if (run) {
      merged.push(run);
      run = '';
    }
    merged.push(word);
  }
  if (run) merged.push(run);
  return merged;
}

// ---------------------------------------------------------------------------
// Email domains
// ---------------------------------------------------------------------------

/**
 * Free mail providers. Registering one against a client would attach every
 * personal address the company corresponds with to that client, in one write —
 * the single most damaging row `client_domains` could hold, which is why the
 * database refuses it too (migration 0075 § 4). This list is the friendlier
 * half of that refusal: it says so before the insert fails.
 */
export const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.es',
  'outlook.com',
  'outlook.es',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.es',
  'icloud.com',
  'me.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'gmx.com',
  'zoho.com',
  'mail.com',
  'yandex.com',
]);

/** Bare hostname, lower case: "@Coltrans.COM " → "coltrans.com". */
export function normalizeDomain(raw: string | null | undefined): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '')
    .trim();
}

/** The domain half of an address, normalized. Null when it is not an address. */
export function domainOf(email: string | null | undefined): string | null {
  const at = (email ?? '').lastIndexOf('@');
  if (at < 1) return null;
  const domain = normalizeDomain((email as string).slice(at + 1));
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)
    ? domain
    : null;
}

export function isPublicDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(normalizeDomain(domain));
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase();
  return value.includes('@') ? value : null;
}

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

export const CLIENT_STATUSES = ['prospect', 'active', 'dormant', 'former', 'blocked'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const STATUS_LABEL: Record<ClientStatus, string> = {
  prospect: 'Prospecto',
  active: 'Activo',
  dormant: 'Sin movimiento',
  former: 'Ex cliente',
  blocked: 'Bloqueado',
};

/** Colour carries meaning; see docs/design-system.md. `blocked` is the refusal. */
export const STATUS_TONE: Record<ClientStatus, 'emerald' | 'amber' | 'sky' | 'rose'> = {
  prospect: 'sky',
  active: 'emerald',
  dormant: 'amber',
  former: 'amber',
  blocked: 'rose',
};

export const CLIENT_SERVICES = [
  'courier',
  'carga',
  'aduana',
  'almacenamiento',
  'ultima_milla',
  'otro',
] as const;
export type ClientService = (typeof CLIENT_SERVICES)[number];

export const SERVICE_LABEL: Record<ClientService, string> = {
  courier: 'Courier',
  carga: 'Carga',
  aduana: 'Aduana',
  almacenamiento: 'Almacenamiento',
  ultima_milla: 'Última milla',
  otro: 'Otro',
};

export const CUSTOMS_ROLES = ['importador', 'exportador', 'ambos', 'ninguno'] as const;
export type CustomsRole = (typeof CUSTOMS_ROLES)[number];

export const CUSTOMS_ROLE_LABEL: Record<CustomsRole, string> = {
  importador: 'Importador',
  exportador: 'Exportador',
  ambos: 'Importa y exporta',
  ninguno: 'No hace comercio exterior',
};

export const LINK_ENTITY_KINDS = [
  'document',
  'meeting',
  'whatsapp_group',
  'email_thread',
  'vehicle',
  'contact',
] as const;
export type LinkEntityKind = (typeof LINK_ENTITY_KINDS)[number];

export const ENTITY_KIND_LABEL: Record<LinkEntityKind, string> = {
  document: 'Documento',
  meeting: 'Reunión',
  whatsapp_group: 'Grupo de WhatsApp',
  email_thread: 'Correo',
  vehicle: 'Vehículo',
  contact: 'Contacto',
};

export const LINK_STATES = ['suggested', 'confirmed', 'rejected'] as const;
export type LinkState = (typeof LINK_STATES)[number];

export const LINK_STATE_LABEL: Record<LinkState, string> = {
  suggested: 'Propuesto',
  confirmed: 'Vinculado',
  rejected: 'Descartado',
};

export const LINK_METHODS = [
  'email_domain',
  'contact_email',
  'tax_id',
  'name_exact',
  'name_partial',
  'manual',
  'inherited',
] as const;
export type LinkMethod = (typeof LINK_METHODS)[number];

export const METHOD_LABEL: Record<LinkMethod, string> = {
  email_domain: 'Dominio del correo',
  contact_email: 'Correo de un contacto',
  tax_id: 'NIT en el texto',
  name_exact: 'Nombre exacto',
  name_partial: 'Nombre parecido',
  manual: 'Vinculado a mano',
  inherited: 'Heredado de algo ya vinculado',
};

/**
 * One line explaining, to the person reading the card, why Cortex says this
 * thing is Coltrans's. Shown next to the evidence, never instead of it.
 */
export const METHOD_SENTENCE: Record<LinkMethod, string> = {
  email_domain: 'El dominio del remitente está registrado a nombre de este cliente.',
  contact_email: 'La dirección es la de un contacto registrado de este cliente.',
  tax_id: 'El NIT del cliente aparece tal cual en el texto.',
  name_exact: 'El nombre del cliente aparece completo.',
  name_partial: 'Hay un parecido en el nombre, pero no es exacto.',
  manual: 'Alguien lo vinculó a mano.',
  inherited: 'Llegó adjunto a algo que ya estaba vinculado a este cliente.',
};

/**
 * THE DECISION, IN ONE CONSTANT.
 *
 * These two methods may write `state = 'confirmed'` without anybody reviewing
 * the individual link. Everything else proposes and waits.
 *
 * The distinction is NOT confidence. It is whether the match applies a
 * statement a human already made, or draws a conclusion of its own:
 *
 *   email_domain   somebody registered "@coltrans.com belongs to Coltrans".
 *                  Matching a sender against it repeats their sentence. The
 *                  human judgement happened once, at registration, and is
 *                  carried onto every link it produces through `confirmed_by`.
 *   contact_email  the same, one address at a time.
 *
 *   tax_id         a NIT in a body of text is usually the client's and
 *                  sometimes the carrier's, the insurer's, or the consignee's.
 *                  A customs document names four companies by NIT, and only
 *                  one of them is whose the document is.
 *   name_exact     "Coltrans" in a subject line can be an introduction, a
 *                  complaint about them, or a quote from somebody else.
 *   name_partial   weaker still.
 *
 * The last three are good enough to put in front of a person and nowhere near
 * good enough to apply. A missing link costs a search; a wrong one puts one
 * customer's mail on another customer's card, and there is no undo for having
 * been read.
 */
export const APPLYING_METHODS: ReadonlySet<LinkMethod> = new Set<LinkMethod>([
  'email_domain',
  'contact_email',
]);

export function methodApplies(method: LinkMethod): boolean {
  return APPLYING_METHODS.has(method);
}

/**
 * A number for sorting proposals, not for deciding anything. Nothing in this
 * module branches on it — `APPLYING_METHODS` decides, and it is a set of names
 * rather than a threshold precisely so that nobody can widen the automatic path
 * by nudging a constant.
 */
export const METHOD_CONFIDENCE: Record<LinkMethod, number> = {
  email_domain: 1,
  contact_email: 1,
  manual: 1,
  inherited: 0.8,
  tax_id: 0.75,
  name_exact: 0.6,
  name_partial: 0.35,
};

// ---------------------------------------------------------------------------
// Rows → model- and screen-facing shapes
// ---------------------------------------------------------------------------

export const CLIENT_COLUMNS =
  'id, organization_id, name, legal_name, tax_id, tax_id_dv, name_key, status, city, department, address, phone, website, services, customs_role, payment_terms_days, credit_limit_cop, owner_user_id, since, notes, created_by, created_at, updated_at';

export interface ClientRow {
  id: string;
  organization_id: string;
  name: string;
  legal_name: string | null;
  tax_id: string | null;
  tax_id_dv: number | null;
  name_key: string | null;
  status: ClientStatus;
  city: string | null;
  department: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  services: string[] | null;
  customs_role: CustomsRole | null;
  payment_terms_days: number | null;
  credit_limit_cop: number | null;
  owner_user_id: string | null;
  since: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Filled by `hydrate`; never selected. */
  owner_name?: string | null;
}

export const clientSchema = z.object({
  id: z.string(),
  name: z.string().describe('What people call them out loud'),
  legalName: z.string().nullable().describe('Razón social, as the RUT spells it'),
  nit: z.string().nullable().describe('NIT with its verification digit, e.g. "830.025.281-7"'),
  status: z.enum(CLIENT_STATUSES),
  statusLabel: z.string(),
  city: z.string().nullable(),
  department: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  services: z.array(z.string()).describe('Lines of business: courier, carga, aduana…'),
  customsRole: z.string().nullable(),
  paymentTermsDays: z.number().nullable().describe('Agreed payment window, in days'),
  owner: z.string().nullable().describe('Who answers for this client here'),
  since: z.string().nullable(),
  notes: z.string().nullable(),
  updatedAt: z.string(),
});

export type Client = z.infer<typeof clientSchema>;

export function adaptClient(row: ClientRow): Client {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legal_name,
    nit: fullNit(row.tax_id),
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] ?? row.status,
    city: row.city,
    department: row.department,
    phone: row.phone,
    website: row.website,
    services: row.services ?? [],
    customsRole: row.customs_role ? (CUSTOMS_ROLE_LABEL[row.customs_role] ?? null) : null,
    paymentTermsDays: row.payment_terms_days,
    owner: row.owner_name ?? null,
    since: row.since,
    notes: row.notes,
    updatedAt: row.updated_at,
  };
}

export const CONTACT_COLUMNS =
  'id, organization_id, client_id, full_name, email, phone, role_title, is_primary, status, source, source_detail, first_seen_at, last_seen_at, notes, created_by, created_at, updated_at';

export interface ContactRow {
  id: string;
  organization_id: string;
  client_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role_title: string | null;
  is_primary: boolean;
  status: 'active' | 'left' | 'unknown';
  source: 'manual' | 'email' | 'whatsapp' | 'meeting' | 'document';
  source_detail: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const contactSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  role: z.string().nullable(),
  isPrimary: z.boolean(),
  status: z.string(),
  source: z.string().describe('manual when a person typed it; otherwise where Cortex saw it'),
  lastSeenAt: z.string().nullable(),
});

export type Contact = z.infer<typeof contactSchema>;

export function adaptContact(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.full_name,
    email: row.email,
    phone: row.phone,
    role: row.role_title,
    isPrimary: row.is_primary,
    status: row.status,
    source: row.source,
    lastSeenAt: row.last_seen_at,
  };
}

export const DOMAIN_COLUMNS =
  'id, organization_id, client_id, domain, verified_by, verified_at, note, created_at';

export interface DomainRow {
  id: string;
  organization_id: string;
  client_id: string;
  domain: string;
  verified_by: string;
  verified_at: string;
  note: string | null;
  created_at: string;
}

export const LINK_COLUMNS =
  'id, organization_id, client_id, entity_kind, entity_id, entity_ref, entity_key, label, occurred_at, state, method, evidence, confidence, confirmed_by, confirmed_at, rejected_by, rejected_at, rejected_reason, created_by, created_at, updated_at';

export interface LinkRow {
  id: string;
  organization_id: string;
  client_id: string;
  entity_kind: LinkEntityKind;
  entity_id: string | null;
  entity_ref: string | null;
  entity_key: string | null;
  label: string | null;
  occurred_at: string | null;
  state: LinkState;
  method: LinkMethod;
  evidence: string | null;
  confidence: number | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejected_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Filled by `hydrate`; never selected. */
  client_name?: string | null;
}

export const linkSchema = z.object({
  id: z.string(),
  kind: z.enum(LINK_ENTITY_KINDS),
  kindLabel: z.string(),
  label: z.string().nullable().describe('What the thing is called — a title, a subject, a plate'),
  occurredAt: z.string().nullable(),
  state: z.enum(LINK_STATES),
  stateLabel: z.string(),
  method: z.enum(LINK_METHODS),
  methodLabel: z.string(),
  why: z.string().describe('Why Cortex says this belongs to the client, in one sentence'),
  evidence: z.string().nullable().describe('The literal thing that justified it'),
});

export type Link = z.infer<typeof linkSchema>;

export function adaptLink(row: LinkRow): Link {
  return {
    id: row.id,
    kind: row.entity_kind,
    kindLabel: ENTITY_KIND_LABEL[row.entity_kind] ?? row.entity_kind,
    label: row.label,
    occurredAt: row.occurred_at,
    state: row.state,
    stateLabel: LINK_STATE_LABEL[row.state] ?? row.state,
    method: row.method,
    methodLabel: METHOD_LABEL[row.method] ?? row.method,
    why: METHOD_SENTENCE[row.method] ?? '',
    evidence: row.evidence,
  };
}

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

/** The minimum a client's identity has to be for `matchByText` to look at it. */
const MIN_NAME_LENGTH = 4;

export interface Candidate {
  clientId: string;
  method: LinkMethod;
  /** The literal thing that justified it. */
  evidence: string;
  confidence: number;
}

export interface MatchResult {
  /** Every client the text could plausibly be about, strongest first. */
  candidates: Candidate[];
  /**
   * The one answer, or null.
   *
   * Null means EITHER nothing matched OR nothing matched CLEARLY — and the
   * caller is not told which, on purpose: both outcomes lead to the same
   * action, which is to write nothing. "Clearly" means the strongest candidate
   * is strictly stronger than the next one, so "Coltrans Logística" beating
   * "Coltrans" on an exact match is an answer, and two clients matching the
   * same way is not.
   */
  only: Candidate | null;
  ambiguous: boolean;
}

export interface MatchableClient {
  id: string;
  name: string;
  legal_name?: string | null;
  tax_id?: string | null;
}

/**
 * Which client, if any, a piece of free text is about.
 *
 * Used for `commitments.counterparty` — a short field somebody typed — and for
 * titles and subjects. NEVER used to apply a link on its own: every method it
 * can return is outside `APPLYING_METHODS`, so the strongest thing a caller can
 * do with the result is propose it.
 *
 * The one rule that matters is the last one: TWO CANDIDATES MEANS NO ANSWER.
 * `only` is null whenever more than one client matched, so a caller that
 * follows the obvious shape (`if (match.only) …`) is correct by construction
 * and a caller that wants to show the ambiguity has to ask for `candidates`
 * explicitly.
 */
export function matchByText(text: string | null | undefined, clients: MatchableClient[]): MatchResult {
  const raw = (text ?? '').trim();
  if (!raw) return { candidates: [], only: null, ambiguous: false };

  const digits = raw.replace(/\D/g, '');
  const key = nameKey(raw);
  const strict = strictNameKey(raw);
  const haystack = ` ${tokenize(raw).join(' ')} `;

  const byClient = new Map<string, Candidate>();
  const keep = (candidate: Candidate) => {
    const current = byClient.get(candidate.clientId);
    if (!current || candidate.confidence > current.confidence) {
      byClient.set(candidate.clientId, candidate);
    }
  };

  for (const client of clients) {
    // 1. The NIT, quoted verbatim. Strong, and still only a proposal: a customs
    //    document names the importer, the carrier and the SIA by NIT, and only
    //    one of them is whose document it is.
    if (client.tax_id && client.tax_id.length >= 8 && digits.includes(client.tax_id)) {
      keep({
        clientId: client.id,
        method: 'tax_id',
        evidence: `NIT ${fullNit(client.tax_id)}`,
        confidence: METHOD_CONFIDENCE.tax_id,
      });
      continue;
    }

    // 2. The whole name, once the suffixes and the punctuation are gone.
    const names = [client.name, client.legal_name].filter(Boolean) as string[];
    const exact = names.some((n) => {
      const nk = nameKey(n);
      return nk.length >= MIN_NAME_LENGTH && (nk === key || strictNameKey(n) === strict);
    });
    if (exact) {
      keep({
        clientId: client.id,
        method: 'name_exact',
        evidence: raw.slice(0, 200),
        confidence: METHOD_CONFIDENCE.name_exact,
      });
      continue;
    }

    // 3. The name as a whole WORD inside a longer phrase. Word-bounded rather
    //    than substring: "Coltrans" must not match inside "Multicoltransa",
    //    and a three-letter name must not match at all — which is what
    //    MIN_NAME_LENGTH is for.
    const partial = names.some((n) => {
      const words = tokenize(n).filter(
        (w) => w.length >= MIN_NAME_LENGTH && !LEGAL_SUFFIXES.has(w),
      );
      return words.length > 0 && words.every((w) => haystack.includes(` ${w} `));
    });
    if (partial) {
      keep({
        clientId: client.id,
        method: 'name_partial',
        evidence: raw.slice(0, 200),
        confidence: METHOD_CONFIDENCE.name_partial,
      });
    }
  }

  const candidates = [...byClient.values()].sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0] ?? null;
  const runnerUp = candidates[1] ?? null;
  // A tie is not a winner. Two clients matched the same way means the text does
  // not distinguish them, and picking either would be a coin toss filed as a
  // fact.
  const decided = best !== null && (runnerUp === null || best.confidence > runnerUp.confidence);
  return { candidates, only: decided ? best : null, ambiguous: candidates.length > 1 };
}
