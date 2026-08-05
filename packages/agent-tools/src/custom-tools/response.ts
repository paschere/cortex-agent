/**
 * What comes back, and how much of it the model is allowed to see.
 *
 * A 200 KB JSON payload is not "extra information", it is a poisoned context
 * window: it crowds out the conversation, costs a fortune per turn, and buries
 * the one field the person asked about under nine hundred they did not. So
 * every custom tool declares a slice and a ceiling.
 *
 * THE SELECTOR is a dotted path — `data.guias.0.estado` — with `[0]` accepted
 * as an alternative spelling for an index and a leading `$.` tolerated because
 * people copy paths out of jq and Postman. NOT full JSONPath: no wildcards, no
 * filters, no recursive descent. That is a deliberate ceiling rather than an
 * unfinished implementation — a full JSONPath engine is a query language with
 * its own evaluation semantics, and the 5% of cases it buys are better served
 * by asking the endpoint for less. A path that matches nothing returns the
 * whole body rather than null, because "the tool returned nothing" is the
 * hardest failure to debug from the far side of a chat window.
 */

export interface SelectedResponse {
  data: unknown;
  truncated: boolean;
  /** Set when the path was configured but did not match. Surfaced to the tester. */
  pathMissed?: boolean;
}

/** Split `a.b[0].c` / `$.a.b.0.c` into ['a','b','0','c']. */
export function parsePath(path: string): string[] {
  return path
    .trim()
    .replace(/^\$\.?/, '')
    .replaceAll(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const MISSING = Symbol('missing');

function walk(value: unknown, segments: string[]): unknown | typeof MISSING {
  let node: unknown = value;
  for (const segment of segments) {
    if (node === null || node === undefined) return MISSING;
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return MISSING;
      node = node[index];
      continue;
    }
    if (typeof node !== 'object') return MISSING;
    const record = node as Record<string, unknown>;
    if (!(segment in record)) return MISSING;
    node = record[segment];
  }
  return node;
}

/**
 * Apply the selector and the size cap to a raw response body.
 *
 * A non-JSON body (HTML error page, plain text, CSV) is kept as text and simply
 * truncated — an endpoint answering with an HTML error is exactly the moment
 * somebody needs to see what it said.
 */
export function selectResponse(
  rawBody: string,
  path: string | null | undefined,
  maxChars: number,
): SelectedResponse {
  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    isJson = false;
    parsed = rawBody;
  }

  let selected = parsed;
  let pathMissed = false;
  if (isJson && path && path.trim().length > 0) {
    const found = walk(parsed, parsePath(path));
    if (found === MISSING) {
      pathMissed = true;
    } else {
      selected = found;
    }
  }

  const text = typeof selected === 'string' ? selected : (JSON.stringify(selected) ?? '');
  if (text.length <= maxChars) {
    return { data: selected, truncated: false, ...(pathMissed ? { pathMissed } : {}) };
  }

  // Over the cap. Hand back TEXT rather than a half-parsed object: a JSON
  // fragment cut mid-token is not JSON, and pretending otherwise gives the
  // model something it cannot read. The suffix tells it what happened so it can
  // say so instead of assuming the record ends there.
  return {
    data: `${text.slice(0, maxChars)}\n\n[respuesta recortada: ${text.length} caracteres en total, límite ${maxChars}]`,
    truncated: true,
    ...(pathMissed ? { pathMissed } : {}),
  };
}
