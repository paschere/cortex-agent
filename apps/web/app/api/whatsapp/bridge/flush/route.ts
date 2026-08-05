import { getOrgScopedClient } from '@/lib/supabase/service';
import { authenticateBridge } from '@/lib/whatsapp/bridge';
import { flushWorkspace } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Fold finished conversations into Brain Knowledge.
 *
 * WHY THE BRIDGE DRIVES THIS AND NOT A CRON. The bridge is already a persistent
 * process with a scheduler in it, and it is the only source of the messages
 * this pass consumes: if it is down, there is nothing new to fold, and a cron
 * firing anyway would be work done to discover that. Tying the pass to the
 * thing that produces its input also means one fewer moving part to notice has
 * stopped — a bridge that stops ticking stops appearing in the heartbeat, which
 * is already on screen.
 *
 * It is safe to call as often as anyone likes. The pass starts from "messages
 * with no document yet", so a workspace where nothing has happened is one
 * indexed query per group and out, and a window that has already been ingested
 * and has not changed costs a sha comparison rather than an embedding run.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Embedding a day's worth of a busy group is minutes, not seconds. */
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = authenticateBridge(req);
  if (!auth.ok) return auth.response;

  const db = getOrgScopedClient(auth.caller.organizationId);

  try {
    const results = await flushWorkspace({
      organizationId: auth.caller.organizationId,
      db,
      logger,
    });

    const windows = results.flatMap((r) => r.windows);
    const written = windows.filter(
      (w) => w.outcome === 'imported' || w.outcome === 'updated',
    ).length;
    if (written > 0) {
      logger.info(
        `whatsapp: folded ${written} conversation window(s) into Brain Knowledge across ${results.length} group(s)`,
      );
    }

    const now = new Date().toISOString();
    for (const result of results) {
      if (result.windows.length === 0) continue;
      await db
        .from('whatsapp_groups')
        .update({ last_ingested_at: now })
        .eq('jid', result.groupJid)
        .then(undefined, () => undefined);
    }

    return NextResponse.json({
      groups: results.length,
      windows: windows.length,
      written,
      failed: windows.filter((w) => w.outcome === 'failed').length,
    });
  } catch (err) {
    logger.error(`whatsapp: flush pass failed — ${(err as Error).message}`);
    // A 500 so the bridge's own logs show it; there is nothing to retry by
    // hand, the next tick picks up exactly where this one stopped.
    return NextResponse.json({ error: 'The flush pass failed' }, { status: 500 });
  }
}
