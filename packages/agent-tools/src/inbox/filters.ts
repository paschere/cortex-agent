/**
 * Pure heuristics for separating real correspondence from bulk mail.
 *
 * Kept free of I/O on purpose: what gets dropped from someone's digest is the
 * part of this feature they have to trust, so it has to be inspectable and
 * unit-testable — and every exclusion is reported back with its reason rather
 * than silently disappearing.
 */

export interface MailHeader {
  name: string;
  value: string;
}

export interface Address {
  name: string | null;
  email: string;
}

/** `"Ada Lovelace" <ada@example.com>` → { name, email }. */
export function parseAddress(raw: string): Address | null {
  const s = raw.trim();
  if (!s) return null;
  const angled = s.match(/^(.*)<([^>]+)>\s*$/);
  if (angled) {
    const name = (angled[1] ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();
    const email = (angled[2] ?? '').trim().toLowerCase();
    if (!email) return null;
    return { name: name || null, email };
  }
  if (!s.includes('@')) return null;
  return { name: null, email: s.toLowerCase() };
}

export function parseAddressList(raw: string | null | undefined): Address[] {
  if (!raw) return [];
  // Split on commas that are not inside a quoted display name.
  const parts: string[] = [];
  let buf = '';
  let quoted = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map(parseAddress).filter((a): a is Address => a !== null);
}

export function headerValue(headers: MailHeader[], name: string): string | null {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? null;
}

/** Display label for a person: their name when we have it, else the address. */
export function displayName(address: Address | null): string {
  if (!address) return 'unknown sender';
  return address.name ?? address.email;
}

// ---------------------------------------------------------------------------
// Bulk / newsletter detection
// ---------------------------------------------------------------------------

/**
 * Local-parts that essentially never belong to a human waiting for a reply.
 * Deliberately narrow: `info@`, `support@` and `hello@` are REAL inboxes at
 * small clients and are not listed — dropping a client's mail from their own
 * digest is far worse than leaving one newsletter in.
 */
const ROBOT_LOCAL_PARTS =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer|mailer-daemon|bounce[sd]?|postmaster|newsletters?|marketing|campaign|noreply-\w+|automated|autoresponder|alerts?|digest|updates)([-+.].*)?$/i;

/** Sending domains that only ever carry campaign traffic. */
const BULK_DOMAINS =
  /(^|\.)((mailchimp|mailchimpapp|sendgrid|mandrillapp|sparkpostmail|amazonses|mailgun|cmail\d*|createsend|hubspotemail|marketo|pardot|salesforce-?email|substack|beehiiv|convertkit|klaviyomail|sendinblue|brevo)\.(com|net|io|org))$/i;

/** Gmail's own categories that are, by construction, not correspondence. */
const BULK_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'SPAM']);

export interface BulkVerdict {
  bulk: boolean;
  /** Plain-language reason, shown to the user so the filtering is auditable. */
  reason: string | null;
}

export interface BulkCheckInput {
  headers: MailHeader[];
  labelIds: string[];
  from: Address | null;
}

export function classifyBulk({ headers, labelIds, from }: BulkCheckInput): BulkVerdict {
  const label = labelIds.find((l) => BULK_LABELS.has(l));
  if (label) {
    const pretty =
      label === 'SPAM'
        ? 'Gmail marked it as spam'
        : `Gmail filed it under ${label.replace('CATEGORY_', '').toLowerCase()}`;
    return { bulk: true, reason: pretty };
  }

  if (headerValue(headers, 'List-Unsubscribe')) {
    return { bulk: true, reason: 'it is a mailing list or newsletter (has an unsubscribe link)' };
  }
  if (headerValue(headers, 'List-Id')) {
    return { bulk: true, reason: 'it was sent to a mailing list' };
  }

  const precedence = headerValue(headers, 'Precedence')?.toLowerCase() ?? '';
  if (['bulk', 'list', 'junk'].includes(precedence.trim())) {
    return { bulk: true, reason: 'it was sent as bulk mail' };
  }

  const autoSubmitted = headerValue(headers, 'Auto-Submitted')?.toLowerCase() ?? '';
  if (autoSubmitted && autoSubmitted.trim() !== 'no') {
    return { bulk: true, reason: 'it was generated automatically' };
  }

  if (headerValue(headers, 'X-Campaign-Id') || headerValue(headers, 'X-Mailer-Campaign')) {
    return { bulk: true, reason: 'it is part of a marketing campaign' };
  }

  if (from) {
    const at = from.email.lastIndexOf('@');
    const local = at === -1 ? from.email : from.email.slice(0, at);
    const domain = at === -1 ? '' : from.email.slice(at + 1);
    if (ROBOT_LOCAL_PARTS.test(local)) {
      return { bulk: true, reason: `it comes from an unattended address (${from.email})` };
    }
    if (BULK_DOMAINS.test(domain)) {
      return { bulk: true, reason: `it was sent through a bulk mail provider (${domain})` };
    }
  }

  return { bulk: false, reason: null };
}

/** One line the user can read to understand what was left out and why. */
export function summarizeExclusions(reasons: string[]): string {
  if (reasons.length === 0) return 'Nothing was filtered out.';
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} because ${reason}`);
  return `${reasons.length} conversation${reasons.length === 1 ? '' : 's'} left out: ${parts.join('; ')}.`;
}
