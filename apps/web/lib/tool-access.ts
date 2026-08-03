import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Team-based tool permissions (see 0038_team_tool_permissions.sql).
 *
 * Permissions are a DENY-LIST layered on top of whatever the agent already
 * allows. A user's effective toolset is:
 *
 *   filterTools(agent.allowedTools) MINUS every pattern with allowed = false
 *   in ANY team the user belongs to.
 *
 * Teams only ever subtract: joining a second, unrestricted team never restores
 * a tool that another of your teams denies. A user in no team is unrestricted.
 *
 * Every read here fails OPEN: a DB hiccup must never lock the whole company
 * out of its tools, so query errors return an empty deny-list and are logged.
 */

interface TeamMemberRow {
  team_id: string;
}

interface PermissionRow {
  tool_pattern: string;
}

/**
 * Distinct tool patterns denied to `userId` by any of their teams.
 * Returns [] when the user has no teams, no restrictions, or on any error.
 */
export async function deniedToolPatterns(db: SupabaseClient, userId: string): Promise<string[]> {
  if (!userId) return [];
  try {
    const { data: memberships, error: membersError } = await db
      .from('team_members')
      .select('team_id')
      .eq('user_id', userId);
    if (membersError) throw membersError;

    const teamIds = [...new Set(((memberships ?? []) as TeamMemberRow[]).map((m) => m.team_id))];
    if (teamIds.length === 0) return [];

    const { data: rows, error: permsError } = await db
      .from('team_tool_permissions')
      .select('tool_pattern')
      .in('team_id', teamIds)
      .eq('allowed', false);
    if (permsError) throw permsError;

    return [...new Set(((rows ?? []) as PermissionRow[]).map((r) => r.tool_pattern))];
  } catch (err) {
    // Fail open — never block tools because the permissions lookup broke.
    console.error('[tool-access] could not resolve denied tool patterns, failing open:', err);
    return [];
  }
}

/**
 * Same matching rules as matchPattern in @cortex/agent-tools:
 * 'family.*' is a prefix match, anything else is an exact tool id.
 */
export function isToolDenied(toolId: string, patterns: string[]): boolean {
  return patterns.some((pat) =>
    pat.endsWith('.*') ? toolId.startsWith(pat.slice(0, -1)) : pat === toolId,
  );
}
