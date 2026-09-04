import { randomUUID } from 'node:crypto';
import { mintBlobToken } from '@/lib/blob-token';
import { putFileDirect, removeFilesDirect } from '@/lib/files-db';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  LIVE_CALLS_BUCKET,
  archiveLiveMeeting,
  liveCallObjectPath,
  transcribeAudio,
} from '@cortex/agent-tools';
import { type UUID, logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Subir una grabación (audio o video) a Llamadas: Deepgram la transcribe,
 * Cortex la lee, y queda consultable como una llamada que el bot escuchó.
 */

const MEDIA = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/ogg',
  'audio/x-m4a',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

const MAX_BYTES = 200 * 1024 * 1024;

function baseMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'Falta el archivo de la grabación.' }, { status: 400 });
  }
  const mime = baseMime(file.type || 'application/octet-stream');
  if (!MEDIA.has(mime)) {
    return NextResponse.json(
      { error: 'Sube un audio o un video (mp3, wav, webm, m4a, mp4).' },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'Esa grabación pesa más de 200 MB.' }, { status: 400 });
  }

  const titleRaw = form?.get('title');
  const title =
    typeof titleRaw === 'string' && titleRaw.trim()
      ? titleRaw.trim().slice(0, 90)
      : file.name.replace(/\.[^.]+$/, '').slice(0, 90) || 'Grabación';
  const recordedRaw = form?.get('recordedAt');
  const startedAt =
    typeof recordedRaw === 'string' && !Number.isNaN(Date.parse(recordedRaw))
      ? Date.parse(recordedRaw)
      : Date.now();

  const buffer = Buffer.from(await file.arrayBuffer());
  const sessionId = `u_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const path = liveCallObjectPath(
    user.organization.id,
    sessionId,
    file.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'recording',
  );

  await putFileDirect({
    organizationId: user.organization.id,
    bucket: LIVE_CALLS_BUCKET,
    path,
    content: buffer,
    contentType: mime,
  });

  let listenUrl: string;
  try {
    const token = mintBlobToken({
      bucket: LIVE_CALLS_BUCKET,
      path,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    const origin = process.env.CORTEX_PUBLIC_URL?.replace(/\/+$/, '') || new URL(req.url).origin;
    listenUrl = `${origin}/api/files/blob/${token}`;
  } catch {
    await removeFilesDirect(LIVE_CALLS_BUCKET, [path]).catch(() => {});
    return NextResponse.json(
      { error: 'No pude firmar la grabación para transcribirla.' },
      { status: 500 },
    );
  }

  const heard = await transcribeAudio({ url: listenUrl }, { logger });
  if (!heard.ok) {
    await removeFilesDirect(LIVE_CALLS_BUCKET, [path]).catch(() => {});
    return NextResponse.json({ error: heard.reason }, { status: heard.retryable ? 503 : 422 });
  }

  const durationMs = Math.max(1, heard.data.durationSeconds) * 1000;
  const participants = heard.data.speakers.map((name) => ({
    id: name,
    name,
    self: false,
  }));
  const transcript = heard.data.turns.map((t) => ({
    text: t.text,
    speaker: t.speaker,
    at: t.startMs / 1000,
  }));

  try {
    const result = await archiveLiveMeeting(
      {
        organizationId: user.organization.id,
        userId: user.id as UUID,
        db: getOrgScopedClient(user.organization.id),
        logger,
        integrations: {
          getAccessToken: async () => {
            throw new Error('unused');
          },
          hasScopes: async () => false,
        },
      },
      {
        sessionId,
        meetUrl: 'https://meet.google.com/uploaded',
        botName: null,
        userId: user.id,
        startedAt,
        endedAt: startedAt + durationMs,
        status: 'ended',
        detail: title,
        participants,
        transcript,
        source: 'upload',
        recordingPath: path,
        recordingContentType: mime,
      },
    );
    return NextResponse.json({
      ...result,
      sessionId,
      title: result.title || title,
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, sessionId }, 'uploaded recording archive failed');
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
