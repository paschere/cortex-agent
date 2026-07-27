/**
 * Deterministic risk model for tool calls.
 *
 * This module is PURE: no I/O, no db, no clock beyond an injectable `now`.
 * That is deliberate — enforcement runs inside `runTool` on every single call
 * (web chat, MCP, scheduled jobs) and must never depend on the model choosing
 * to consult it. Keeping the classifier pure also makes the whole matrix
 * unit-testable without a database.
 *
 * POSTURE: flag first, block almost never. Zippy has to stay useful, so the
 * guardrail's job is to make risk visible and reviewable — not to stop people
 * working. Ordinary reads, writes and drafts pass with no friction at all.
 * The category actually worth watching is EXPORT: pulling a body of data out
 * of a system (bulk roster or compensation exports, full candidate lists,
 * client data dumps, reports over sensitive datasets) and especially anything
 * that then leaves the company. See `decide()` for the exact rules.
 *
 * Two axes are combined into a level:
 *
 *   DATA SENSITIVITY — what the tool touches
 *     financial : compensation, pay rates, payroll, personal financial data
 *     pii       : candidate PII, interview content, personal mailboxes
 *     client    : client contractual / CRM data
 *     internal  : internal knowledge, tickets, calendars, repos
 *     public    : public web data
 *
 *   BLAST RADIUS — what the call can do
 *     read           : read-only, stays in-app
 *     internal_write : writes to an internal system
 *     external_send  : content leaves the company (email send, Slack post,
 *                      anything client-facing)
 *     bulk           : bulk / whole-roster operation
 */

export type Sensitivity = 'public' | 'internal' | 'client' | 'pii' | 'financial';
export type BlastRadius = 'read' | 'internal_write' | 'external_send' | 'bulk';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type Decision = 'allow' | 'confirm' | 'block';
export type Surface = 'web' | 'mcp' | 'schedule';

export type RiskSignal =
  | 'bulk-read'
  | 'external-recipient'
  | 'compensation-in-payload'
  | 'personal-id-in-payload'
  | 'off-hours'
  | 'high-frequency'
  | 'unattended';

export interface Classification {
  riskLevel: RiskLevel;
  reason: string;
  signals: RiskSignal[];
  sensitivity: Sensitivity;
  blastRadius: BlastRadius;
}

export interface SecurityPolicy {
  /** critical calls are refused outright rather than merely flagged. */
  blockCritical: boolean;
  /** trailing-hour budget for sensitive reads before `high-frequency` fires. */
  sensitiveReadsPerHour: number;
  /**
   * When true (default), content addressed to someone outside zipdev.com asks
   * for confirmation before it goes — at any risk level. One click, then it
   * sends; emailing clients and candidates is the business, so this is a
   * speed-bump, never a refusal. Turn it off and outbound sends are merely
   * flagged.
   *
   * Note the other interactive speed-bump — a bulk export of compensation or
   * candidate data with a human present — always asks, independently of this
   * flag, and its unattended equivalent is blocked outright.
   */
  externalSendRequiresConfirmation: boolean;
}

export const DEFAULT_POLICY: SecurityPolicy = {
  blockCritical: true,
  sensitiveReadsPerHour: 40,
  externalSendRequiresConfirmation: true,
};

/** Domains that count as "inside the company" for blast-radius purposes. */
export const INTERNAL_DOMAINS = ['zipdev.com'];

/** limit/page-size at or above which a read is treated as a bulk export. */
export const BULK_THRESHOLD = 200;

/** Working hours in America/Bogota; outside these the `off-hours` signal fires. */
export const WORK_HOURS = { start: 6, end: 22 };

// ---------------------------------------------------------------------------
// Family defaults
// ---------------------------------------------------------------------------

/**
 * Sensitivity by tool-id family (the part before the first dot). Unknown
 * families default to `client` — deliberately conservative, because external
 * MCP tools register ids we have never seen.
 */
