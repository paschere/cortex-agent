import 'server-only';
import { getSupabaseServiceClient } from './supabase/service';

/**
 * Confirmations sitting in this person's approvals queue right now.
 *
 * Costs one extra `count: 'exact', head: true` query per render of the app
 * shell — both layouts are already dynamic (requireSession reads cookies), so
 * this runs on every navigation. It is the same predicate the dashboard tile
 * uses, and it is what keeps the sidebar badge honest without a polling loop or
 * a new endpoint. A failure is swallowed: a missing badge must never take the
 * navigation down with it.
 */
export async function countPendingApprovals(userId: string): Promise<number> {
  try {
    const { count } = await getSupabaseServiceClient()
      .from('mcp_pending_actions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      // Decided in Google Chat counts as decided everywhere — the badge must
      // not keep nagging about something already approved from a card.
      .is('decision', null)
      .gt('expires_at', new Date().toISOString());
    return count ?? 0;
  } catch {
    return 0;
  }
}
