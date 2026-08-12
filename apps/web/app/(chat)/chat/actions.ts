'use server';

import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  listVisibleSpaces,
  loadOverrides,
  saveChartAsReport,
  saveOverrides,
} from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';

/**
 * What the buttons inside the transcript do.
 *
 * Kept as server actions rather than routes because each one is a single
 * mutation with no payload worth streaming, and because the alternative — a
 * route per button — is how a surface accumulates six endpoints that all
 * `requireSession` slightly differently.
 */

export interface ChartSaveResult {
  ok: boolean;
  error?: string;
  reportId?: string;
  url?: string;
  alreadySaved?: boolean;
}

/**
 * Keep a chart drawn in the chat as an informe.
 *
 * THE WHOLE POINT IS WHAT IS ABSENT: there is no query here. The chart was
 * resolved into a `ReportDocument` when it was drawn — figures computed,
 * sources stamped with the instant they were read — and this hands those same
 * bytes to `saveReport`. So the saved informe carries the moment of the CHART,
 * not the moment of the click, and reopening it in November shows what the
 * conversation showed in August.
 *
 * That is the difference between saving and bookmarking, and `store.ts` argues
 * it at length: a report that re-runs its query is a report about today wearing
 * an older title, and nobody can tell because both look correct.
 */
export async function saveChartAsReportAction(chartId: string): Promise<ChartSaveResult> {
  try {
    const user = await requireSession();
    const ctx = buildToolContext({
      organizationId: user.organization.id,
      userId: user.id,
      agentId: user.id,
      surface: 'web',
    });

    const result = await saveChartAsReport(ctx, chartId);
    revalidatePath('/reports');
    return {
      ok: true,
      reportId: result.reportId,
      url: `/reports/${result.reportId}`,
      alreadySaved: result.alreadySaved,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    return {
      ok: false,
      error: message && message.length < 240 ? message : 'No se pudo guardar el informe.',
    };
  }
}

export interface SpaceChoice {
  id: string;
  name: string;
  kind: 'global' | 'personal';
  /** False when this person may read the space but not write to it. */
  writable: boolean;
}

/**
 * The spaces offered when somebody chooses to remember a file.
 *
 * Company-wide spaces are LISTED for everyone and only WRITABLE by org admins,
 * rather than hidden from everybody else. Hiding them would make the product
 * look like it has no shared memory; showing them disabled says the true thing
 * — this exists, and putting something in it is not your call — which is the
 * answer somebody needs in order to go and ask.
 *
 * `assertCanWriteToSpace` on the upload route is what actually enforces it.
 * This list is a convenience and is never the check.
 */
export async function listWritableSpacesAction(): Promise<SpaceChoice[]> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const [spaces, { data: me }] = await Promise.all([
      listVisibleSpaces(db, user.id),
      db.from('users').select('role').eq('id', user.id).maybeSingle(),
    ]);
    const isAdmin = (me?.role as string | undefined) === 'org_admin';

    return spaces.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      writable: s.kind === 'personal' ? s.ownerId === user.id : isAdmin,
    }));
  } catch {
    return [];
  }
}

// ===========================================================================
// CHOOSING WHICH MEMORY ANSWERS
// ===========================================================================
//
// WHY THIS IS NOT `listWritableSpacesAction`. That list answers "where may I
// PUT this file", and it is right that a company-wide space appears in it
// greyed out. This one answers "where should Cortex LOOK", and reading is the
// other half of the rule: every space a person can retrieve from is a space
// they may narrow to, admin or not. Two questions, two lists — merging them
// would mean either offering a space nobody may write to as a destination, or
// hiding a readable space from the filter because the person is not an admin.
//
// WHERE THE CHOICE IS STORED. In `turn_context_settings.space_ids`, the column
// migration 0080 already created for exactly this, reached through
// `loadOverrides` / `saveOverrides`. Nothing new was added: the composer's
// filter and the "espacios" knob in the diagnostics panel at
// /conversations/[id] are the SAME value, so the two surfaces can never
// disagree about what a conversation is searching. The header of
// packages/agent-tools/src/turn-context/settings.ts argues the scope
// (conversation, not workspace, not forever) and that argument is unchanged.

export interface ScopeSpace {
  id: string;
  name: string;
  kind: 'global' | 'personal';
}

/** Every space this person may retrieve from — the only things they may filter to. */
export async function listScopeSpacesAction(): Promise<ScopeSpace[]> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const spaces = await listVisibleSpaces(db, user.id);
    return spaces.map((s) => ({ id: s.id, name: s.name, kind: s.kind }));
  } catch {
    // An empty list closes the picker with "no hay espacios todavía", which is
    // a truthful thing to show and never blocks the composer.
    return [];
  }
}

/**
 * Narrow (or un-narrow) one conversation's retrieval.
 *
 * OWNERSHIP, NOT MEMBERSHIP. Only the person whose conversation it is may
 * change it, and a conversation that is not theirs answers "no longer exists"
 * rather than "forbidden" — the same rule and the same wording as
 * `saveTurnContextAdjustments`, so a wrong id and somebody else's id stay
 * indistinguishable.
 *
 * IT READS BEFORE IT WRITES. `saveOverrides` upserts the whole row, so writing
 * the scope without loading the rest would silently reset the fragment limit
 * and the muted tool families somebody set while debugging this same
 * conversation. Only `space_ids` changes here.
 *
 * IT CANNOT WIDEN. Every id is checked against `listVisibleSpaces` and anything
 * else is dropped before it is stored, so a forged id cannot be parked in the
 * column; and even if one were, `kb_search_scoped` intersects with what the
 * person can see. This check exists so a stale id fails at the moment somebody
 * picks it instead of quietly narrowing retrieval to nothing three turns later.
 */
export async function setChatScopeAction(
  conversationId: string,
  spaceIds: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  let user: Awaited<ReturnType<typeof requireSession>>;
  try {
    user = await requireSession();
  } catch {
    return { ok: false, error: 'Vuelve a entrar para cambiar el filtro.' };
  }

  const db = getOrgScopedClient(user.organization.id);

  const { data: conv } = await db
    .from('conversations')
    .select('id, user_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv || (conv.user_id as string) !== user.id) {
    return { ok: false, error: 'Esa conversación ya no existe.' };
  }

  let allowed: string[] = [];
  if (spaceIds.length > 0) {
    const visible = await listVisibleSpaces(db, user.id);
    const visibleIds = new Set(visible.map((s) => s.id));
    allowed = spaceIds.filter((id) => visibleIds.has(id));
    if (allowed.length === 0) {
      return { ok: false, error: 'Los espacios que elegiste ya no existen.' };
    }
  }

  try {
    const current = await loadOverrides(db, conversationId);
    await saveOverrides(db, {
      conversationId,
      userId: user.id,
      overrides: {
        fragmentLimit: current.fragmentLimit,
        // An empty selection is stored as null — "todo lo que ves" — and never
        // as `[]`, which `kbSpaceIds` reads as "ningún espacio" and would
        // switch the brain off for the conversation. See settings.ts.
        spaceIds: allowed.length > 0 ? allowed : null,
        mutedFamilies: current.mutedFamilies,
      },
    });
  } catch {
    return { ok: false, error: 'No se pudo guardar el filtro. Inténtalo otra vez.' };
  }

  return { ok: true };
}
