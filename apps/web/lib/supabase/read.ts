import 'server-only';

/**
 * READING A TABLE IN A WAY THAT CANNOT FAIL SILENTLY.
 *
 * ===========================================================================
 * THE BUG THIS EXISTS TO PREVENT, WHICH HAS ALREADY SHIPPED TWICE
 * ===========================================================================
 * `supabase-js` does not throw. Every call comes back as `{ data, error }`, and
 * `data` is `null` when `error` is set — so destructuring `data` on its own,
 * which happens in over a hundred places in this repository, turns a database
 * failure into an empty screen:
 *
 *     const rows = (await db.from('messages').select(...)).data ?? [];
 *
 * An empty screen and a broken screen look IDENTICAL and mean opposite things,
 * and the difference is the whole of what somebody needs in order to report the
 * problem. In production this looked like: every conversation in the product
 * reading as brand new, because a deploy shipped a `select` naming a column
 * before its migration landed and PostgREST rejected the whole query for that
 * one unknown name. Nothing in the build, the types or the tests could catch it,
 * because the column was real in the repo and missing only in the database that
 * was running.
 *
 * ===========================================================================
 * WHERE THIS BELONGS, AND WHERE IT EMPHATICALLY DOES NOT
 * ===========================================================================
 * Use it for CONTENT: the rows a screen exists to show. If they cannot be read,
 * the screen must say so.
 *
 * Do NOT use it for a COUNTER, a badge or anything decorative. `nav-signals.ts`
 * swallows its errors on purpose and explains why: a missing number costs a
 * badge, while a number that throws costs the navigation on every screen in the
 * product. That distinction — content fails loudly, chrome fails quietly — is
 * the actual rule. This helper is one half of it, not the whole.
 */

/** The shape supabase-js returns. Structural, so it needs no import. */
interface Read<T> {
  data: T | null;
  error: { message: string; code?: string; details?: string | null; hint?: string | null } | null;
}

/**
 * The rows, or an exception that names what could not be read and why.
 *
 * `what` is a sentence fragment in Spanish naming the CONTENT, not the table:
 * "las conversaciones de este espacio", not "conversations". It ends up in an
 * error boundary where a person reads it, and a table name tells them nothing
 * they can act on.
 *
 * The hint about an unapplied migration is attached because that is what it is,
 * the overwhelming majority of the time, in a product that ships migrations and
 * code separately.
 */
export function mustRead<T>(result: Read<T>, what: string): T {
  if (result.error) {
    throw new Error(
      `No se pudo leer ${what}: ${result.error.message}. ` +
        'Suele ser una migración sin aplicar en esta base de datos.',
    );
  }
  // `data` is null with no error on `maybeSingle()` finding nothing, which is
  // an answer rather than a failure — the caller's type says whether that is
  // allowed, and narrowing it here would take that decision away from them.
  return result.data as T;
}

/**
 * The same, for a read whose emptiness is a legitimate answer.
 *
 * Separate from `mustRead` rather than a flag, because the two say different
 * things at the call site: this one is "no rows is fine, a failure is not".
 */
export function mustReadList<T>(result: Read<T[]>, what: string): T[] {
  return mustRead(result, what) ?? [];
}
