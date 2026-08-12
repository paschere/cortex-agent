import {
  MAX_QUESTIONS,
  type SetupItem,
  STOP_COPY,
  type StopReason,
  decideStop,
} from '@/lib/guided-setup-shape';
import { type InterviewContext, askNext, propose } from '@/lib/guided-setup/interview';
import { appendTurns, getSession, savePlan, startSession } from '@/lib/guided-setup/store';
import type { Session, Turn } from '@/lib/guided-setup/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
/** Dos llamadas al modelo en el peor turno (preguntar y luego proponer). */
export const maxDuration = 120;

/**
 * UN TURNO DE LA ENTREVISTA DE PUESTA EN MARCHA.
 *
 * ===========================================================================
 * POR QUÉ NO ES EL ROUTE DEL CHAT
 * ===========================================================================
 * El motor es el mismo — el mismo modelo, el mismo SDK — pero el trabajo no. El
 * chat responde preguntas con herramientas y streaming; esto conduce una
 * entrevista con un tope de preguntas, un catálogo cerrado y un plan que se
 * guarda antes de que nadie apruebe nada. Meterlo dentro del route del chat
 * significaría enseñarle a ese archivo un modo que no tiene nada que ver con
 * responder, y ese archivo ya carga con demasiado.
 *
 * Tampoco hay streaming aquí, y no por comodidad: el turno no produce prosa que
 * valga la pena ver aparecer letra por letra. Produce UNA pregunta, o produce
 * un plan entero que se muestra de golpe porque se lee como una lista. Un plan
 * que aparece a medias es un plan que alguien empieza a leer antes de que esté
 * completo, y esta pantalla existe para que nadie apruebe nada a medio leer.
 *
 * ===========================================================================
 * EL SERVIDOR LLEVA LA CUENTA
 * ===========================================================================
 * El cliente manda una frase y el id de la sesión. Nada más. Ni el hilo, ni el
 * número de preguntas, ni el plan viajan de ida para que el servidor se los
 * crea: el tope de preguntas y la lista de lo aprobable son las dos reglas que
 * sostienen esta pantalla, y una regla que viaja por la red es una regla que se
 * puede editar con las herramientas del navegador.
 */

const Body = z.object({
  sessionId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(4000),
  /** «Ya, muéstrame lo que tienes». Salta las preguntas que queden. */
  finish: z.boolean().optional(),
});

/**
 * Cuando el piso de la regla de parada exige una pregunta y el modelo no trajo
 * ninguna. Pasa cuando alguien escribe cuatro palabras: el modelo cree que ya
 * puede proponer y no puede, porque no hay nada de dónde.
 */
const FALLBACK_QUESTION =
  'Cuéntame un poco más: ¿qué hace la empresa y qué es lo que más se les enreda en el día a día?';

export async function POST(req: NextRequest) {
  const user = await requireSession();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'No entendí lo que llegó.' }, { status: 400 });
  }
  const { message, finish } = parsed.data;

  const db = getOrgScopedClient(user.organization.id);

  let session: Session | null = null;
  if (parsed.data.sessionId) {
    session = await getSession(db, parsed.data.sessionId);
    // Un id de otra empresa simplemente no devuelve fila: el handle con alcance
    // ya filtró. Se responde igual que a un id que no existe, a propósito.
    if (!session) {
      return NextResponse.json({ error: 'Esa conversación ya no está.' }, { status: 404 });
    }
    if (session.status !== 'interviewing') {
      return NextResponse.json(
        { error: 'Esa entrevista ya terminó. Empieza una nueva.' },
        { status: 409 },
      );
    }
  } else {
    session = await startSession(db, user.id);
  }

  const now = new Date().toISOString();
  const personTurn: Turn = { role: 'person', text: message, at: now };
  const turns: Turn[] = [...session.transcript, personTurn];
  const answers = turns.filter((t) => t.role === 'person').map((t) => t.text);

  const ctx: InterviewContext = {
    companyName: user.organization.name,
    today: bogotaToday(),
    canCreateGlobalSpace: user.role === 'org_admin',
  };

  // ¿Hay que parar antes siquiera de gastar una llamada en preguntar?
  let stop: StopReason | null = decideStop({
    askedCount: session.askedCount,
    modelSaysEnough: false,
    answers,
    forced: finish === true,
  });
  let note = '';

  if (!stop) {
    let ask: Awaited<ReturnType<typeof askNext>>;
    try {
      ask = await askNext(turns, session.askedCount, ctx);
    } catch (err) {
      logger.error({ err }, 'guided-setup: ask failed');
      return NextResponse.json(
        { error: 'No pude seguir la conversación ahora mismo. Vuelve a intentar.' },
        { status: 502 },
      );
    }
    note = ask.note;

    const after = decideStop({
      askedCount: session.askedCount,
      modelSaysEnough: ask.enough,
      answers,
      forced: false,
    });

    if (!after) {
      // Se sigue preguntando. El piso puede exigir una pregunta que el modelo no
      // trajo; en ese caso se hace la que abre cualquier conversación.
      const question = ask.question ?? FALLBACK_QUESTION;
      const asked = session.askedCount + 1;
      const cortexTurn: Turn = {
        role: 'cortex',
        text: [note, question].filter(Boolean).join(' '),
        at: new Date().toISOString(),
      };
      await appendTurns(db, session, [personTurn, cortexTurn], asked);
      return NextResponse.json({
        sessionId: session.id,
        status: 'interviewing',
        note,
        question,
        askedCount: asked,
        remaining: Math.max(0, MAX_QUESTIONS - asked),
      });
    }
    stop = after;
  }

  // Se propone. El turno de la persona se guarda aunque proponer falle: lo que
  // dijo no se pierde porque el modelo se haya caído.
  await appendTurns(db, session, [personTurn], session.askedCount);

  let proposal: Awaited<ReturnType<typeof propose>>;
  try {
    proposal = await propose(turns, ctx);
  } catch (err) {
    logger.error({ err }, 'guided-setup: propose failed');
    return NextResponse.json(
      { error: 'No pude armar la propuesta ahora mismo. Vuelve a intentar en un momento.' },
      { status: 502 },
    );
  }

  const items: SetupItem[] = await savePlan(db, session.id, {
    summary: proposal.summary,
    items: proposal.items,
    outOfScope: proposal.outOfScope,
    handoffs: proposal.handoffs,
  });

  // Lo que el catálogo rechazó no se le muestra a nadie — sería enseñar una
  // propuesta rota — pero se registra: es la lista de dónde el modelo se sale
  // de lo que el producto sabe hacer, y es lo que hay que mirar para afinarlo.
  if (proposal.rejected.length > 0) {
    logger.info(
      { organizationId: user.organization.id, rejected: proposal.rejected },
      'guided-setup: propuestas fuera del catálogo',
    );
  }

  return NextResponse.json({
    sessionId: session.id,
    status: 'proposed',
    stopReason: stop,
    stopNote: STOP_COPY[stop],
    summary: proposal.summary,
    items,
    handoffs: proposal.handoffs,
    outOfScope: proposal.outOfScope,
  });
}
