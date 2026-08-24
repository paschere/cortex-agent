import 'server-only';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type NotifyInput, notify } from './notify';

/**
 * QUIÉN AVISA DE QUÉ, Y SOBRE TODO DE QUÉ NO.
 *
 * ===========================================================================
 * LA REGLA
 * ===========================================================================
 * UN AVISO ES EL CANAL DE ÚLTIMA INSTANCIA. Si el hecho ya viajó por un canal
 * que la persona mira —un correo, un DM de Google Chat, un mensaje en la
 * conversación donde lo pidió— no se repite aquí. Las dos excepciones son los
 * FRACASOS y lo que PIDE ALGO DE LA PERSONA, donde llegar dos veces cuesta
 * mucho menos que no llegar.
 *
 * De ahí sale, aplicada igual en los cuatro productores:
 *
 *   salió bien y ya se entregó por otro canal   →  no se avisa
 *   salió bien y no había otro canal            →  se avisa
 *   falló                                       →  se avisa siempre
 *   se paró a pedir algo                        →  se avisa siempre
 *
 * Sin esta regla, cada rutina con correo activado produciría dos noticias
 * idénticas todas las mañanas, y la campana sería el sitio donde se vuelve a
 * leer lo que ya se leyó. Eso es exactamente cómo muere un centro de avisos.
 *
 * ===========================================================================
 * LO QUE NO SE AVISA, Y NO ES UN OLVIDO
 * ===========================================================================
 *   * NADA QUE SEA UNA COLA. Una aprobación esperando, una acción propuesta,
 *     un compromiso que vence, un encargo bloqueado en la lista: eso es ESTADO
 *     y vive en /approvals, /actions, /commitments y /errands, con su contador
 *     en el menú y su índice en /dashboard. Sigue siendo verdad mañana, así que
 *     un aviso o lo repetiría (ruido) o dejaría de ser cierto (mentira).
 *   * EL PROGRESO. Ni las etapas de un trámite, ni las piernas de un encargo,
 *     ni «empezó a correr». Sólo desenlaces.
 *   * LO QUE HIZO LA PROPIA PERSONA hace un segundo: aprobar, editar, crear.
 *     Eso ya lo dice la pantalla en la que estaba, y el registro de quién hizo
 *     qué es `audit_events` desde la 0033.
 *   * UN VENCIMIENTO QUE SIGUE VENCIDO. «Se venció ayer y nadie hizo nada» sí
 *     sería un aviso legítimo, y una sola vez; el gancho natural es
 *     `inngest/functions/commitments-watch.ts`, que ya lleva su propio libro de
 *     avisos enviados en `commitment_notices` para no repetirse. Se deja fuera
 *     de esta primera entrega justamente para no duplicar ese libro a medias.
 *
 * ===========================================================================
 * NUNCA LANZAN
 * ===========================================================================
 * Cuando se llama a cualquiera de estas funciones, el trabajo del que hablan ya
 * ocurrió. Un fallo escribiendo el recado se registra y se traga: lo peor que
 * puede pasar es volver al comportamiento que había antes de que este módulo
 * existiera, que era no avisar de nada.
 */

async function quietly(db: SupabaseClient, input: NotifyInput, where: string): Promise<void> {
  try {
    await notify(db, input);
  } catch (err) {
    logger.error(`notifications: ${where} no pudo dejar el aviso`, {
      kind: input.kind,
      error: (err as Error).message,
    });
  }
}

