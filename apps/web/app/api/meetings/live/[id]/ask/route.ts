import { decorateTimeline } from '@/lib/call-media';
import { getFileDirect } from '@/lib/files-db';
import { requireSession } from '@/lib/session';
import { mustRead } from '@/lib/supabase/read';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  LIVE_CALLS_BUCKET,
  chatModel,
  clockAt,
  formatTimelineForPrompt,
  normalizeTimeline,
  presentingFrames,
} from '@cortex/agent-tools';
import { generateText } from 'ai';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * PREGUNTARLE A CORTEX SOBRE LA REUNIÓN.
 *
 * En vivo: el transcript que está cayendo + la línea de tiempo (quién
 * compartió, capturas). Ya guardada: lo mismo desde `live_calls`, y si la
 * pregunta es visual se le mandan los fotogramas de lo compartido.
 */

const Body = z.object({ question: z.string().min(1).max(500) });

interface TranscriptLine {
  text: string;
  speaker: string | null;
  at: number;
}

const VISUAL_Q =
  /pantalla|compart|slide|diapos|excel|hoja|imagen|se ve|mostr|captura|frame|documento|cotiz/i;

function sampleLines(lines: TranscriptLine[]): TranscriptLine[] {
  if (lines.length <= 220) return lines;
  const step = Math.ceil(lines.length / 220);
  return lines.filter((_, i) => i % step === 0);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await ctx.params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'No entendí la pregunta.' }, { status: 400 });
  }

  const base = process.env.MEET_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.MEET_SERVICE_TOKEN;

  let snap: {
    transcript: TranscriptLine[];
    status: string;
    participants?: Array<{ name: string; speaking?: boolean }>;
    timeline?: unknown;
    insights?: { summary?: string; decisions?: string[]; commitments?: unknown } | null;
    title?: string | null;
  } | null = null;

  if (base && token) {
    snap = await fetch(
      `${base}/session/${encodeURIComponent(id)}?owner=${encodeURIComponent(user.organization.id)}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    )
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              transcript: TranscriptLine[];
              status: string;
              participants?: Array<{ name: string; speaking?: boolean }>;
              timeline?: unknown;
            }>)
          : null,
      )
      .catch(() => null);
  }

  if (!snap) {
    const archived = mustRead(
      await getOrgScopedClient(user.organization.id)
        .from('live_calls')
        .select('title, transcript, participants, status, timeline, insights')
        .eq('session_id', id)
        .maybeSingle(),
      'el transcript guardado de esa llamada',
    ) as {
      title: string | null;
      transcript: TranscriptLine[] | null;
      participants: Array<{ name: string }> | null;
      status: string | null;
      timeline: unknown;
      insights: { summary?: string; decisions?: string[] } | null;
    } | null;
    if (archived) {
      snap = {
        title: archived.title,
        transcript: archived.transcript ?? [],
        status: archived.status ?? 'ended',
        participants: archived.participants ?? [],
        timeline: archived.timeline,
        insights: archived.insights,
      };
    }
  }

  if (!snap) {
    return NextResponse.json({ error: 'Esa reunión ya no está disponible.' }, { status: 410 });
  }

  const people = (snap.participants ?? []).map((p) =>
    p.speaking ? `${p.name} (hablando ahora)` : p.name,
  );
  const peopleText = people.length ? people.join(', ') : '(aún no vi nombres en la sala)';
  const lines = sampleLines(snap.transcript);
  const transcriptText = lines.length
    ? lines
        .map((l) => `[${clockAt(l.at)}] ${l.speaker ? `${l.speaker}: ` : 'Alguien: '}${l.text}`)
        .join('\n')
    : '(todavía no se ha dicho nada transcribible en la reunión)';
  const timeline = normalizeTimeline(snap.timeline);
  const timelineText = formatTimelineForPrompt(timeline);
  const reading = snap.insights?.summary
    ? `LECTURA DE CORTEX${snap.title ? ` · ${snap.title}` : ''}: ${snap.insights.summary}`
    : '';

  const wantsVisual = VISUAL_Q.test(parsed.data.question);
  const imageFrames = wantsVisual ? presentingFrames(timeline, 4) : [];
  const images: Array<
    { type: 'text'; text: string } | { type: 'image'; image: string; mimeType: string }
  > = [];
  for (const frame of imageFrames) {
    if (!frame.path) continue;
    const file = await getFileDirect(LIVE_CALLS_BUCKET, frame.path);
    if (!file) continue;
    images.push({
      type: 'text',
      text: `Captura ${clockAt(frame.at)} · ${frame.speaker ?? 'sala'}${frame.caption ? ` — ${frame.caption}` : ''}`,
    });
    images.push({
      type: 'image',
      image: file.content.toString('base64'),
      mimeType: file.contentType ?? 'image/jpeg',
    });
  }

  const promptText = [
    `EN LA LLAMADA (${snap.status}):`,
    peopleText,
    reading,
    '',
    'LÍNEA DE TIEMPO (quién entró, quién compartió, capturas):',
    timelineText,
    '',
    'TRANSCRIPT (con minuto):',
    transcriptText,
    '',
    `PREGUNTA: ${parsed.data.question}`,
  ]
    .filter(Boolean)
    .join('\n');

  const { text } = await generateText({
    model: chatModel(),
    system:
      'Eres Cortex, junto a la persona, con el transcript y la línea de tiempo de una reunión. Responde SOLO con lo que aparece: quién estaba, lo que se dijo (cita el minuto m:ss), quién compartió y lo que se ve en las capturas. Si no está, dilo en una frase y no inventes. Sé breve y directo. Responde en español.',
    messages:
      images.length > 0
        ? [{ role: 'user', content: [{ type: 'text', text: promptText }, ...images] }]
        : [{ role: 'user', content: promptText }],
  });

  return NextResponse.json({ answer: text, timeline: decorateTimeline(timeline) });
}