const FAMILY_SENSITIVITY: Record<string, Sensitivity> = {
  payroll: 'financial',
  rate: 'financial',
  recruit: 'pii',
  workable: 'pii',
  people: 'pii',
  gmail: 'pii',
  hubspot: 'client',
  growth: 'client',
  sales: 'client',
  gdrive: 'client',
  gsheets: 'client',
  kb: 'internal',
  linear: 'internal',
  github: 'internal',
  gcal: 'internal',
  slack: 'internal',
  schedule: 'internal',
  pipeline: 'internal',
  zippy: 'internal',
  security: 'internal',
  web: 'public',
};

const DEFAULT_FAMILY_SENSITIVITY: Sensitivity = 'client';

/** Families whose reads count toward the trailing-hour sensitive-read budget. */
export const SENSITIVE_FAMILIES = Object.entries(FAMILY_SENSITIVITY)
  .filter(([, s]) => s === 'financial' || s === 'pii')
  .map(([f]) => f);

interface ToolOverride {
  sensitivity?: Sensitivity;
  blastRadius?: BlastRadius;
  /**
   * The tool actually delivers content to a destination. An external address
   * in the payload pushes it to `external_send`. Only true for tools where
   * something really leaves the company — a *draft* does not.
   */
  deliversContent?: boolean;
  /**
   * Recipients are enumerable from the payload, so "everyone named is
   * @zipdev.com" is a reliable signal that nothing is leaving. Lets an
   * inherently-outbound tool relax back to an internal write. Not true of
   * channel-based destinations (a Slack channel may be shared with a client).
   */
  recipientsExplicit?: boolean;
  /** Read returns the whole roster/dataset regardless of arguments. */
  alwaysBulk?: boolean;
}

/**
 * Per-tool overrides. Only tools whose risk differs from the family + verb
 * heuristic need an entry here.
 */
const TOOL_OVERRIDES: Record<string, ToolOverride> = {
  // --- content that can leave the company -----------------------------------
  // Sending is outbound by default, but a mail addressed only to colleagues is
  // an internal write — enumerable recipients let us tell the difference.
  //
  // Sensitivity is pinned to `client`, NOT the gmail family default of `pii`.
  // The family default describes a mailbox you READ (full of personal mail);
  // an outgoing message is an ordinary business email until its payload proves
  // otherwise. Emailing clients and candidates is the job — it must not be
  // treated as an exfiltration attempt. The `compensation-in-payload` and
  // `personal-id-in-payload` signals are what escalate a send to critical.
  'gmail.send_draft': {
    sensitivity: 'client',
    blastRadius: 'external_send',
    deliversContent: true,
    recipientsExplicit: true,
  },
  // Creating a draft delivers nothing: it sits in the author's mailbox until a
  // human sends it. Gating it would be friction with no exposure.
  'gmail.draft': { blastRadius: 'internal_write' },
  // A channel is opaque — Slack Connect channels include client guests — so a
  // post always counts as leaving the company.
  'slack.post_message': { blastRadius: 'external_send', deliversContent: true },
  // Sheets can be shared outside; an external address in the payload says so.
  'gsheets.append_row': { blastRadius: 'internal_write', deliversContent: true },
  // A calendar write is internal bookkeeping; the invite email is a side effect
  // that carries no payload of ours.
  'gcal.create_event': { blastRadius: 'internal_write' },
  'recruit.generate_presentation': { sensitivity: 'pii', blastRadius: 'internal_write' },
  'sales.draft_proposal': { sensitivity: 'client', blastRadius: 'internal_write' },

  // --- payroll: aggregates are the SAFE way to look at compensation ---------
  // Rollups (headcount by division, totals, projections) carry no per-person
  // figures, so they stay ordinary sensitive reads. Only the per-person roster
  // dump counts as bulk.
  'payroll.team_assignments': { sensitivity: 'pii', alwaysBulk: true },

  // --- rate tools carry pay/bill rates but are calculators, not payroll ------
  'rate.estimate': { sensitivity: 'financial', blastRadius: 'read' },
  'rate.estimate_from_document': { sensitivity: 'financial', blastRadius: 'read' },

  // --- the security tools themselves are read-only introspection ------------
  'security.review_action': { sensitivity: 'internal', blastRadius: 'read' },
  'security.recent_events': { sensitivity: 'internal', blastRadius: 'read' },
};

