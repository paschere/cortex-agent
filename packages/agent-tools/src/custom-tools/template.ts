/**
 * Turning a stored request definition plus the model's arguments into an actual
 * HTTP request.
 *
 * THE SYNTAX is `{{field}}` — double braces, optional inner whitespace,
 * `{{ field }}` is the same placeholder. It was picked because it is the one
 * people already recognise from every no-code tool they have used, and because
 * a bare `{field}` collides with the JSON braces that surround it in exactly
 * the place we care most about getting right.
 *
 * THE ESCAPING is the point of this file, and it is NOT one function. The right
 * escape depends entirely on where the value lands, and using one escape
 * everywhere is how injection bugs are written:
 *
 *   URL      encodeURIComponent. A guide number of `../../admin` becomes
 *            `..%2F..%2Fadmin` and stays one path segment; `a&b=c` cannot open
 *            a second query parameter.
 *
 *   HEADERS  control characters — CR, LF, NUL and friends — are stripped, and
 *            the value is length-capped. A header value carrying `\r\n` is
 *            request splitting: it ends the header block and starts writing the
 *            attacker's own headers, or a second request entirely.
 *
 *   JSON     no textual interpolation at all. This is the important decision.
 *            The body is stored as a JSON *structure*, so substitution happens
 *            at the value level and `JSON.stringify` serialises the finished
 *            object. An input of `","admin":true,"x":"` is then just a string
 *            with quotes in it — the serialiser escapes them, and the document
 *            has exactly the shape its author drew. Interpolating into a
 *            hand-written JSON string, the obvious implementation, would make
 *            that input rewrite the request. There is a test for precisely it.
 *
 *   FORM     encodeURIComponent on both name and value.
 *
 * A placeholder whose field is a `string_array` becomes a JSON array in a JSON
 * body, and a comma-joined string everywhere else (URLs and headers have no
 * notion of a list, and comma-joined is what nearly every API expects).
 */

import type { CustomToolBodyEncoding } from './types';

/** Matches `{{ name }}`; the capture is the field name. */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Every field name a template refers to, in order of first appearance. */
export function placeholdersIn(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(PLACEHOLDER_RE)) if (m[1]) out.add(m[1]);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) placeholdersIn(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      placeholdersIn(k, out);
      placeholdersIn(v, out);
    }
  }
  return out;
}

/** True when the whole string is a single placeholder and nothing else. */
function soleParameter(text: string): string | null {
  const m = /^\s*\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/.exec(text);
  return m?.[1] ?? null;
}

/** How a value reads when it has to become text (URL segment, header, form). */
function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => asText(v)).join(',');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The single substitution primitive. `escapeFor` is mandatory rather than
 * defaulted: every caller has to state, at the call site, what kind of slot the
 * value is landing in. A default would make "no escaping" the thing you get by
 * forgetting, which is the wrong way round for this particular function.
 */
function substitute(
  template: string,
  input: Record<string, unknown>,
  escapeFor: (s: string) => string,
): string {
  return template.replaceAll(PLACEHOLDER_RE, (_match, name: string) =>
    escapeFor(asText(input[name])),
  );
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/**
 * Render the URL template. Everything substituted is percent-encoded, so a
 * value can only ever be *one* path segment or *one* query value — it can never
 * grow the path, add a parameter, or change the host.
 */
export function renderUrl(template: string, input: Record<string, unknown>): string {
  return substitute(template, input, encodeURIComponent);
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

const HEADER_VALUE_MAX = 4_000;

/** Anything that could terminate or split a header line, plus other C0/C1. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

export function sanitizeHeaderValue(value: string): string {
  return value.replace(CONTROL_RE, '').slice(0, HEADER_VALUE_MAX);
}

/** True when a header name is one we will let a definition set. */
export function isValidHeaderName(name: string): boolean {
  return /^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,64}$/.test(name);
}

/**
 * Headers a definition may not set, because we set them and because letting a
 * template own them turns a header into a way to reshape the request.
 */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
  'expect',
]);

export function isReservedHeader(name: string): boolean {
  return RESERVED_HEADERS.has(name.toLowerCase());
}

export function renderHeaders(
  template: Record<string, string>,
  input: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(template)) {
    if (!isValidHeaderName(name) || isReservedHeader(name)) continue;
    out[name] = sanitizeHeaderValue(substitute(value, input, (s) => s));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

/** Sentinel for "this placeholder had no value, drop the key it stood for". */
const OMIT = Symbol('omit');

/**
 * Walk the stored JSON structure, substituting placeholders by VALUE.
 *
 * Three cases, and the first is the one that carries the types through:
 *
 *   "{{count}}"        the node IS a placeholder → replaced by the actual
 *                      value, so a number stays a number and an array stays an
 *                      array. Absent optional field → the key disappears
 *                      instead of becoming the string "undefined".
 *   "guía {{id}} ok"   placeholders inside a larger string → substituted as
 *                      text; the node stays a string and JSON.stringify escapes
 *                      whatever came in.
 *   {...} / [...]      recurse.
 */
function renderJsonNode(node: unknown, input: Record<string, unknown>): unknown | typeof OMIT {
  if (typeof node === 'string') {
    const sole = soleParameter(node);
    if (sole !== null) {
      const value = input[sole];
      return value === undefined ? OMIT : value;
    }
    return substitute(node, input, (s) => s);
  }
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      const rendered = renderJsonNode(item, input);
      if (rendered !== OMIT) out.push(rendered);
    }
    return out;
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const rendered = renderJsonNode(value, input);
      if (rendered === OMIT) continue;
      // Keys are templated too, and a key that renders empty is dropped rather
      // than written as "".
      const renderedKey = substitute(key, input, (s) => s);
      if (renderedKey === '') continue;
      out[renderedKey] = rendered;
    }
    return out;
  }
  return node;
}

export interface RenderedBody {
  body: string | undefined;
  contentType: string | undefined;
}

export function renderBody(
  encoding: CustomToolBodyEncoding,
  template: unknown,
  input: Record<string, unknown>,
): RenderedBody {
  if (encoding === 'none' || template === null || template === undefined) {
    return { body: undefined, contentType: undefined };
  }

  if (encoding === 'json') {
    const rendered = renderJsonNode(template, input);
    if (rendered === OMIT) return { body: undefined, contentType: undefined };
    // The serialisation, not the template, is what produces the JSON text.
    return { body: JSON.stringify(rendered), contentType: 'application/json' };
  }

  // form: a flat object of string templates.
  const source =
    template && typeof template === 'object' && !Array.isArray(template)
      ? (template as Record<string, unknown>)
      : {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    const sole = typeof value === 'string' ? soleParameter(value) : null;
    if (sole !== null && input[sole] === undefined) continue;
    const renderedValue =
      typeof value === 'string' ? substitute(value, input, (s) => s) : asText(value);
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(renderedValue)}`);
  }
  return {
    body: parts.join('&'),
    contentType: 'application/x-www-form-urlencoded',
  };
}
