import 'server-only';
import { bogotaToday, deriveState } from '@cortex/agent-tools';
import { getOrgScopedClient } from './supabase/service';

/**
 * THE NUMBERS THE RAIL DRAWS, AND WHY THERE ARE FOUR OF THEM.
 *
 * There are four queues in this product that hold work waiting on a person, and
 * until now exactly one of them had a count. That asymmetry was not a design
 * decision, it was the order the modules were built in: /approvals got a badge
 * because it shipped first, and /actions, /commitments and /errands each shipped
 * with a good screen and no way to know from anywhere else that something was
 * sitting in it. A drafted email waiting nine days was invisible unless somebody
 * happened to click the row.
 *
 * Each count runs as its own query and swallows its own failure. That is the
 * deliberate exception to the rule the rest of the app now follows — a database
 * error must surface rather than render as emptiness — and it is narrow on
 * purpose: this is CHROME. A missing badge costs a number; a badge that throws
 * costs the navigation on every screen in the product. The content behind each
 * queue still fails loudly on its own page, which is where somebody can act on
 * the error.
 *
 * Every predicate below is the one its screen already applies. They are
 * duplicated rather than imported because the screens hydrate rows the count
 * does not need, but the DUPLICATION IS THE RISK: if a screen's filter changes
 * and this file does not, the rail will promise work that is not there. Each one
 * names the screen it mirrors so the pair can be found.
 */
export interface NavCounts {
  approvals: number;
  commitments: number;
  actions: number;
  errands: number;
}

const NONE: NavCounts = { approvals: 0, commitments: 0, actions: 0, errands: 0 };

/**
 * How far ahead to look for deadlines.
 *
 * `due_soon` cannot be expressed as one SQL comparison: the window is
 * per-row (`notice_days`, defaulting to 15, set as high as 45 for contracts),
 * so the state has to be derived in JS exactly the way the screen derives it —
 * see `deriveState` and the note in commitments/store.ts about the stored
 * column being an overnight cache the date overrides.
 *
 * So the query is bounded by a horizon wide enough to contain any sane notice
 * window, and the derivation happens over what comes back. A row with
 * `notice_days` beyond this horizon would be missed by the count while still
 * showing on the screen; 120 days is nearly triple the widest default, which
 * makes that a deliberate trade rather than an oversight.
 */
const DEADLINE_HORIZON_DAYS = 120;

export async function countNavSignals(organizationId: string, userId: string): Promise<NavCounts> {
  try {
    const db = getOrgScopedClient(organizationId);
    const nowIso = new Date().toISOString();
    const today = bogotaToday();

    const horizon = new Date(`${today}T00:00:00Z`);
    horizon.setUTCDate(horizon.getUTCDate() + DEADLINE_HORIZON_DAYS);
    const horizonDay = horizon.toISOString().slice(0, 10);

    const [approvals, commitments, actions, errands] = await Promise.all([
      // Mirrors app/(app)/approvals/page.tsx. Decided in Google Chat counts as
      // decided everywhere — the badge must not keep nagging about something
      // already approved from a card.
      count(() =>
        db
          .from('mcp_pending_actions')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .is('decision', null)
          .gt('expires_at', nowIso),
      ),

      // Mirrors app/(app)/commitments/page.tsx, which asks listCommitments for
      // states ['overdue', 'due_soon']. `review_state` defaults to 'confirmed'
      // there and is set explicitly here for the same reason store.ts gives:
      // pending rows are proposals, and counting them would have the rail
      // announce a deadline nobody has verified.
      (async () => {
        const { data } = await db
          .from('commitments')
          .select('due_on, notice_days, state')
          .eq('review_state', 'confirmed')
          .not('state', 'in', '(met,dropped)')
          .lte('due_on', horizonDay)
          .limit(500);
        return (
          (data ?? []) as Array<{
            due_on: string;
            notice_days: number | null;
            state: string | null;
          }>
        ).filter((row) => {
          const state = deriveState(row, today);
          return state === 'overdue' || state === 'due_soon';
        }).length;
      })(),

      // Mirrors app/(app)/actions/page.tsx: the `waiting` list, which is
      // 'proposed' minus the ones whose figures went stale. The screen filters
      // expiry in JS after fetching; expressed as a predicate it is the same
      // comparison listActions already offers as `approvableAt`.
      count(() =>
        db
          .from('actions')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('state', 'proposed')
          .gt('expires_at', nowIso),
      ),

      // Errands that stopped and asked something. 'blocked' is the one
      // non-terminal state that cannot advance without a person — queued and
      // working are the engine's business, and watching is a monitor that will
      // wake on its own. See ERRAND_STATES in errands/shape.ts.
      count(() =>
        db.from('errands').select('id', { count: 'exact', head: true }).eq('state', 'blocked'),
      ),
    ]);

    return { approvals, commitments, actions, errands };
  } catch {
    // Reached only if getOrgScopedClient itself throws — every individual read
    // already handles its own failure.
    return NONE;
  }
}

/** One count, and a zero if the database would rather not say. */
async function count(run: () => PromiseLike<{ count: number | null }>): Promise<number> {
  try {
    const { count: n } = await run();
    return n ?? 0;
  } catch {
    return 0;
  }
}
