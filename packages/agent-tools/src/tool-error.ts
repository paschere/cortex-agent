/**
 * Turning whatever a tool threw into a sentence somebody can read.
 *
 * WHY THIS FILE EXISTS. Every surface that runs a tool wraps the failure in the
 * same envelope — `{ __error: true, tool, message }` — because a failed tool
 * must not end the turn: the model has to read the failure, explain it and keep
 * going, and the chat renders it as a failed tool card. Four places built that
 * envelope, and all four filled `message` the same way:
 *
 *     err instanceof Error ? err.message : String(err)
 *
 * That line is wrong for the single most common failure in this product.
 * supabase-js does not throw: it returns `{ data, error }`, and `error` is a
 * PLAIN OBJECT `{ message, details, hint, code }` — the `PostgrestError` class
 * is only ever constructed under `.throwOnError()`, which nothing here uses.
 * Dozens of call sites then write `if (error) throw error`, so what arrives at
 * the envelope is an object that is not an `Error`, and `String(object)` is the
 * six-word string "[object Object]".
 *
 * The cause was not hidden by that, it was DELETED — before the logger, before
 * the audit row, before the model. Every database failure in every tool looked
 * identical and told nobody anything. So the extraction lives here, once, and
 * every envelope calls it.
 *
 * WHAT IT ACCEPTS. Anything: an `Error` (including subclasses that carry extra
 * fields), a PostgrestError in either of its two shapes, a `ZodError` in either
 * of its two copies, a string, a JSON envelope from Google or Microsoft, an
 * array, a bare object, null. It never returns an empty string, and it never
 * returns "[object Object]".
 */

/** The model reads this, so it is capped: a 40 kB 403 body must not flood context. */
const MAX_MESSAGE = 600;
/** How much of an unrecognised object is worth showing before it stops helping. */
const MAX_JSON = 400;
/** How many schema complaints to spell out before summarising the rest. */
const MAX_ISSUES = 5;

/**
 * Said only when the failure carried nothing legible AT ALL — a thrown `{}`, a
 * rejected promise with no reason. Spanish, because it is the one sentence here
 * this product wrote itself; everything else is passed through as the database
 * or the provider worded it.
 */
const UNKNOWN = 'La herramienta falló sin decir por qué.';

type AnyRecord = Record<string, unknown>;

function clamp(text: string, max = MAX_MESSAGE): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function nonEmpty(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * The message a JSON-ish object is carrying, one level down.
 *
 * `{ error: { message } }` is checked before `{ message }` because that is the
 * Google/Graph shape, where the outer message is a status line and the inner
 * one is the sentence a human needs.
 */
function messageOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as AnyRecord;
  const nested = record.error;
  if (typeof nested === 'string') {
    const direct = nonEmpty(nested);
    if (direct) return direct;
  } else if (nested && typeof nested === 'object') {
    const inner = nonEmpty((nested as AnyRecord).message);
    if (inner) return inner;
  }
  return nonEmpty(record.message);
}

/**
 * Several providers throw with the raw response body as the message. Pull the
 * sentence out of it, and keep the original when it is not JSON after all.
 */
function unwrapJsonEnvelope(text: string): string {
  const brace = text.indexOf('{');
  if (brace === -1) return text;
  try {
    return messageOf(JSON.parse(text.slice(brace))) || text;
  } catch {
    return text;
  }
}

/**
 * A PostgREST failure, in either shape it arrives in: the plain object returned
 * in `{ data, error }`, or the `PostgrestError` class thrown by
 * `.throwOnError()`. Both are recognised here, and both read the same
 * afterwards, so a call site switching between them changes nothing.
 *
 * `details` and `hint` are kept, not dropped. On the failure that prompted this
 * file the message was "null value in column \"organization_id\" ... violates
 * not-null constraint" and the detail named the row — which is the difference
 * between a fixable report and a shrug.
 */
function postgrestMessage(value: object): string {
  const record = value as AnyRecord;
  const message = nonEmpty(record.message);
  if (!message) return '';
  if (!('code' in record || 'details' in record || 'hint' in record)) return '';
  const parts = [message, nonEmpty(record.details), nonEmpty(record.hint)].filter(Boolean);
  const code = nonEmpty(record.code);
  return code ? `${parts.join(' · ')} [${code}]` : parts.join(' · ');
}