// Verbs that indicate a write when they lead the tool's action segment.
// Unknown/external MCP tools are read by default and land here only on an
// explicit write verb.
const WRITE_VERBS = [
  'create',
  'update',
  'delete',
  'remove',
  'move',
  'log',
  'append',
  'post',
  'push',
  'publish',
  'share',
  'export',
  'upload',
  'sync',
  'write',
  'send',
  'run',
  'finish',
  'ingest',
  'draft',
  'generate',
  'set',
  'add',
  'archive',
];

export function familyOf(toolId: string): string {
  const dot = toolId.indexOf('.');
  return dot === -1 ? toolId : toolId.slice(0, dot);
}

export function sensitivityOf(toolId: string): Sensitivity {
  const override = TOOL_OVERRIDES[toolId]?.sensitivity;
  if (override) return override;
  return FAMILY_SENSITIVITY[familyOf(toolId)] ?? DEFAULT_FAMILY_SENSITIVITY;
}

/** True when this tool's reads count toward the sensitive-read budget. */
export function isSensitiveFamily(toolId: string): boolean {
  const s = sensitivityOf(toolId);
  return s === 'financial' || s === 'pii';
}

function baseBlastRadius(toolId: string): BlastRadius {
  const override = TOOL_OVERRIDES[toolId]?.blastRadius;
  if (override) return override;
  const action = toolId.slice(toolId.indexOf('.') + 1);
  const verb = action.split('_')[0] ?? '';
  return WRITE_VERBS.includes(verb) ? 'internal_write' : 'read';
}

// ---------------------------------------------------------------------------
// Risk matrix
// ---------------------------------------------------------------------------

/**
 * sensitivity x blast radius -> level.
 *
 *                read        internal_write  external_send  bulk
 *   public       low         low             medium         low
 *   internal     low         low             medium         medium
 *   client       low         medium          high           high
 *   pii          medium      medium          CRITICAL       high
 *   financial    medium      high            CRITICAL       high
 *
 * The two critical cells are the only ones that block, and they say the same
 * thing twice: compensation or identity data leaving the company. Note that
 * `pii`/`financial` sensitivity on a SEND is reached through the payload
 * signals, not the tool family — an ordinary outbound email is `client`.
 *
 * Everything in the `bulk` column is the export category the business actually
 * wants watched; it is high, which means flagged, or gated when a human is
 * there to answer.
 */
const MATRIX: Record<Sensitivity, Record<BlastRadius, RiskLevel>> = {
  public: { read: 'low', internal_write: 'low', external_send: 'medium', bulk: 'low' },
  internal: { read: 'low', internal_write: 'low', external_send: 'medium', bulk: 'medium' },
  client: { read: 'low', internal_write: 'medium', external_send: 'high', bulk: 'high' },
  pii: { read: 'medium', internal_write: 'medium', external_send: 'critical', bulk: 'high' },
  financial: { read: 'medium', internal_write: 'high', external_send: 'critical', bulk: 'high' },
};

const LEVEL_ORDER: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

const SENSITIVITY_ORDER: Sensitivity[] = ['public', 'internal', 'client', 'pii', 'financial'];

export function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITY_ORDER.indexOf(a) >= SENSITIVITY_ORDER.indexOf(b) ? a : b;
}

export function bumpLevel(level: RiskLevel, by = 1): RiskLevel {
  const i = Math.min(LEVEL_ORDER.indexOf(level) + by, LEVEL_ORDER.length - 1);
  return LEVEL_ORDER[i] as RiskLevel;
}

export function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Payload inspection
// ---------------------------------------------------------------------------

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

// Matches both field names (`hourly_rate`) and prose ("their hourly rate"), so
// a separator class that includes whitespace is load-bearing here.
const COMP_KEY_RE =
  /salary|salario|sueldo|compensation|compensaci[oó]n|payroll|n[oó]mina|pay[\s_-]?rate|hourly[\s_-]?rate|bill[\s_-]?rate|wage|bonus|stipend|remuneration|cost[\s_-]?per|monthly[\s_-]?cost/i;

