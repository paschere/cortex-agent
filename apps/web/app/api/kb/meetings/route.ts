import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  MEET_READONLY_SCOPE,
  type MeetingImportContext,
  createIntegrationsClient,
  getVisibleSpace,
  importMeetingTranscript,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * The Brain Knowledge page's window onto imported meetings.
 *
 * GET  — what has been imported into this space, and whether Google is even
 *        connected with permission to read Meet.
 * POST — import one meeting by its Meet code, right now, into this space.
 *
 * Both are gated by `getVisibleSpace` / the importer's own `assertCanWriteToSpace`
 * for the same reason the Drive status route is: a space id is not a permission,
 * and "which meetings are filed here" is itself something you should not learn
 * about a space you cannot see.
 */

/** Meetings are long-running to import; a single call embeds the whole call. */
export const maxDuration = 300;

interface ImportedMeetingRow {
  id: string;
  title: string | null;
  meeting_code: string | null;
  started_at: string | null;
  ended_at: string | null;
  participants: string[] | null;
  document_id: string | null;
  imported_at: string;
  status: string;
  error: string | null;
}

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const db = getSupabaseServiceClient();

  const spaceId = new URL(req.url).searchParams.get('spaceId');
  if (!spaceId) {
    return NextResponse.json({ error: 'Missing spaceId query param' }, { status: 400 });
  }

  try {
    await getVisibleSpace(db, session.id, spaceId);
  } catch {
    return NextResponse.json({ error: 'Space not found' }, { status: 404 });
  }

  const integrations = createIntegrationsClient(db, session.id, logger);
  const connected = await integrations.hasScopes('google', [MEET_READONLY_SCOPE]);

  // The ledger holds no space of its own — a meeting is wherever its document
  // is, which is what makes "move it to a company space" work with no extra
  // bookkeeping. So the space filter is a join through kb_documents.
  const { data: docs } = await db
    .from('kb_documents')
    .select('id')
    .eq('collection_id', spaceId)
    .eq('media_kind', 'meeting');
  const documentIds = (docs ?? []).map((d) => d.id as string);

  let meetings: ImportedMeetingRow[] = [];
  if (documentIds.length > 0) {
    const { data } = await db
      .from('meeting_imports')
      .select(
        'id, title, meeting_code, started_at, ended_at, participants, document_id, imported_at, status, error',
      )
      .in('document_id', documentIds)
      .order('started_at', { ascending: false })
      .limit(50);
    meetings = (data ?? []) as ImportedMeetingRow[];
  }

  return NextResponse.json({
    connected,
    meetings: meetings.map((m) => ({
      id: m.id,
      title: m.title,
      meetingCode: m.meeting_code,
      startedAt: m.started_at,
      durationMinutes:
        m.started_at && m.ended_at
          ? Math.max(0, Math.round((Date.parse(m.ended_at) - Date.parse(m.started_at)) / 60_000))
          : null,
      participants: m.participants ?? [],
      documentId: m.document_id,
      importedAt: m.imported_at,
      status: m.status,
      error: m.error,
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  const db = getSupabaseServiceClient();

  const body = (await req.json().catch(() => ({}))) as {
    spaceId?: string;
    meetCode?: string;
    lookbackDays?: number;
  };
  const spaceId = body.spaceId;
  const meetCode = body.meetCode?.trim();

  if (!spaceId) return NextResponse.json({ error: 'Missing spaceId' }, { status: 400 });
  if (!meetCode) {
    return NextResponse.json(
      { error: 'Paste the Meet link or its code, e.g. abc-defg-hij.' },
      { status: 400 },
    );
  }

  // Visibility here, writability inside the importer. Two checks rather than
  // one because "not yours" and "read-only for you" are different answers.
  try {
    await getVisibleSpace(db, session.id, spaceId);
  } catch {
    return NextResponse.json({ error: 'Space not found' }, { status: 404 });
  }

  const ctx: MeetingImportContext = {
    userId: session.id,
    db,
    integrations: createIntegrationsClient(db, session.id, logger),
    logger,
  };

  const result = await importMeetingTranscript(ctx, {
    meetCode,
    spaceId,
    lookbackDays: Math.min(Math.max(body.lookbackDays ?? 60, 1), 180),
  });

  // Never a 5xx: "no transcript" and "Google says no" are answers, not server
  // faults, and the panel renders each of them as its own sentence.
  return NextResponse.json({
    outcome: result.outcome,
    note: result.note,
    documentId: result.documentId,
    title: result.title,
    participants: result.participants,
    startedAt: result.startedAt,
    passages: result.chunks,
  });
}