/** Recorta al vuelo lo que va dentro de una frase, sin cortar a mitad de nada. */
function short(text: string | null | undefined, max: number): string {
  const trimmed = (text ?? '').replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// ---------------------------------------------------------------------------
// Trámites web (migración 0087)
// ---------------------------------------------------------------------------

export interface FlowRunNote {
  /** Quien pidió la corrida. Es el único destinatario posible. */
  userId: string;
  flow: { id: string; name: string; site: string };
  /** La corrida, para que el aviso apunte a un hecho y no a un trámite. */
  runId: string | null;
  ok: boolean;
  /** La frase que ya produce el motor. Nunca contiene una credencial. */
  message: string;
  failureKind?: 'transient' | 'legitimate' | 'site-changed' | 'needs-login' | 'needs-human' | null;
  /**
   * El motor se paró a pedir algo. No es un fallo, y CUÁL de las tres cosas
   * decide qué dice el aviso: pedir la clave del portal manda a vincular una
   * cuenta y no corre prisa; pedir un código o resolver un captcha tiene una
   * pestaña abierta detrás que se cierra en minutos.
   */
  pendingQuestion?: 'credential' | 'input' | 'unlock' | null;
  /** True si el resultado ya salió por correo, por Chat o a la conversación. */
  deliveredElsewhere: boolean;
  /**
   * La corrida de verificación que sigue a enseñar una grabación. Nunca avisa:
   * la persona acaba de subir el vídeo y está mirando la pantalla que le va a
   * decir si la lectura fue buena. Un aviso ahí es una notificación sobre algo
   * que está pasando delante de sus ojos.
   */
  verifying?: boolean;
}

/**
 * Un trámite que terminó, falló o se paró a pedir algo.
 *
 * Se llama desde `lib/browser-delivery.ts`, que es por donde pasa todo
 * resultado de trámite del producto: así el aviso no depende de que cada sitio
 * que corre un trámite se acuerde. Ver el informe: `browser/tools.ts` (el
 * trámite corrido desde el chat) todavía no pasa por ahí.
 */
export async function noteFlowRun(db: SupabaseClient, note: FlowRunNote): Promise<void> {
  if (note.verifying) return;
  if (!note.userId) return;

  const name = short(note.flow.name, 60);
  // El agrupado se ancla AL TRÁMITE y no a la corrida: un trámite que falla
  // cuatro veces esta mañana es un problema, no cuatro noticias. La corrida
  // viaja como origen para poder llegar a ella.
  const source = note.runId ? ({ kind: 'flow_run', id: note.runId } as const) : null;
  const href = '/browser';

  // Se paró a pedir algo que sólo una persona puede dar: la clave del portal, o
  // el «demuestra que eres humano» que abre el propio portal. Es el caso que
  // más caro sale callar — hay una pestaña abierta esperando y se cierra sola.
  // El trámite llegó hasta el sitio donde hace falta una persona AHORA: un
  // código que acaba de llegar al celular, o un «no soy un robot». La pestaña
  // sigue abierta y se cierra sola, así que este aviso es el que menos puede
  // esperar de todos los que produce este archivo.
  if (note.pendingQuestion === 'input' || note.pendingQuestion === 'unlock') {
    await quietly(
      db,
      {
        userId: note.userId,
        kind: 'flow_needs_person',
        title:
          note.pendingQuestion === 'input'
            ? `El trámite «${name}» te está pidiendo un dato`
            : `El trámite «${name}» pide una verificación`,
        body: `${short(note.message, 300)} Contéstale desde Trámites o desde el chat; la sesión sigue abierta pero dura pocos minutos.`,
        href,
        source,
        // Sin agrupar con las de credencial: son dos cosas distintas que hacer
        // y fundirlas escondería la que tiene reloj.
        groupKey: `flow_waiting:${note.flow.id}`,
      },
      'un trámite',
    );
    return;
  }

  if (note.pendingQuestion === 'credential' || note.failureKind === 'needs-login') {
    await quietly(
      db,
      {
        userId: note.userId,
        kind: 'flow_needs_person',
        title: `El trámite «${name}» necesita la clave de ${short(note.flow.site, 40)}`,
        body: 'Se quedó parado antes de entrar al portal. Vincúlale la cuenta desde Trámites y vuelve a lanzarlo.',
        href,
        source,
        groupKey: `flow_needs_person:${note.flow.id}`,
      },
      'un trámite',
    );
    return;
  }

  if (note.failureKind === 'needs-human') {
    await quietly(
      db,
      {
        userId: note.userId,
        kind: 'flow_needs_person',
        title: `El trámite «${name}» pide una verificación`,
        body: `${short(note.message, 300)} Entra a Trámites para resolverla; la ventana dura pocos minutos.`,
        href,
        source,
        groupKey: `flow_needs_person:${note.flow.id}`,
      },
      'un trámite',
    );
    return;
  }

  if (!note.ok) {
    await quietly(
      db,
      {
        userId: note.userId,
        kind: 'flow_failed',
        title: `El trámite «${name}» no pudo terminar`,
        body: short(note.message, 400),
        href,
        source,
        groupKey: `flow_failed:${note.flow.id}`,
      },
      'un trámite',
    );
    return;
  }

  // Salió bien. Si ya se lo mandamos por correo o al chat, la campana callaría
  // por la regla de arriba.
  if (note.deliveredElsewhere) return;

  await quietly(
    db,
    {
      userId: note.userId,
      kind: 'flow_finished',
      title: `El trámite «${name}» terminó`,
      body: short(note.message, 400),
      href,
      source,
      groupKey: `flow_finished:${note.flow.id}`,
    },
    'un trámite',
  );
}

// ---------------------------------------------------------------------------
// Rutinas (scheduled_jobs)
// ---------------------------------------------------------------------------

export interface RoutineRunNote {
  userId: string;
  job: { id: string; name: string };
  runId: string | null;
  ok: boolean;
  /** Lo que dijo el fallo, ya recortado por quien corrió la rutina. */
  error?: string | null;
  /** True si la rutina tiene correo, Chat o conversación configurados. */
  deliveredElsewhere: boolean;
}

/**
 * Una rutina que corrió, o que no pudo.
 *
 * EL ÉXITO SÓLO SE AVISA CUANDO LA RUTINA NO TIENE OTRO CANAL. Una rutina con
 * correo activado que corre bien todas las mañanas es, por definición, la cosa
 * menos noticiable del producto: ya llega a un sitio que la persona mira, y
 * repetirla aquí llenaría la bandeja con lo único que nunca hace falta leer.
 * Una rutina SIN canal es lo contrario: hoy corre y termina en silencio, y la
 * campana es la única forma de enterarse de que existe.
 */
export async function noteRoutineRun(db: SupabaseClient, note: RoutineRunNote): Promise<void> {
  if (!note.userId) return;
  const name = short(note.job.name, 60);
  const href = `/schedules/${note.job.id}`;
  const source = note.runId ? ({ kind: 'routine_run', id: note.runId } as const) : null;

  if (!note.ok) {
    await quietly(
      db,
      {
        userId: note.userId,
        kind: 'routine_failed',
        title: `La rutina «${name}» no pudo correr`,
        body: `${short(note.error, 340)} Abre la rutina para ver la corrida completa y volver a lanzarla.`,
        href,
        source,
        // Anclado a la rutina y no a la corrida: una rutina rota cada hora es un
        // problema con un contador, no veinticuatro noticias al día.
        groupKey: `routine_failed:${note.job.id}`,
      },
      'una rutina',
    );
    return;
  }

  if (note.deliveredElsewhere) return;

  await quietly(
    db,
    {
      userId: note.userId,
      kind: 'routine_finished',
      title: `La rutina «${name}» corrió`,
      body: 'Terminó sin problemas. El resultado está en la corrida; la rutina no tiene ningún canal de entrega configurado.',
      href,
      source,
      groupKey: `routine_finished:${note.job.id}`,
    },
    'una rutina',
  );
}

// ---------------------------------------------------------------------------
// Encargos (migración 0089)
// ---------------------------------------------------------------------------

export interface ErrandAskedNote {
  userId: string | null;
  errandId: string;
  /** Lo que la persona pidió, con sus palabras. */
  request: string;
  question: string;
  /** True si la pregunta ya se puso en la conversación donde nació el encargo. */
  deliveredInChat: boolean;
}

/**
 * Un encargo que se atascó y preguntó algo.
 *
 * SE AVISA AUNQUE LA PREGUNTA YA HAYA IDO AL CHAT, y es la excepción explícita
 * a la regla de no duplicar. Un encargo bloqueado cuesta lo mismo que uno
 * trabajando y no entrega nada mientras espera, y el mensaje del chat se lo
 * lleva el scroll de la siguiente conversación. Ésta es la clase de aviso en la
 * que fallar por exceso es claramente lo barato.
 */
export async function noteErrandAsked(db: SupabaseClient, note: ErrandAskedNote): Promise<void> {
  if (!note.userId) return;
  await quietly(
    db,
    {
      userId: note.userId,
      kind: 'errand_asked',
      title: `Un encargo te preguntó algo: ${short(note.request, 70)}`,
      body: note.deliveredInChat
        ? `${short(note.question, 300)} También te lo dejé en la conversación donde lo pediste.`
        : `${short(note.question, 340)} Respóndele desde el encargo y sigue desde donde iba.`,
      href: `/errands/${note.errandId}`,
      source: { kind: 'errand', id: note.errandId },
      // Un encargo sólo puede tener una pregunta abierta a la vez (índice de la
      // 0089), así que anclarlo al encargo agrupa exactamente lo que hay que
      // agrupar: preguntar, que le respondan, y volver a preguntar más tarde.
      groupKey: `errand_asked:${note.errandId}`,
    },
    'un encargo',
  );
}

export interface ErrandFinishedNote {
  userId: string | null;
  errandId: string;
  request: string;
  state: 'delivered' | 'failed' | 'exhausted' | 'cancelled';
  /** True si el resultado ya se puso en la conversación donde nació. */
  deliveredInChat: boolean;
}

/**
 * Un encargo que terminó.
 *
 * `cancelled` no avisa nunca: lo canceló una persona, en una pantalla, hace un
 * segundo. Contarle a alguien lo que acaba de hacer es la definición de ruido.
 */
export async function noteErrandFinished(
  db: SupabaseClient,
  note: ErrandFinishedNote,
): Promise<void> {
  if (!note.userId) return;
  if (note.state === 'cancelled') return;
  if (note.state === 'delivered' && note.deliveredInChat) return;

  const what = short(note.request, 70);
  const good = note.state === 'delivered';

  await quietly(
    db,
    {
      userId: note.userId,
      kind: 'errand_finished',
      tone: good ? 'good' : 'warning',
      title: good
        ? `Terminé el encargo: ${what}`
        : note.state === 'exhausted'
          ? `Cerré el encargo al llegar a su tope: ${what}`
          : `El encargo no pudo terminar: ${what}`,
      body: good
        ? 'El resultado y sus fuentes están en la pantalla del encargo.'
        : 'Entra al encargo para ver hasta dónde llegó y con qué se quedó.',
      href: `/errands/${note.errandId}`,
      source: { kind: 'errand', id: note.errandId },
      groupKey: `errand_finished:${note.errandId}`,
    },
    'un encargo',
  );
}

// ---------------------------------------------------------------------------
// Acciones (migración 0077)
// ---------------------------------------------------------------------------

export interface ActionSentNote {
  userId: string | null;
  actionId: string;
  /** A quién iba y de qué, sacado de la fila. Nunca del cuerpo del correo. */
  to: string | null;
  subject: string | null;
  ok: boolean;
  error?: string | null;
}

/**
 * Una acción aprobada que salió — o que no.
 *
 * SE AVISA TAMBIÉN CUANDO SALE BIEN, y sí, muchas veces la persona acaba de
 * pulsar Aprobar y lo está viendo. La diferencia con los otros productores es
 * que aquí el hecho es que ALGO SALIÓ DE LA EMPRESA con la firma de alguien, y
 * eso merece un renglón fechado que sobreviva a la pantalla: una acción se
 * puede aprobar desde Google Chat o desde Claude por MCP, sin ninguna pantalla
 * de por medio, y el correo sale igual.
 */
export async function noteActionSent(db: SupabaseClient, note: ActionSentNote): Promise<void> {
  if (!note.userId) return;
  const subject = short(note.subject, 70) || 'sin asunto';
  const to = short(note.to, 60);

  await quietly(
    db,
    {
      userId: note.userId,
      kind: note.ok ? 'action_sent' : 'action_failed',
      title: note.ok
        ? to
          ? `Se envió «${subject}» a ${to}`
          : `Se envió «${subject}»`
        : `No se pudo enviar «${subject}»`,
      body: note.ok
        ? 'Salió con tu firma, después de que lo aprobaras.'
        : `${short(note.error, 340)} La acción quedó aprobada y marcada como fallida: pídemela de nuevo cuando quieras reintentarlo.`,
      href: '/actions',
      source: { kind: 'action', id: note.actionId },
      // Por acción y no por destinatario: cada acción es un envío distinto, y
      // fundir dos correos distintos en una línea escondería uno de los dos.
      groupKey: `action:${note.actionId}`,
    },
    'una acción',
  );
}

// ---------------------------------------------------------------------------

export interface WeeklyReportNote {
  userId: string | null;
  reportId: string;
  /** Cómo se llama la semana que reporta, ya escrito: «del 3 al 9 de agosto». */
  periodLabel: string;
  /** Por qué no salió el correo. Se enseña tal cual, recortada. */
  reason: string | null;
}

/**
 * El parte semanal quedó guardado y el correo NO llegó.
 *
 * ESTE PRODUCTOR SÓLO SE LLAMA EN ESE CASO, y es la regla de la 0096 aplicada
 * al pie de la letra: si el correo salió, la campana no lo repite. Un aviso
 * diciendo «tienes un informe nuevo» junto a un correo con el informe dentro es
 * exactamente cómo la campana se convierte en el sitio donde se relee lo que ya
 * se leyó.
 *
 * Cuando el correo falla, en cambio, este aviso es el ÚNICO rastro de que la
 * semana se reportó. Sin él, el parte del lunes existiría en una tabla que nadie
 * va a mirar por su cuenta, y el producto habría rendido cuentas al vacío.
 */
export async function noteWeeklyReportUndelivered(
  db: SupabaseClient,
  note: WeeklyReportNote,
): Promise<void> {
  if (!note.userId) return;

  await quietly(
    db,
    {
      userId: note.userId,
      kind: 'report_ready',
      title: `El parte de la semana ${short(note.periodLabel, 80)} está listo`,
      body: `No se pudo enviar por correo: ${short(note.reason, 300) || 'motivo desconocido'}. Está guardado en Informes.`,
      href: `/reports/${note.reportId}`,
      source: { kind: 'report', id: note.reportId },
      // Por informe: cada semana es un parte distinto, y fundir dos semanas en
      // una línea escondería una de las dos.
      groupKey: `report:${note.reportId}`,
    },
    'el parte semanal',
  );
}

// ---------------------------------------------------------------------------
// El buzón que Cortex ya no puede leer
// ---------------------------------------------------------------------------

export interface MailboxLearningNote {
  userId: string;
  /** La dirección, para que el aviso diga CUÁL cuenta se cayó. */
  mailbox: string | null;
}

/**
 * Cortex dejó de poder leer el buzón de alguien y apagó el aprendizaje.
 *
 * PASA LOS DOS FILTROS DE ESTE MÓDULO, que es la única razón por la que existe:
 * es un FRACASO, y PIDE ALGO de la persona (volver a conectar su cuenta). Todo
 * lo demás que produce el barrido de correo —lo que archivó, lo que propuso— es
 * cola y estado, vive en /actions y en el cerebro, y no se avisa.
 *
 * `routine_failed` y no una clase nueva: para el que lo lee esto ES una rutina
 * suya que dejó de correr, y añadir una clase obliga a una migración que
 * ensancha un `check` compartido para no decir nada distinto.
 *
 * SE AGRUPA POR PERSONA Y NO POR DÍA. Un permiso revocado sigue revocado mañana
 * y pasado; sin este agrupado, la campana tendría una línea idéntica cada
 * mañana hasta que alguien la mirara, que es justo cómo se aprende a no
 * mirarla.
 */
export async function noteMailboxLearningStopped(
  db: SupabaseClient,
  note: MailboxLearningNote,
): Promise<void> {
  if (!note.userId) return;

  await quietly(
    db,
    {
      userId: note.userId,
      kind: 'routine_failed',
      title: note.mailbox
        ? `Cortex dejó de poder leer ${short(note.mailbox, 80)}`
        : 'Cortex dejó de poder leer tu correo',
      body: 'Se cayó el permiso de tu cuenta de Google y pausé el aprendizaje de tu buzón. Vuelve a conectarla y sigo donde iba: nada de lo aprendido se borró.',
      href: '/settings',
      groupKey: `gmail-mailbox:${note.userId}`,
    },
    'el aprendizaje del buzón',
  );
}
