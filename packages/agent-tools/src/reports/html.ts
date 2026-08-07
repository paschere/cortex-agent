/**
 * The escaping boundary. Every string that becomes markup crosses exactly one
 * of these functions, and there is no other path.
 *
 * WHY THIS IS A SEPARATE, TINY MODULE. A report is made of customer data:
 * counterparty names typed by whoever answered the phone, document titles from
 * files somebody uploaded, plates, notes. Any of it may contain `<`, `"`, or a
 * whole `</style><script>`. If one interpolation in one chart forgets to
 * escape, a workspace can put script into a page that a shared link then serves
 * to somebody else — including somebody at another company. So the escaping
 * lives on its own, with no dependencies, and the renderers are written so that
 * calling it is the only way to get a string into the output at all.
 *
 * The rule the tests enforce (`__tests__/render.test.ts`): render a document
 * whose every string is hostile, and assert the output contains no executable
 * markup and no attribute break-out.
 */

/**
 * Escape for HTML text content AND for quoted attribute values.
 *
 * All five of these matter, and the two quote characters are the ones people
 * skip. `&` first, always, or the escapes escape each other. Single quotes are
 * escaped too because SVG attributes in this module are written with double
 * quotes today and a future edit that switches one to single quotes must not
 * open a hole.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A number destined for an SVG coordinate or a CSS length.
 *
 * Nothing untrusted should reach a geometry attribute, but "should" is not a
 * mechanism: a NaN from a division by zero writes `x="NaN"` and silently blanks
 * a chart, and an Infinity writes an attribute a parser may or may not survive.
 * This makes both impossible and rounds to two decimals so the output of a
 * given document is byte-identical every time it is rendered — which is what
 * lets the snapshot test compare strings rather than screenshots.
 */
export function num(value: number, fallback = 0): string {
  if (!Number.isFinite(value)) return String(fallback);
  return String(Math.round(value * 100) / 100);
}

/**
 * A class name, restricted to the alphabet this module's own stylesheet uses.
 *
 * Class names in this renderer are always literals chosen by our code, never
 * data. This exists so that stays true even if somebody later passes a tone or
 * a key through: anything outside `[a-z0-9-]` is dropped rather than emitted.
 */
export function cls(...names: Array<string | false | null | undefined>): string {
  return names
    .filter((n): n is string => Boolean(n))
    .map((n) => n.replace(/[^a-zA-Z0-9_ -]/g, ''))
    .join(' ');
}

/** Join HTML fragments, dropping the empties, with a newline for readability. */
export function join(parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join('\n');
}
