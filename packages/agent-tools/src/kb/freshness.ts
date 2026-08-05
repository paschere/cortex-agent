/**
 * How old a citation is, and whether it is still supposed to be true.
 *
 * WHY THIS IS NOT AN EXPIRY ENGINE. The temptation with stale knowledge is to
 * build one: rules per document type, a job that sweeps, a `current` flag that
 * something has to keep correct. That machine would be wrong the day somebody
 * files a contract three months late, and its failure mode is the bad one —
 * a document silently stops being retrievable and nobody finds out until an
 * answer is missing rather than wrong.
 *
 * So nothing here removes anything. A hit that expired last year still comes
 * back from the search; it comes back carrying "venció el 31 de enero de 2026".
 * The model reads Spanish and can weigh that perfectly well, and the person
 * gets "your policy expired in January" instead of silence — which is the
 * answer they actually needed.
 *
 * The date used is the document's OWN date (`recorded_at` when there is one,
 * otherwise `created_at`), never the upload time. A call recorded in March and
 * uploaded in July is March-old.
 */

/**
 * Six months, then a year. These are not properties of the corpus, they are
 * properties of the documents in it: rates, policies and playbooks get revised
 * on an annual cycle, so half a year is the point where "check this is still
 * current" starts being worth saying out loud, and a year is the point where
 * it stops being a caveat and becomes the main thing about the citation.
 */
const AGING_DAYS = 180;
const OLD_DAYS = 365;

export type FreshnessStatus =
  /** Recent enough to quote as it stands. */
  | 'current'
  /** Old enough to be worth a "confírmalo" next to the number. */
  | 'aging'
  /** Old enough that its age is part of the answer. */
  | 'old'
  /** The document itself said it stopped being valid, and that date has passed. */
  | 'expired'
  /** Somebody filed a replacement for it. */
  | 'superseded';

export interface Freshness {
  status: FreshnessStatus;
  /** Whole days between the document's own date and now. Null when undated. */
  ageDays: number | null;
  /**
   * Spanish, ready to drop straight into a citation: "de hace 5 meses",
   * "venció el 31 de enero de 2026", "reemplazado por «Tarifas 2026»".
   * Empty only when the document has no date at all and nothing replaced it.
   */
  label: string;
}

export interface FreshnessInput {
  /** The document's own date — `recorded_at` if it has one, else `created_at`. */
  datedAt?: string | null;
  validUntil?: string | null;
  supersededByTitle?: string | null;
  now?: Date;
}

const DAY_MS = 86_400_000;

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "31 de enero de 2026" — the way a date is read out loud in Colombia. */
export function formatDateEs(date: Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * "hace 3 días", "hace 5 meses", "hace 2 años". Deliberately coarse: the
 * difference between 400 and 430 days old changes nothing about how much a
 * rate should be trusted, and a precise number invites false precision.
 */
export function describeAge(ageDays: number): string {
  if (ageDays <= 0) return 'de hoy';
  if (ageDays === 1) return 'de ayer';
  if (ageDays < 30) return `de hace ${ageDays} días`;
  const months = Math.round(ageDays / 30);
  if (ageDays < 365) return months <= 1 ? 'de hace un mes' : `de hace ${months} meses`;
  const years = Math.floor(ageDays / 365);
  const remainder = ageDays - years * 365;
  if (remainder >= 180) {
    return `de hace más de ${years === 1 ? 'un año y medio' : `${years} años y medio`}`;
  }
  return years === 1 ? 'de hace un año' : `de hace ${years} años`;
}

export function assessFreshness({
  datedAt,
  validUntil,
  supersededByTitle,
  now = new Date(),
}: FreshnessInput): Freshness {
  const dated = parse(datedAt);
  const ageDays = dated === null ? null : Math.floor((now.getTime() - dated.getTime()) / DAY_MS);
  const age = ageDays === null ? '' : describeAge(ageDays);

  // Replacement beats expiry beats age, because that is the order in which
  // they answer the question. "Somebody filed a newer one" tells you where to
  // look next; "it expired" tells you it is over; age only tells you to check.
  if (supersededByTitle) {
    return {
      status: 'superseded',
      ageDays,
      label: `reemplazado por «${supersededByTitle}»${age ? `; este es ${age}` : ''}`,
    };
  }

  const until = parse(validUntil);
  if (until && until.getTime() < now.getTime()) {
    return { status: 'expired', ageDays, label: `venció el ${formatDateEs(until)}` };
  }

  if (ageDays === null) return { status: 'current', ageDays: null, label: '' };
  if (ageDays >= OLD_DAYS) return { status: 'old', ageDays, label: age };
  if (ageDays >= AGING_DAYS) return { status: 'aging', ageDays, label: age };
  return { status: 'current', ageDays, label: age };
}

/** True for the two statuses a model should never quote in the present tense. */
export function isSuperseded(status: FreshnessStatus): boolean {
  return status === 'expired' || status === 'superseded';
}
