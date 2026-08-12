import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { getChatChart, renderChatChartHtml } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The drawing, fetched by the message that wants to show it.
 *
 * WHY THE SVG IS NOT IN THE TOOL RESULT. It would be the shorter path: the tool
 * already has the markup, and the chat client already renders tool results. But
 * a tool result is part of the TRANSCRIPT — it is persisted on the message row
 * and it is replayed into the model's context on every subsequent turn of the
 * conversation. Twenty kilobytes of `<path d="…">` would then be re-sent, and
 * re-paid for, on turn after turn, to a reader that cannot see pictures and
 * already knows what it plotted.
 *
 * So the tool returns an id and the browser comes here for the picture. The
 * document is read from the row exactly as saved; nothing is recomputed, and a
 * chart reopened in November renders the numbers of the day it was drawn.
 *
 * Every byte of `html` is produced by our renderer, which escapes all content
 * (see reports/html.ts and the header of the /reports/[id] page). The client
 * injects it, which is the same trade made there and for the same reason.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const stored = await getChatChart(db, id).catch(() => null);
  // The scoped handle turns another workspace's id into "no row", so this one
  // branch covers both "does not exist" and "not yours" — and says the same
  // thing to both, which is the point.
  if (!stored) return NextResponse.json({ error: 'No existe ese gráfico.' }, { status: 404 });

  return NextResponse.json({
    id: stored.row.id,
    title: stored.document.title,
    html: renderChatChartHtml(stored.document, stored.row.id),
    savedReportId: stored.row.saved_report_id,
  });
}