/**
 * STRONG identity documents and financial identifiers only — the things that
 * enable identity theft, not merely "this is about a person".
 *
 * Deliberately narrow. Names, emails and phone numbers are the everyday
 * substance of recruiting and must never trip this: Zipdev's whole business is
 * emailing candidates and clients about people. A passport or bank account
 * number leaving the company is a different thing entirely.
 */
const PERSONAL_ID_RE =
  /\b(ssn|social[\s_-]?security|passport|national[\s_-]?id|identity[\s_-]?document|dni|curp|rfc|cedula|c[eé]dula|date[\s_-]?of[\s_-]?birth|birth[\s_-]?date|dob|bank[\s_-]?account|account[\s_-]?number|iban|swift|routing[\s_-]?number|tax[\s_-]?id|clabe)\b/i;

const LIMIT_KEY_RE = /^(limit|page_?size|per_?page|count|max|max_?results|top|first|take|rows)$/i;

const BULK_FLAG_RE = /^(all|export|full|include_?all|download_?all)$/i;

const DOMAIN_KEY_RE =
  /^(domain|host|hostname|website|site|to|recipient|recipients|channel_?email)$/i;

interface Walked {
  strings: string[];
  keys: string[];
  /** numeric values of limit-ish keys */
  limits: number[];
  bulkFlag: boolean;
  domainish: string[];
}

/** Depth-limited walk over the input so a deep/hostile payload can't stall us. */
function walk(input: unknown): Walked {
  const out: Walked = { strings: [], keys: [], limits: [], bulkFlag: false, domainish: [] };
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number, key?: string) => {
    if (depth > 6 || out.strings.length > 500) return;
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      out.strings.push(node.length > 4000 ? node.slice(0, 4000) : node);
      if (key && DOMAIN_KEY_RE.test(key)) out.domainish.push(node);
      return;
    }
    if (typeof node === 'number') {
      if (key && LIMIT_KEY_RE.test(key)) out.limits.push(node);
      return;
    }
    if (typeof node === 'boolean') {
      if (node && key && BULK_FLAG_RE.test(key)) out.bulkFlag = true;
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1, key);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out.keys.push(k);
      visit(v, depth + 1, k);
    }
  };
  visit(input, 0);
  return out;
}

function isInternalAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  const domain = (at === -1 ? address : address.slice(at + 1))
    .toLowerCase()
    .replace(/[.,;>)\]]+$/, '');
  return INTERNAL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function hasExternalRecipient(w: Walked): boolean {
  for (const s of w.strings) {
    const matches = s.match(EMAIL_RE);
    if (matches) {
      for (const m of matches) if (!isInternalAddress(m)) return true;
    }
  }
  for (const d of w.domainish) {
    if (d.includes('@')) continue; // already covered by the email scan
    const bare =
      d
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .split('/')[0] ?? '';
    if (bare?.includes('.') && !isInternalAddress(bare)) return true;
  }
  return false;
}

function hasCompensationPayload(w: Walked, sensitivity: Sensitivity): boolean {
  if (sensitivity === 'financial') return true;
  if (w.keys.some((k) => COMP_KEY_RE.test(k))) return true;
  return w.strings.some((s) => COMP_KEY_RE.test(s));
}

function hasPersonalIdPayload(w: Walked): boolean {
  if (w.keys.some((k) => PERSONAL_ID_RE.test(k))) return true;
  return w.strings.some((s) => PERSONAL_ID_RE.test(s));
}

function isBulk(w: Walked, override: ToolOverride | undefined): boolean {
  if (override?.alwaysBulk) return true;
  if (w.bulkFlag) return true;
  return w.limits.some((n) => n >= BULK_THRESHOLD);
}

/** Hour of day in America/Bogota (fixed UTC-5, no DST). */
export function bogotaHour(now: Date): number {
  return new Date(now.getTime() - 5 * 3600_000).getUTCHours();
}

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

export interface ClassifyCtx {
  /** the call is already user-confirmed for this turn */
  confirmed?: boolean;
  /** injectable clock — keeps classify() deterministic in tests */
  now?: Date;
  /** signals computed with I/O elsewhere (currently only `high-frequency`) */
  extraSignals?: RiskSignal[];
}

