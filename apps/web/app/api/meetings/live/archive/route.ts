import { createHash, timingSafeEqual } from 'node:crypto';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { archiveLiveMeeting } from '@cortex/agent-tools';
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

export async function POST(req: NextRequest) {
  if (!tokenOk(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 });
  const body = parsed.data;

  const userId = await actorUserId(body.owner, body.userId);
  if (!userId) {
    return NextResponse.json({ error: 'no-actor' }, { status: 500 });
  }

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
      },
    );
    return NextResponse.json(result);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, sessionId: body.sessionId },
      'live call archive failed',
    );
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
