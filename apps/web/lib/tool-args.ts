/**
 * A tool call's arguments, reduced to the one line that identifies it.
 *
 * WHY NOT THE WHOLE OBJECT. A task row exists so somebody scanning a turn can
 * see that Cortex asked the right question of the right system. `{"plate":
 * "ABC123"}` answers that; the pretty-printed JSON of a twelve-field search
 * does not, because at that size nobody reads it and the row stops being
 * scannable — which is the whole reason the rows are dense.
 *
 * WHY NOT A HAND-WRITTEN PHRASE PER TOOL. `confirmationSummary` in
 * `tool-labels.ts` does exactly that, and it is right there: a confirmation is
 * a decision, it is shown one at a time, and a sentence is what somebody needs
 * before they say yes. But it only covers the dozen tools that can be
 * confirmed, and a task row has to work for every tool in the registry
 * including the ones a customer wrote this morning. A rule that works for all
 * of them beats a phrase that works for twelve and silently degrades to
 * "Ejecutar: …" for the rest.
 *
 * So the rule: show the values, prefer the ones that identify the target, drop
 * the ones that are just plumbing, and never spend more than a line.
 */

/**
 * Keys that say WHICH THING this call is about. Listed first when present,
 * because a row reading `ABC123` is instantly recognisable and the same row
 * reading `limit 20` is not.
 */
const IDENTIFYING = [
  'plate',
  'placa',
  'query',
  'q',
  'search',
  'name',
  'title',
  'client',
  'counterparty',
  'company',
  'companyName',
  'email',
  'to',
  'subject',
  'id',
  'documentId',
  'reportId',
  'commitmentId',
  'clientId',
  'spaceId',
  'url',
  'path',
  'kind',
  'slug',
];

/**
 * Keys that are almost never what distinguishes one call from another. Shown
 * only when nothing better exists, so a row is never left blank.
 */
const PLUMBING = new Set([
  'limit',
  'offset',
  'page',
  'cursor',
  'pageSize',
  'maxResults',
  'includeDeleted',
  'dryRun',
  'timezone',
  'locale',
]);

const MAX_PARTS = 3;
const MAX_VALUE = 44;
const MAX_LINE = 110;

function renderValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_VALUE ? `${trimmed.slice(0, MAX_VALUE - 1)}…` : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    // The count, not the contents: an array of forty ids is not a line.
    if (value.length === 0) return null;
    const first = renderValue(value[0]);
    return value.length === 1 && first ? first : `${value.length} elementos`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length > 0 ? `{${keys.slice(0, 3).join(', ')}}` : null;
  }
  return null;
}

/**
 * One line describing what this call was asked to do. Empty string when the
 * arguments carry nothing worth showing — the caller then shows nothing rather
 * than an empty pair of braces.
 */
export function essentialArgs(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const record = args as Record<string, unknown>;

  const entries = Object.entries(record).filter(([, v]) => renderValue(v) !== null);
  if (entries.length === 0) return '';

  const rank = (key: string): number => {
    const identifying = IDENTIFYING.indexOf(key);
    if (identifying !== -1) return identifying;
    if (PLUMBING.has(key)) return 900;
    return 500;
  };

  const chosen = entries.sort(([a], [b]) => rank(a) - rank(b)).slice(0, MAX_PARTS);

  const line = chosen
    .map(([key, value]) => {
      const rendered = renderValue(value);
      // A lone identifying string speaks for itself — `ABC123` beats
      // `plate: ABC123` when the tool is already named "Consultar el RUNT".
      if (chosen.length === 1 && IDENTIFYING.includes(key) && typeof value === 'string') {
        return rendered ?? '';
      }
      return `${key}: ${rendered}`;
    })
    .join(' · ');

  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

/** `1,2 s` past a second, `840 ms` below it. Colombian decimal comma. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0).replace('.', ',')} s`;
}
