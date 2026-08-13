import { ScreenGlanceSchema } from '@/lib/screen-glance';
import { WATCH_RECENT_NOTICES, isRepeatNotice, parseWatchVerdict } from '@/lib/screen-watch';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { checkMeter, isRefused, watchModel } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { generateText } from 'ai';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
/**
 * Nadie está esperando esto. Si no alcanza a responder rápido, no responde: un
 * aviso que llega treinta segundos tarde habla de una pantalla que ya no está.
 */
export const maxDuration = 20;

/**
 * MIRAR Y CALLARSE.
 *
 * ===========================================================================
 * QUÉ ES ESTA RUTA
 * ===========================================================================
 * `/api/chat` responde preguntas. Esta no. Aquí llega UN fotograma de la
 * pestaña que alguien dejó bajo vigilancia, sin pregunta y sin conversación, y
 * lo único que se decide es si hay algo en esa imagen que valga la pena decir
 * en voz alta. La respuesta normal —la de la enorme mayoría de las llamadas—
 * es que no, y entonces esta ruta devuelve `{ aviso: null }` y no pasa nada más
 * en ningún lado.
 *
 * ===========================================================================
 * POR QUÉ ES UNA RUTA APARTE Y NO UN MODO DE /api/chat
 * ===========================================================================
 * Porque no comparte casi nada con un turno, y lo poco que comparte es lo que
 * hay que dejar por fuera:
 *
 *   NO HAY CONVERSACIÓN. No se crea, no se lee y no se escribe una. Un aviso no
 *   es un turno: no lleva herramientas, no busca en la memoria de la empresa, no
 *   cita fuentes y no queda guardado. Meterlo en la ruta de chat lo obligaría a
 *   cargar un agente, un prompt de sistema de nueve mil tokens y un catálogo de
 *   herramientas para preguntar «¿esto es un error?».
 *
 *   NO SE MIDE COMO UNA RESPUESTA. El medidor del plan cuenta respuestas, y una
 *   respuesta es algo que alguien pidió. Cobrarle a una persona del cupo de su
 *   plan por miradas que ella no solicitó sería exactamente al revés. Lo que sí
 *   se hace es LEER el medidor: un espacio de trabajo que ya se quedó sin plan
 *   no debería estar gastando en vigilancia de fondo, así que la mirada se
 *   descarta en silencio y la franja del cliente lo dice cuando pasa.
 *
 *   NO ES CONTENCIOSO. La ruta de chat la editan varias personas a la vez. Esta
 *   tiene un solo trabajo, cabe en una pantalla y su lógica delicada —el umbral,
 *   el tope y el parser del veredicto— vive en lib/screen-watch.ts, probada en
 *   Node sin llamar a nadie.
 *
 * ===========================================================================
 * NO SE GUARDA NADA. NI LA IMAGEN, NI EL AVISO.
 * ===========================================================================
 * El fotograma existe durante esta petición y se va con ella; el aviso vuelve al
 * navegador y se dibuja en el chat de esa sesión. Nada de esto toca `messages`.
 * Es la misma promesa que hace `CaptureContract`, sostenida hasta el final del
 * cable: si esta ruta escribiera el aviso en la conversación, la promesa de que
 * la vigilancia no deja rastro dejaría de ser cierta y habría que reescribir el
 * contrato en vez de el código.
 */

const Body = z.object({
  screen: ScreenGlanceSchema,
  /**
   * Los últimos avisos de esta sesión, para que el modelo no repita uno.
   *
   * El cliente ya filtra las repeticiones con `isRepeatNotice` — es más barato
   * decidirlo sin llamar a nadie — pero decírselo al modelo evita el gasto de
   * generar el duplicado y, sobre todo, le da la información que necesita para
   * decir algo NUEVO sobre la misma pantalla en vez de callarse del todo.
   */
  recent: z.array(z.string().max(240)).max(WATCH_RECENT_NOTICES).optional(),
});

/**
 * LA INSTRUCCIÓN, Y POR QUÉ CADA REGLA ESTÁ AQUÍ.
 *
 * El riesgo de esta función no es que se equivoque: es que hable. Un asistente
 * que comenta la pantalla se apaga el primer día, y se apaga para siempre —
 * nadie vuelve a encender algo que ya demostró ser ruido. Así que el prompt está
 * escrito entero alrededor de una sola idea: el silencio es la respuesta
 * correcta y hay que hacerla fácil de dar.
 *
 *   LA LISTA DE LO QUE SÍ. Cerrada y corta. Sin ella el modelo interpreta
 *   «relevante» como «interesante», y todo es interesante la primera vez que se
 *   ve. Un error, algo vencido, un campo mal puesto, una advertencia: cosas que
 *   le van a costar tiempo o plata a la persona si nadie se las dice.
 *
 *   LA LISTA DE LO QUE NO. Explícita, porque son justo las tentaciones: narrar
 *   lo que se ve, felicitar, sugerir mejoras, saludar, ofrecer ayuda. Todas
 *   suenan serviciales y todas son la razón por la que la gente apaga esto.
 *
 *   EL FORMATO. Dos posibilidades y ni una palabra más. `parseWatchVerdict`
 *   convierte en silencio cualquier cosa que no sea exactamente un aviso bien
 *   formado, así que un modelo conversador no produce ruido: produce nada.
 *
 *   UNA FRASE, EN SEGUNDA PERSONA, ÚTIL. «El RUT está vencido» no sirve tanto
 *   como «ese mensaje significa que el RUT está vencido»: lo que la persona
 *   necesita no es que le lean la pantalla, es que le traduzcan lo que dice.
 *
 *   LAS CLAVES NO SE LEEN. La misma promesa del contrato de captura y de
 *   `screenBlock` en lib/screen-glance.ts. Aquí hace más falta que allá: nadie
 *   pidió esta mirada, así que lo que quede a la vista quedó a la vista por
 *   accidente.
 *
 *   NO INVENTAR LO QUE NO SE ALCANZA A LEER. Un fotograma es la parte visible de
 *   una página, y un aviso seguro sobre un campo que estaba borroso es peor que
 *   ningún aviso: la persona actúa sobre él y no tiene cómo saber que era una
 *   suposición.
 */
