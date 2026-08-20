import { requireSession } from '@/lib/session';
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
  await requireSession();
  const { id } = await ctx.params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'No entendí la pregunta.' }, { status: 400 });
  }

  const base = process.env.MEET_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.MEET_SERVICE_TOKEN;
  if (!base || !token) {
    return NextResponse.json(
      { error: 'El bot de reuniones no está configurado.' },
      { status: 503 },
    );
  }

  // El transcript acumulado hasta ahora — la única fuente de esta respuesta.
  const snap = await fetch(`${base}/session/${encodeURIComponent(id)}/`, {
    headers: { authorization: `Bearer ${token}` },
  })
    .then((r) =>
      r.ok ? (r.json() as Promise<{ transcript: TranscriptLine[]; status: string }>) : null,
    )
    .catch(() => null);

  if (!snap) {
    return NextResponse.json({ error: 'Esa reunión ya no está disponible.' }, { status: 410 });
  }

  // Solo la cola: una reunión larga no cabe entera y lo reciente es lo que casi
  // siempre importa. Las últimas ~120 líneas cubren bastante contexto.
  const lines = snap.transcript.slice(-120);
  const transcriptText = lines.length
    ? lines.map((l) => `${l.speaker ? `${l.speaker}: ` : ''}${l.text}`).join('\n')
    : '(todavía no se ha dicho nada transcribible en la reunión)';

  const { text } = await generateText({
    model: chatModel(),
    system:
      'Eres Cortex, escuchando una reunión en vivo junto a la persona. Responde SOLO con lo que aparece en el transcript de abajo — es lo que se ha dicho en la llamada hasta ahora. Si la respuesta no está en el transcript, dilo en una frase y no inventes. Sé breve y directo: esto se lee mientras la reunión sigue. Cita a quién lo dijo cuando ayude. Responde en español.',
    prompt: `TRANSCRIPT DE LA REUNIÓN (hasta ahora):\n${transcriptText}\n\nPREGUNTA: ${parsed.data.question}`,
  });

  return NextResponse.json({ answer: text });
}
