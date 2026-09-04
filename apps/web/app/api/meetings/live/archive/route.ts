import { createHash, timingSafeEqual } from 'node:crypto';
import { getFileDirect } from '@/lib/files-db';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  LIVE_CALLS_BUCKET,
  applyCaptions,
  archiveLiveMeeting,
  captionCallFrames,
  normalizeTimeline,
  presentingFrames,
} from '@cortex/agent-tools';
import { type UUID, logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * El bot de reuniones cuelga y manda aquí lo que oyó, para que no se pierda
 * a los 30 segundos. Autenticado con el token de servicio — igual que
 * voice-answer: infraestructura hablando con infraestructura.
 */

const Line = z.object({
  text: z.string(),
  speaker: z.string().nullable(),
  at: z.number(),
});

const Person = z.object({
  id: z.string(),
  name: z.string(),
  self: z.boolean().optional(),
});

const Event = z.object({
  at: z.number(),
  kind: z.enum(['joined', 'left', 'presenting', 'presenting-end', 'frame']),
  label: z.string().max(240),
  speaker: z.string().max(80).nullable().optional(),
  path: z.string().max(240).nullable().optional(),
  caption: z.string().max(280).nullable().optional(),
});

const Body = z.object({
  owner: z.string().min(1),
  userId: z.string().uuid().optional(),
  sessionId: z.string().min(1).max(80),
  meetUrl: z.string().url(),
  botName: z.string().max(40).optional(),
  startedAt: z.number().int().positive(),
  endedAt: z.number().int().positive().optional(),
  status: z.enum(['ended', 'failed']),
  detail: z.string().max(500).nullable().optional(),
  participants: z.array(Person).max(80).default([]),
  transcript: z.array(Line).max(8_000).default([]),
  timeline: z.array(Event).max(400).default([]),
});

function tokenOk(req: NextRequest): boolean {
  const expected = process.env.MEET_SERVICE_TOKEN;
  if (!expected) return false;
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

async function actorUserId(orgId: string, presented?: string): Promise<string | null> {
  if (presented) return presented;
  const db = getOrgScopedClient(orgId);
  const { data } = await db.from('users').select('id').limit(1).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

async function captionSavedTimeline(
  orgId: string,
  callId: string,
  raw: unknown,
): Promise<void> {
  const timeline = normalizeTimeline(raw);
  const frames = presentingFrames(timeline, 5);
  if (frames.length === 0) return;
  const loaded = [];
  for (const frame of frames) {
    if (!frame.path) continue;
    const file = await getFileDirect(LIVE_CALLS_BUCKET, frame.path);
    if (!file) continue;
    loaded.push({
      at: frame.at,
      label: frame.label,
      speaker: frame.speaker,
      image: file.content.toString('base64'),
      mimeType: file.contentType ?? 'image/jpeg',
    });
  }
  if (loaded.length === 0) return;
  const captions = await captionCallFrames(loaded);
  const next = applyCaptions(timeline, loaded, captions);
  await getOrgScopedClient(orgId).from('live_calls').update({ timeline: next }).eq('id', callId);
}

export async function POST(req: NextRequest) {
  if (!tokenOk(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 });
  const body = parsed.data;

  const userId = await actorUserId(body.owner, body.userId);
  if (!userId) {
    return NextResponse.json({ error: 'no-actor' }, { status: 500 });
  }

  const timeline = normalizeTimeline(body.timeline);

  try {
    const result = await archiveLiveMeeting(
      {
        organizationId: body.owner,
        userId: userId as UUID,
        db: getOrgScopedClient(body.owner),
        logger,
        integrations: {
          getAccessToken: async () => {
            throw new Error('unused');
          },
          hasScopes: async () => false,
        },
      },
      {
        sessionId: body.sessionId,
        meetUrl: body.meetUrl,
        botName: body.botName,
        userId,
        startedAt: body.startedAt,
        endedAt: body.endedAt ?? Date.now(),
        status: body.status,
        detail: body.detail ?? null,
        participants: body.participants,
        transcript: body.transcript,
        timeline,
      },
    );
    try {
      await captionSavedTimeline(body.owner, result.callId, timeline);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, sessionId: body.sessionId },
        'live call frame captions failed',
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, sessionId: body.sessionId },
      'live call archive failed',
    );
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