const SYSTEM = [
  'Estás mirando la pantalla de alguien que trabaja en una empresa colombiana de logística, aduanas y flota. Te dejó vigilando una pestaña de su navegador para que le avises si ve algo que le convenga saber.',
  '',
  'Tu trabajo NO es comentar la pantalla. Es quedarte callado casi siempre y hablar sólo cuando hay algo concreto que le va a costar tiempo o plata si nadie se lo dice.',
  '',
  'AVISA sólo si en la imagen hay algo de esto:',
  '- Un mensaje de error, un rechazo o una operación que falló.',
  '- Un documento, un permiso o una póliza vencida o por vencer (RUT, SOAT, tecnomecánica, pólizas, licencias, certificados).',
  '- Una advertencia del sistema, un plazo que se está acabando, una alerta.',
  '- Un campo mal diligenciado: un dígito de más o de menos, un formato que no corresponde, una fecha imposible, un campo obligatorio vacío en un formulario que está a punto de enviarse.',
  '- Algo que se ve mal de una manera que la persona probablemente no notó.',
  '',
  'NO AVISES por nada de esto, aunque te parezca útil:',
  '- Contar lo que hay en pantalla, o que la página cargó, o que un formulario está bien.',
  '- Felicitar, animar, sugerir mejoras, proponer atajos, ofrecer ayuda o preguntar si necesita algo.',
  '- Un dato que ya está a la vista y la persona obviamente ya vio.',
  '- Algo de lo que no estés seguro porque el texto quedó cortado, pequeño o borroso. En ese caso, cállate: no supongas lo que no alcanzas a leer.',
  '',
  'Si en la imagen se ve una contraseña, una clave, un token o un código de verificación, no lo transcribas ni completo ni en parte.',
  '',
  'FORMATO — responde con UNA sola línea, exactamente en una de estas dos formas:',
  'NADA',
  'AVISO: <una frase corta, tuteando, que le diga qué pasa y qué significa>',
  '',
  'Ante la duda, NADA. Una mirada que no dice nada no le cuesta nada a nadie; un aviso de más le enseña a apagarte.',
].join('\n');

/** Espacio para «NADA» o una frase. Nada más largo es un aviso mal escrito. */
const MAX_ANSWER_TOKENS = 120;

export async function POST(req: NextRequest) {
  const user = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = Body.safeParse(body);
  // Un cuerpo mal formado no es un incidente que la persona deba ver: es una
  // mirada que no ocurre. Silencio, como todo lo demás que sale mal aquí.
  if (!parsed.success) return NextResponse.json({ aviso: null });

  const db = getOrgScopedClient(user.organization.id);

  // El plan, LEÍDO y no consumido. Ver la nota de arriba: el medidor cuenta
  // respuestas y aquí nadie preguntó nada, así que esto no suma — pero un
  // espacio sin cupo tampoco debería estar gastando en miradas de fondo. El
  // cliente apaga la vigilancia cuando ve `motivo: 'plan'`, en vez de seguir
  // pagando peticiones que siempre van a devolver lo mismo.
  const answers = await checkMeter(db, 'answers');
  if (isRefused(answers)) {
    return NextResponse.json({
      aviso: null,
      motivo: 'plan',
      mensaje:
        'Se acabaron las respuestas de tu plan este mes, así que apagué la vigilancia de la pantalla. ' +
        'Puedes seguir compartiendo la pestaña para preguntar cuando amplíes el plan.',
    });
  }

  const { screen, recent = [] } = parsed.data;

  try {
    const { text } = await generateText({
      model: watchModel(),
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            // La imagen primero y la instrucción después, igual que en un turno
            // con foto: el texto que se refiere al cuadro se lee después del
            // cuadro. Ver `attachScreenFrame` en lib/screen-glance.ts.
            { type: 'image', image: screen.base64, mimeType: screen.mimeType },
            {
              type: 'text',
              text: `Esto es lo que la persona tiene en pantalla ahora mismo. ¿Hay algo que valga la pena decirle?${
                recent.length > 0
                  ? `\n\nYa le avisaste esto hace un momento, no lo repitas:\n${recent
                      .map((r) => `- ${r}`)
                      .join('\n')}`
                  : ''
              }`,
            },
          ],
        },
      ],
      maxTokens: MAX_ANSWER_TOKENS,
      abortSignal: AbortSignal.timeout(12_000),
    });

    const aviso = parseWatchVerdict(text);
    // La segunda red contra la repetición, después de la del prompt. El modelo
    // que vuelve a ver el mismo banner de error vuelve a describirlo con otras
    // palabras, y decir dos veces lo mismo es la forma más rápida de que alguien
    // deje de leer la franja.
    if (!aviso || isRepeatNotice(aviso, recent)) return NextResponse.json({ aviso: null });

    return NextResponse.json({ aviso });
  } catch (err) {
    // Deliberadamente no se le muestra a nadie. Un aviso que no aparece es
    // indistinguible de una pantalla en la que no había nada que decir, que es
    // lo que ocurre casi siempre, y contarle a alguien que su vigilancia falló
    // es peor que el silencio: no hay nada que pueda hacer al respecto.
    logger.debug('watch glance failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ aviso: null });
  }
}
