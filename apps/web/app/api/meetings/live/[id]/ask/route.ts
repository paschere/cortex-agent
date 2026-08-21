import { requireSession } from '@/lib/session';
import { mustRead } from '@/lib/supabase/read';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { chatModel } from '@cortex/agent-tools';
import { generateText } from 'ai';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * PREGUNTARLE A CORTEX SOBRE LA REUNIÓN QUE ESTÁ PASANDO.
 *
 * ===========================================================================
 * POR QUÉ ESTA RUTA Y NO EL CHAT NORMAL
 * ===========================================================================
 * La sala de una reunión en vivo tiene una fuente que el chat normal no tiene:
 * el transcript de LO QUE SE ESTÁ DICIENDO, ahora. Una pregunta como «¿qué
 * acaba de decir Mateo del presupuesto?» no se contesta con Brain Knowledge ni
 * con herramientas — se contesta con las últimas frases de la sala. Así que
 * esta ruta arma el contexto con el transcript vivo (leído del bot) y responde
 * corto, sin el aparato de un turno completo: sin RAG, sin selección de
 * herramientas, sin persistir un hilo. Es un copiloto que mira la misma
 * pantalla que tú.
 *
 * Lo que NO hace: actuar. Aquí solo se responde sobre lo dicho. Si de la
 * reunión sale una acción («mándale el resumen a Ana»), esa se pide en el chat
 * normal, donde vive la maquinaria de confirmar y auditar.
 */

const Body = z.object({ question: z.string().min(1).max(500) });

interface TranscriptLine {
  text: string;
  speaker: string | null;
  at: number;
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

  // Primero el bot (la llamada sigue viva). Si ya colgó, el archivo.
  let snap: {
    transcript: TranscriptLine[];
    status: string;
    participants?: Array<{ name: string; speaking?: boolean }>;
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
            }>)
          : null,
      )
      .catch(() => null);
  }

  if (!snap) {
    const archived = mustRead(
      await getOrgScopedClient(user.organization.id)
        .from('live_calls')
        .select('transcript, participants, status')
        .eq('session_id', id)
        .maybeSingle(),
      'el transcript guardado de esa llamada',
    ) as {
      transcript: TranscriptLine[] | null;
      participants: Array<{ name: string }> | null;
      status: string | null;
    } | null;
    if (archived) {
      snap = {
        transcript: archived.transcript ?? [],
        status: archived.status ?? 'ended',
        participants: archived.participants ?? [],
      };
    }
  }

  if (!snap) {
    return NextResponse.json({ error: 'Esa reunión ya no está disponible.' }, { status: 410 });
  }

  // Solo la cola: una reunión larga no cabe entera y lo reciente es lo que casi
  // siempre importa. Las últimas ~120 líneas cubren bastante contexto.
  const people = (snap.participants ?? []).map((p) =>
    p.speaking ? `${p.name} (hablando ahora)` : p.name,
  );
  const peopleText = people.length ? people.join(', ') : '(aún no vi nombres en la sala)';
  const lines = snap.transcript.slice(-120);
  const transcriptText = lines.length
    ? lines.map((l) => `${l.speaker ? `${l.speaker}: ` : 'Alguien: '}${l.text}`).join('\n')
    : '(todavía no se ha dicho nada transcribible en la reunión)';

  const { text } = await generateText({
    model: chatModel(),
    system:
      'Eres Cortex, junto a la persona, con el transcript de una reunión. Responde SOLO con lo que aparece abajo: quién estaba en la sala y el transcript. Si la respuesta no está ahí, dilo en una frase y no inventes. Sé breve y directo. Cita a quién lo dijo. Responde en español.',
    prompt: `EN LA LLAMADA AHORA:\n${peopleText}\n\nTRANSCRIPT:\n${transcriptText}\n\nPREGUNTA: ${parsed.data.question}`,
  });

  return NextResponse.json({ answer: text });
}