/**
 * A ZodError, recognised by shape rather than by `instanceof`: this monorepo
 * resolves zod for several packages and an instance check across two copies is
 * a coin flip. Its own `.message` is the issue list re-serialised as JSON, which
 * is exactly the kind of payload that used to reach the model unread.
 */
function zodMessage(value: object): string {
  const record = value as AnyRecord;
  if (record.name !== 'ZodError' || !Array.isArray(record.issues)) return '';
  const issues = record.issues as Array<{ path?: unknown; message?: unknown }>;
  const lines = issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : '';
    const text = nonEmpty(issue.message) || 'valor inválido';
    return path ? `${path}: ${text}` : text;
  });
  if (lines.length === 0) return '';
  const rest = issues.length - lines.length;
  return `Los datos no cumplen el esquema — ${lines.join('; ')}${rest > 0 ? ` (y ${rest} más)` : ''}`;
}

function safeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
    }
    return value;
  };
}

/** Last resort for an object nothing else recognised: show it, bounded. */
function stringifyBounded(value: unknown): string {
  try {
    const json = JSON.stringify(value, safeReplacer());
    if (!json || json === '{}' || json === '[]' || json === 'null') return '';
    return json.length > MAX_JSON ? `${json.slice(0, MAX_JSON)}…` : json;
  } catch {
    return '';
  }
}

function describe(err: unknown, depth = 0): string {
  if (err === null || err === undefined) return '';
  if (typeof err === 'string') return unwrapJsonEnvelope(err);
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);
  if (typeof err !== 'object') return '';
  if (depth > 3) return '';

  if (Array.isArray(err)) {
    const parts = err.map((item) => describe(item, depth + 1)).filter(Boolean);
    return parts.length > 0 ? parts.join('; ') : '';
  }

  // Shape checks come before the `instanceof Error` branch on purpose: a
  // PostgrestError and a ZodError are both Errors whose plain `.message` is
  // poorer than what their fields say.
  const zod = zodMessage(err);
  if (zod) return zod;

  const postgrest = postgrestMessage(err);
  if (postgrest) return postgrest;

  const message = messageOf(err);
  if (message) return unwrapJsonEnvelope(message);

  if (err instanceof Error) {
    // An Error with an empty message still knows what it is, and its cause
    // usually knows why.
    const cause = describe(err.cause, depth + 1);
    if (cause) return cause;
    return err.name === 'Error' ? '' : err.name;
  }

  return stringifyBounded(err);
}

/**
 * The one-line, human-readable rendering of a tool failure. Goes into the
 * `__error` envelope the model reads and the chat renders.
 *
 * Guaranteed non-empty, guaranteed never "[object Object]", guaranteed bounded.
 */
export function toolErrorMessage(err: unknown): string {
  return clamp(describe(err)) || UNKNOWN;
}

function kindOf(err: unknown): string {
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';
  if (typeof err !== 'object') return typeof err;
  if (Array.isArray(err)) return 'array';
  const record = err as AnyRecord;
  if (record.name === 'ZodError') return 'ZodError';
  if (postgrestMessage(err)) return 'PostgrestError';
  if (err instanceof Error) return err.name || 'Error';
  return 'object';
}

/**
 * Everything worth writing to the log about a failure, as one flat record.
 *
 * Separate from `toolErrorMessage` because they answer to different readers:
 * the message is capped and prose because a model consumes it, this is the
 * structured detail — the SQL state, the HTTP status, the stack — that the
 * person reading the logs at 2am actually needs. Losing this is what made the
 * original bug undiagnosable, so it is logged even when the message is good.
 */
export function toolErrorDetail(err: unknown): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    kind: kindOf(err),
    message: toolErrorMessage(err),
  };
  if (!err || typeof err !== 'object') return detail;

  const record = err as AnyRecord;
  for (const key of ['code', 'details', 'hint', 'status', 'statusCode', 'provider']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') detail[key] = value;
  }
  if (err instanceof Error) {
    if (err.stack) detail.stack = err.stack.split('\n').slice(0, 8).join('\n');
    if (err.cause !== undefined && err.cause !== null) detail.cause = toolErrorMessage(err.cause);
  } else {
    // A thrown plain object has no stack, so the object itself is the evidence.
    const raw = stringifyBounded(err);
    if (raw) detail.raw = raw;
  }
  return detail;
}