export interface ClassifyArgs {
  tool: { id: string; requiresConfirmation?: boolean };
  input: unknown;
  ctx?: ClassifyCtx;
  surface?: Surface;
}

const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  financial: 'compensation / payroll data',
  pii: 'personal or candidate data',
  client: 'client business data',
  internal: 'internal data',
  public: 'public data',
};

const BLAST_LABEL: Record<BlastRadius, string> = {
  read: 'a read-only lookup',
  internal_write: 'a write to an internal system',
  external_send: 'content leaving the company',
  bulk: 'a bulk / whole-roster operation',
};

/**
 * Classify a tool call. Pure — safe to call from a tool handler, a test, or
 * the enforcement hook.
 */
export function classify({ tool, input, ctx, surface = 'web' }: ClassifyArgs): Classification {
  const override = TOOL_OVERRIDES[tool.id];
  const w = walk(input);
  const signals = new Set<RiskSignal>(ctx?.extraSignals ?? []);

  let sensitivity = sensitivityOf(tool.id);
  let blastRadius = baseBlastRadius(tool.id);

  // --- signals -------------------------------------------------------------
  if (hasCompensationPayload(w, sensitivity)) {
    signals.add('compensation-in-payload');
    // Compensation in the payload drags any tool up to financial sensitivity:
    // a Slack post carrying salaries is a payroll leak, whatever the family.
    sensitivity = 'financial';
  }

  // Identity documents / bank details are the other payload that must never
  // leave the company. Unlike compensation this does NOT fire on names or
  // emails, so ordinary candidate and client correspondence is untouched.
  else if (hasPersonalIdPayload(w)) {
    signals.add('personal-id-in-payload');
    sensitivity = maxSensitivity(sensitivity, 'pii');
  }

  const external = hasExternalRecipient(w);
  if (external) signals.add('external-recipient');

  if (isBulk(w, override)) {
    signals.add('bulk-read');
    // bulk outranks read but never downgrades an outbound send.
    if (blastRadius === 'read' || blastRadius === 'internal_write') blastRadius = 'bulk';
  }

  // A content-delivering tool becomes an external send once the payload names
  // someone outside the company — and, where recipients are enumerable, relaxes
  // back to an internal write when everyone named is a colleague.
  if (override?.deliversContent) {
    if (external) blastRadius = 'external_send';
    else if (override.recipientsExplicit) blastRadius = 'internal_write';
  }

  if (surface === 'schedule') signals.add('unattended');

  const now = ctx?.now ?? new Date();
  const hour = bogotaHour(now);
  if (hour < WORK_HOURS.start || hour >= WORK_HOURS.end) signals.add('off-hours');

  // --- level ---------------------------------------------------------------
  let riskLevel = MATRIX[sensitivity][blastRadius];
  const reasons: string[] = [`${SENSITIVITY_LABEL[sensitivity]} via ${BLAST_LABEL[blastRadius]}`];

  // Unattended is the aggravating factor: a bulk export of compensation or
  // personal data with nobody in the loop, or anything leaving the company on
  // a schedule, is the worst case we model — no one can catch it before it
  // lands. The same call with a human present is only gated.
  if (
    signals.has('unattended') &&
    (blastRadius === 'external_send' ||
      (blastRadius === 'bulk' && (sensitivity === 'financial' || sensitivity === 'pii')))
  ) {
    riskLevel = 'critical';
    reasons.push('running unattended on a schedule with no human able to intervene');
  }

  // Sustained sensitive-read volume looks like scraping; escalate one level.
  if (signals.has('high-frequency')) {
    riskLevel = bumpLevel(riskLevel);
    reasons.push('unusual volume of sensitive reads in the last hour');
  }

  // Deliberately recorded but never escalating: legitimate work happens at
  // night, and a clock-dependent escalation would make enforcement (and tests)
  // non-deterministic. It earns its keep as context on a flagged event.
  if (signals.has('off-hours')) reasons.push('outside normal working hours in Bogota');

  return {
    riskLevel,
    reason: reasons.join('; '),
    signals: [...signals].sort(),
    sensitivity,
    blastRadius,
  };
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

/**
 * Posture: FLAG FIRST. The guardrail exists to make risk visible and
 * reviewable, not to stop people working — friction is reserved for actions
 * that are genuinely dangerous.
 *
 *   critical → block   (sensitive data leaving the company; unattended bulk
 *                       export of financial/PII data)
 *   high     → allow, but flagged loudly — EXCEPT a bulk export of sensitive
 *              data with a human present, which asks for confirmation first
 *   medium   → allow, flagged; an outbound external send still asks
 *   low      → allow
 */
export function decide(c: Classification, policy: SecurityPolicy = DEFAULT_POLICY): Decision {
  if (c.riskLevel === 'critical') return policy.blockCritical ? 'block' : 'confirm';

  if (c.riskLevel === 'high') {
    // Pulling a body of sensitive data out of the systems is the one high-risk
    // shape worth a prompt — and only when someone is there to answer it.
    const sensitiveBulkExport =
      c.blastRadius === 'bulk' &&
      (c.sensitivity === 'financial' || c.sensitivity === 'pii') &&
      !c.signals.includes('unattended');
    if (sensitiveBulkExport) return 'confirm';

    if (
      policy.externalSendRequiresConfirmation &&
      c.blastRadius === 'external_send' &&
      c.signals.includes('external-recipient')
    ) {
      return 'confirm';
    }
    return 'allow';
  }

  if (c.riskLevel === 'medium') {
    if (
      policy.externalSendRequiresConfirmation &&
      c.blastRadius === 'external_send' &&
      c.signals.includes('external-recipient')
    ) {
      return 'confirm';
    }
    return 'allow';
  }
  return 'allow';
}

// ---------------------------------------------------------------------------
// User-facing explanation
// ---------------------------------------------------------------------------

/**
 * Plain-language refusal the model can relay verbatim: what was blocked, why,
 * and what the human should do instead. No policy keys, no thresholds, no
 * internals.
 */
function subjectOf(c: Classification): string {
  if (c.sensitivity === 'financial') return 'compensation and payroll information';
  if (c.sensitivity === 'pii') {
    return c.signals.includes('personal-id-in-payload')
      ? 'personal identity or bank details'
      : 'personal candidate information';
  }
  if (c.sensitivity === 'client') return 'client business information';
  return 'internal company information';
}

export function explainBlock(c: Classification): string {
  const what = subjectOf(c);
  const why = c.signals.includes('external-recipient')
    ? `it would send ${what} to someone outside Zipdev`
    : c.signals.includes('unattended')
      ? `it would export ${what} automatically, with nobody reviewing it`
      : `it would move ${what} outside its normal boundary`;

  return [
    `I can't run that one. It's blocked because ${why},`,
    "and that's not something I'm allowed to do on my own.",
    'If this needs to happen, an org admin can review and run it directly from Zipdev OS —',
    "or tell me an internal-only version of the same request and I'll do that instead.",
  ].join(' ');
}

/**
 * The heads-up attached to a successful but risky result. Written for the model
 * to relay in its own words: what the action touched and that it is on the
 * record. It is a notice, not a warning to argue with — the action already ran.
 */
export function explainFlag(c: Classification): string {
  const what = subjectOf(c);
  const scope =
    c.blastRadius === 'bulk'
      ? `this pulled ${what} in bulk`
      : c.blastRadius === 'external_send'
        ? `this sent ${what} outside the company`
        : `this touched ${what}`;

  const extra = c.signals.includes('high-frequency')
    ? ' It also follows an unusual number of sensitive lookups in the last hour.'
    : '';

  return (
    `Heads-up: ${scope}. It went through, and it is recorded in the audit log ` +
    `where an admin can review it.${extra} Share the result only with the person who asked.`
  );
}

/** Short sentence for the confirmation prompt / audit UI. */
export function explainConfirm(c: Classification): string {
  return `This is a ${c.riskLevel}-risk action (${c.reason}). Confirm before I run it.`;
}
