/**
 * LA JORNADA DE CORTEX — LO QUE HIZO, NO LO QUE TE ESPERA.
 *
 * ===========================================================================
 * EL PROBLEMA
 * ===========================================================================
 * Todo lo que este producto enseña de sí mismo es deuda de quien mira:
 * `waiting.ts` cuenta cuatro colas de trabajo parado, la barra lateral pone
 * badges con lo mismo y /dashboard abre con «Tres cosas te esperan». No hay una
 * sola superficie que diga qué hizo Cortex. Y hace bastante: cinco crons cada
 * madrugada —memorias a las 02:00, aprendizaje a las 04:20, vencimientos a las
 * 06:00, acciones a las 06:30, y dos barridas cada minuto— más trámites,
 * encargos, rutinas y, desde la 0099, todo lo que hizo SIN PREGUNTAR.
 *
 * Un asistente que sólo reparte tareas se lee como un formulario. Este archivo
 * escribe la otra mitad: la línea de tiempo de su jornada, en primera persona.
 *
 * ===========================================================================
 * NINGUNA DE ESTAS FRASES SALE DE UN MODELO, Y NO ES UN DETALLE
 * ===========================================================================
 * Mismo argumento que `waiting-shape.ts`, que ya lo ganó para la frase de
 * arriba: esto se dibuja en cada carga de /dashboard, la pantalla a la que
 * redirige `/`. Una llamada al modelo por visita costaría dinero que no hay,
 * tardaría segundos en la primera pintura y —lo peor— daría un parte distinto
 * cada vez para los mismos datos, así que nadie podría comprobar que dice la
 * verdad. Aquí las mismas filas dan siempre las mismas oraciones, y
 * `journal-shape.test.ts` las revisa caso por caso.
 *
 * ===========================================================================
 * LA REGLA QUE DECIDE QUÉ MERECE LÍNEA PROPIA
 * ===========================================================================
 * **Una línea por PASADA de trabajo, no por fila.** Una barrida que revisa 47
 * vencimientos y manda 3 correos es UN acto —«Revisé 47 vencimientos y avisé de
 * 3»—, no cincuenta. Cincuenta líneas no son un parte de trabajo, son un log, y
 * un log no lo lee nadie.
 *
 * **Rompe el grupo exactamente lo que tiene un destinatario y una decisión
 * propios**, que en la práctica son tres cosas:
 *   1. lo que FALLÓ (un trámite, una rutina, un correo que no salió),
 *   2. lo que SE QUEDÓ ESPERANDO a una persona (un trámite a medias, un
 *      encargo que preguntó algo),
 *   3. lo que se hizo SIN PREGUNTAR (`mandate_uses`).
 * Nada más. Un éxito individual dentro de una pasada no es una noticia; los
 * tres de arriba sí, porque cada uno tiene un nombre distinto detrás y alguien
 * tiene que decidir algo distinto sobre cada uno.
 *
 * **Y esa excepción tiene tope** (`SINGLED_OUT_CAP`): pasadas de cuatro, se
 * vuelven a contar juntas. Veinte fallos idénticos tampoco son veinte
 * hallazgos — son un problema, dicho una vez.
 *
 * ===========================================================================
 * NI UNA LÍNEA INVENTADA — Y CÓMO SE GARANTIZA ESTRUCTURALMENTE
 * ===========================================================================
 * NO HAY FILA, NO HAY LÍNEA. Ningún compositor de aquí escribe «el cron corrió»
 * a partir de la hora del reloj o de que sea de día: sólo escribe a partir de
 * filas que existen. Si el vigilante de vencimientos no dejó ni un aviso, no se
 * dice nada de él — porque no hay ninguna prueba de que corriera, y afirmarlo
 * sería exactamente la clase de relleno que hace inútil un parte de trabajo.
 *
 * El corolario incómodo se asume a propósito: una madrugada en la que no había
 * nada que revisar se ve igual que una en la que el cron no corrió. La
 * alternativa —inventar la línea— es peor, y el hueco lo cubre la pantalla de
 * rutinas, que sí lleva el registro de ejecuciones.
 *
 * Por lo mismo, una fila cuya marca de tiempo no se puede leer SE DESCARTA en
 * vez de colocarse a una hora cualquiera: «a las 06:00» tiene que ser verdad.
 *
 * ===========================================================================
 * ESTE ARCHIVO NO TOCA LA BASE NI IMPORTA `@cortex/agent-tools`
 * ===========================================================================
 * Misma razón que `waiting-shape.ts`, `actions-shape.ts` y `commitments-shape.ts`:
 * el barril de agent-tools alcanza `node:dns` y rompería cualquier bundle de
 * cliente. Las lecturas viven en `journal.ts`, que es `server-only`; aquí sólo
 * hay reglas de redacción sobre datos ya tipados.
 */

import type { StatusTone } from './status-chip';
import { dayPhrase } from './waiting-shape';

// ---------------------------------------------------------------------------
// Hora de Bogotá
// ---------------------------------------------------------------------------
//
// Colombia no tiene horario de verano desde 1993, pero esto usa `Intl` en vez
// de restar cinco horas porque el desfase no es lo que se está calculando: es
// «qué día del calendario de Bogotá es este instante», y esa pregunta se
// responde con la base de zonas horarias o se responde mal.

const BOGOTA = 'America/Bogota';

const CLOCK_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: BOGOTA,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DAY_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: BOGOTA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function part(fmt: Intl.DateTimeFormat, at: number, type: string): string {
  return fmt.formatToParts(new Date(at)).find((p) => p.type === type)?.value ?? '';
}

/**
 * «06:00» en hora de Bogotá.
 *
 * La medianoche llega de algunas implementaciones de ICU como «24»; se normaliza
 * aquí porque «24:00 · Anoté dos cosas» es un reloj que no existe.
 */
export function bogotaClock(at: number): string {
  const hour = part(CLOCK_PARTS, at, 'hour');
  const minute = part(CLOCK_PARTS, at, 'minute');
  return `${hour === '24' ? '00' : hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

/** El día del calendario de Bogotá, `YYYY-MM-DD`. */
export function bogotaDay(at: number): string {
  return `${part(DAY_PARTS, at, 'year')}-${part(DAY_PARTS, at, 'month')}-${part(DAY_PARTS, at, 'day')}`;
}

/**
 * El instante de una fila, o `null` si su marca de tiempo no se puede leer.
 *
 * Devolver `null` es el mecanismo entero de «ni una línea inventada» aplicado al
 * reloj: quien no sabe cuándo pasó algo no lo cuenta.
 */
export function instant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// ---------------------------------------------------------------------------
// Números escritos como los escribiría una persona
// ---------------------------------------------------------------------------

const MASCULINE = [
  'cero',
  'un',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
];

/**
 * Del trece en adelante vuelven a ser cifras, igual que en `waiting-shape.ts`:
 * «veintitrés vencimientos» se lee peor que «23 vencimientos».
 *
 * El género importa y por eso es un parámetro y no una suposición: se cuentan
 * correos y trámites (masculino) en la misma pantalla que rutinas y cosas
 * (femenino), y «una correo» delata que la frase la armó una máquina.
 */
export function cardinal(n: number, gender: 'm' | 'f'): string {
  const safe = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  if (safe === 1) return gender === 'f' ? 'una' : 'un';
  return MASCULINE[safe] ?? String(safe);
}

/** «un correo» / «dos correos» / «23 correos». */
function count(n: number, singular: string, plural: string, gender: 'm' | 'f'): string {
  return `${cardinal(n, gender)} ${n === 1 ? singular : plural}`;
}

/** Un texto ajeno metido dentro de una frase: acortado y sin saltos de línea. */
export function quote(text: string, max = 70): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * El motivo de un fallo, cuando lo hay, como coletilla.
 *
 * Los errores de esta base son mensajes de proveedor y trazas: se cortan corto
 * porque una línea de jornada tiene que caber en un renglón, y lo largo está al
 * otro lado del enlace.
 */
function because(reason: string | null | undefined): string {
  const clean = (reason ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return `: ${quote(clean, 90)}`;
}

// ---------------------------------------------------------------------------
// La forma de la jornada
// ---------------------------------------------------------------------------

export type JournalKind =
  | 'commitments'
  | 'drafts'
  | 'sent'
  | 'mandate'
  | 'flow'
  | 'errand'
  | 'routine'
  | 'memory'
  | 'learning'
  | 'lingering';

export interface JournalLine {
  /** Estable para el mismo hecho, para que React no rebaraje la lista. */
  id: string;
  /** Milisegundos epoch. Ordena la jornada y decide a qué día pertenece. */
  at: number;
  /** «06:00», en hora de Bogotá. */
  clock: string;
  /** La frase, en primera persona y en español. */
  text: string;
  kind: JournalKind;
  tone: StatusTone;
  /** Dónde se ve eso de cerca. Ruta interna del producto, o `null`. */
  href: string | null;
  /**
   * Algo que no salió bien o que se quedó esperando a alguien. Es lo que hace
   * creíble el parte: un gerente que sólo reporta aciertos no lo es.
   */
  attention: boolean;
}

export interface JournalDay {
  /** `YYYY-MM-DD` en Bogotá. */
  date: string;
  /** «Hoy», «Ayer», o la fecha si la ventana se ampliara algún día. */
  label: string;
  lines: JournalLine[];
}

export interface Journal {
  /** La línea de arriba. Reglas, nunca un modelo. */
  headline: string;
  days: JournalDay[];
  /** Cuántas líneas hay en total en `days`. */
  total: number;
  /** De ésas, cuántas piden que alguien mire. */
  attention: number;
  /**
   * Lo que sigue colgando desde antes de la ventana: correos que Cortex mandó
   * y nadie contestó. No tienen hora de hoy, así que no van en la línea de
   * tiempo — pero callarlos sería el sesgo que este archivo existe para evitar.
   */
  lingering: JournalLine[];
  /**
   * Clases de actividad que NO se pudieron leer, dichas con nombre. Una fuente
   * caída se omite y se anuncia; nunca tumba la pantalla ni se disfraza de
   * «no hubo nada».
   */
  gaps: string[];
}

/**
 * Cuántas excepciones se cuentan una por una antes de volver a agruparlas.
 *
 * Cuatro y no diez: la columna de /dashboard tiene sitio para media docena de
 * líneas en total, y la quinta rutina caída no añade nada que no dijera la
 * primera.
 */
export const SINGLED_OUT_CAP = 4;

// ---------------------------------------------------------------------------
// Los compositores, una clase de actividad cada uno
// ---------------------------------------------------------------------------
//
// Todos tienen la misma forma: filas tipadas dentro, `JournalLine[]` fuera, y
// lista vacía cuando no hay nada que contar. Ninguno mira el reloj.

function line(
  id: string,
  at: number,
  kind: JournalKind,
  text: string,
  opts: { tone?: StatusTone; href?: string | null; attention?: boolean } = {},
): JournalLine {
  return {
    id,
    at,
    clock: bogotaClock(at),
    text,
    kind,
    tone: opts.tone ?? 'neutral',
    href: opts.href ?? null,
    attention: opts.attention ?? false,
  };
}

/** Un aviso de vencimiento ya mandado (o intentado). */
export interface NoticeFact {
  id: string;
  at: number;
  kind: 'ahead' | 'due_today' | 'overdue' | 'escalation';
  delivered: boolean;
}

/**
 * El vigilante de las 06:00.
 *
 * `watched` es cuántos vencimientos vivos había — el denominador que convierte
 * «avisé de 3» en trabajo («revisé 47 y avisé de 3»). Es `null` cuando ese
 * conteo no se pudo leer, y entonces la frase se queda sin denominador en vez
 * de inventarse uno.
 *
 * La pasada se fecha en el PRIMER aviso, que es lo más cerca que se puede estar
 * de la hora en que arrancó sin afirmar nada que no esté en una fila.
 */
export function composeCommitmentWatch(
  notices: NoticeFact[],
  watched: number | null,
): JournalLine[] {
  if (notices.length === 0) return [];
  const ordered = [...notices].sort((a, b) => a.at - b.at);
  const first = ordered[0] as NoticeFact;
  const out: JournalLine[] = [];

  const sent = ordered.length;
  const head =
    watched !== null && watched > 0
      ? `Revisé ${count(watched, 'vencimiento', 'vencimientos', 'm')} y avisé de ${cardinal(sent, 'm')}.`
      : `Avisé de ${count(sent, 'vencimiento', 'vencimientos', 'm')}.`;
  out.push(
    line(`commitments:${first.id}`, first.at, 'commitments', head, { href: '/commitments' }),
  );

  // Una escalación no es un aviso más: significa que la fecha se pasó, nadie
  // respondió y hubo que ir por encima de esa persona. Se dice aparte porque
  // quien lo lee tiene que enterarse de eso, no del total.
  const escalated = ordered.filter((n) => n.kind === 'escalation');
  if (escalated.length > 0) {
    const last = escalated[escalated.length - 1] as NoticeFact;
    out.push(
      line(
        `commitments-escalated:${last.id}`,
        last.at,
        'commitments',
        escalated.length === 1
          ? 'Uno llevaba tanto vencido sin respuesta que lo subí por encima de su dueño.'
          : `${cardinal(escalated.length, 'm')} llevaban tanto vencidos sin respuesta que los subí por encima de su dueño.`,
        { tone: 'amber', href: '/commitments', attention: true },
      ),
    );
  }

  const failed = ordered.filter((n) => !n.delivered);
  if (failed.length > 0) {
    const last = failed[failed.length - 1] as NoticeFact;
    out.push(
      line(
        `commitments-undelivered:${last.id}`,
        last.at,
        'commitments',
        failed.length === 1
          ? 'Uno de esos avisos no logró salir por correo.'
          : `${cardinal(failed.length, 'm')} de esos avisos no lograron salir por correo.`,
        { tone: 'rose', href: '/commitments', attention: true },
      ),
    );
  }

  return out;
}

/** Un correo que la barrida de las 06:30 dejó redactado. */
export interface DraftFact {
  id: string;
  at: number;
}

/**
 * Las propuestas de la barrida.
 *
 * Se agrupan siempre, sin excepción: un borrador que espera aprobación ya tiene
 * su cola entera en /actions y su conteo en la barra lateral. Repetirlo aquí
 * uno por uno convertiría la jornada en la bandeja que esta pantalla existe
 * para dejar de ser.
 */
export function composeDrafts(drafts: DraftFact[]): JournalLine[] {
  if (drafts.length === 0) return [];
  const ordered = [...drafts].sort((a, b) => a.at - b.at);
  const first = ordered[0] as DraftFact;
  return [
    line(
      `drafts:${first.id}`,
      first.at,
      'drafts',
      `Te dejé ${count(ordered.length, 'correo listo', 'correos listos', 'm')} para mandar.`,
      { tone: 'primary', href: '/actions' },
    ),
  ];
}

/** Un correo que efectivamente salió (o no) con la firma de alguien. */
export interface SentFact {
  id: string;
  at: number;
  recipient: string;
  ok: boolean;
  error: string | null;
}

/** Lo enviado: los aciertos juntos, los fallos con nombre y apellido. */
export function composeSends(sends: SentFact[]): JournalLine[] {
  if (sends.length === 0) return [];
  const ordered = [...sends].sort((a, b) => a.at - b.at);
  const out: JournalLine[] = [];

  const ok = ordered.filter((s) => s.ok);
  if (ok.length > 0) {
    const last = ok[ok.length - 1] as SentFact;
    out.push(
      line(
        `sent:${last.id}`,
        last.at,
        'sent',
        ok.length === 1
          ? `Mandé el correo que aprobaste a ${quote(last.recipient, 60)}.`
          : `Mandé ${count(ok.length, 'correo', 'correos', 'm')} que aprobaste.`,
        { tone: 'emerald', href: '/actions' },
      ),
    );
  }

  const bad = ordered.filter((s) => !s.ok);
  out.push(
    ...groupOrSingle(
      bad,
      (s) =>
        line(
          `sent-failed:${s.id}`,
          s.at,
          'sent',
          `El correo a ${quote(s.recipient, 50)} no salió${because(s.error)}.`,
          {
            tone: 'rose',
            href: '/actions',
            attention: true,
          },
        ),
      (rows, last) =>
        line(
          `sent-failed-many:${last.id}`,
          last.at,
          'sent',
          `${cardinal(rows.length, 'm')} correos aprobados no lograron salir.`,
          { tone: 'rose', href: '/actions', attention: true },
        ),
    ),
  );

  return out;
}

/** Una vez que un mandato respondió por alguien y Cortex no preguntó. */
export interface MandateUseFact {
  id: string;
  at: number;
  /** La herramienta, ya traducida a español por quien leyó la fila. */
  toolLabel: string;
  /** Cómo se llama la concesión: «Correos a clientes». */
  mandateLabel: string;
  /**
   * «como me autorizaste el 3 de agosto», ya escrita.
   *
   * NO se compone aquí a propósito: la escribe `authorizationPhrase` en
   * `lib/mandates/delegation.ts`, que es la misma que ve alguien en el chat
   * cuando Cortex acaba de actuar sin preguntar. Dos redacciones de la misma
   * frase acabarían discrepando —una diciendo «me autorizaste» y otra «me
   * autorizó Ana» del mismo hecho— y esa frase es justo la que hace verificable
   * una delegación. `null` cuando la fecha no consta, y entonces la línea se
   * queda sin ella en vez de aproximarla.
   */
  authorization: string | null;
  /** Ya formateado («$1.200.000»), o `null` si la llamada no movió dinero. */
  amount: string | null;
}

/**
 * LO ÚNICO QUE SE CUENTA UNO POR UNO POR DEFECTO.
 *
 * Todo lo demás de esta pantalla es trabajo que alguien pidió, directa o
 * indirectamente. Esto no: es Cortex actuando por su cuenta. Que aparezca
 * agrupado dentro de un total sería justo el sitio donde se pierde, y la
 * migración 0099 escribe estas filas precisamente para que no se pierda.
 *
 * Cada línea nombra las tres cosas que hacen defendible una delegación: qué
 * hizo, con qué mandato, y cuándo se lo autorizaron. Sin la fecha de concesión
 * la frase se queda en las otras dos en vez de inventarla.
 */
export function composeMandateUses(uses: MandateUseFact[]): JournalLine[] {
  const ordered = [...uses].sort((a, b) => a.at - b.at);
  return groupOrSingle(
    ordered,
    (u) => {
      const money = u.amount ? `, por ${u.amount}` : '';
      // «con el mandato» / «dentro del mandato». La contracción se arrastra con
      // la preposición porque «dentro de el» es el delator clásico de una frase
      // pegada con `+` en vez de escrita.
      const why = u.authorization ? `${u.authorization} con el` : 'dentro del';
      return line(
        `mandate:${u.id}`,
        u.at,
        'mandate',
        `Hice «${quote(u.toolLabel, 60)}» sin preguntarte${money}, ${why} mandato «${quote(u.mandateLabel, 40)}».`,
        { tone: 'primary' },
      );
    },
    (rows, last) =>
      line(
        `mandate-many:${last.id}`,
        last.at,
        'mandate',
        `Hice ${cardinal(rows.length, 'f')} cosas sin preguntarte, todas dentro de los mandatos que me diste.`,
        { tone: 'primary' },
      ),
  );
}

/** Una corrida de un trámite en un portal. */
export interface FlowRunFact {
  id: string;
  at: number;
  /** Cómo se llama el trámite: «Certificado de tradición». */
  name: string;
  status: 'running' | 'succeeded' | 'failed';
  error: string | null;
  /** True cuando lleva demasiado tiempo abierto. Lo decide `journal.ts`. */
  stalled: boolean;
}

/**
 * Trámites. Los que salieron, juntos; los que fallaron o se quedaron a medias,
 * uno por uno — que es exactamente cuando alguien tiene que ir a mirar.
 */
export function composeFlows(runs: FlowRunFact[]): JournalLine[] {
  const ordered = [...runs].sort((a, b) => a.at - b.at);
  const out: JournalLine[] = [];

  const ok = ordered.filter((r) => r.status === 'succeeded');
  if (ok.length > 0) {
    const last = ok[ok.length - 1] as FlowRunFact;
    out.push(
      line(
        `flow:${last.id}`,
        last.at,
        'flow',
        ok.length === 1
          ? `Hice el trámite «${quote(last.name, 50)}» en el portal.`
          : `Hice ${count(ok.length, 'trámite', 'trámites', 'm')} en portales.`,
        { tone: 'emerald', href: '/browser' },
      ),
    );
  }

  // Un trámite que sigue abierto no es un fallo, y decir que lo fue sería
  // mentir: casi siempre es un portal pidiendo un captcha o una clave. Por eso
  // tiene frase propia, y esa frase dice que la pelota está del otro lado.
  out.push(
    ...groupOrSingle(
      ordered.filter((r) => r.status === 'running' && r.stalled),
      (r) =>
        line(
          `flow-stalled:${r.id}`,
          r.at,
          'flow',
          `Empecé el trámite «${quote(r.name, 50)}» y se quedó a medias: sigue esperando a alguien.`,
          { tone: 'amber', href: '/browser', attention: true },
        ),
      (rows, last) =>
        line(
          `flow-stalled-many:${last.id}`,
          last.at,
          'flow',
          `${cardinal(rows.length, 'm')} trámites se quedaron a medias esperando a alguien.`,
          { tone: 'amber', href: '/browser', attention: true },
        ),
    ),
  );

  out.push(
    ...groupOrSingle(
      ordered.filter((r) => r.status === 'failed'),
      (r) =>
        line(
          `flow-failed:${r.id}`,
          r.at,
          'flow',
          `El trámite «${quote(r.name, 50)}» falló${because(r.error)}.`,
          {
            tone: 'rose',
            href: '/browser',
            attention: true,
          },
        ),
      (rows, last) =>
        line(
          `flow-failed-many:${last.id}`,
          last.at,
          'flow',
          `${cardinal(rows.length, 'm')} trámites fallaron.`,
          {
            tone: 'rose',
            href: '/browser',
            attention: true,
          },
        ),
    ),
  );

  return out;
}

/** Una ejecución de una rutina programada. */
export interface RoutineRunFact {
  id: string;
  at: number;
  name: string;
  status: 'running' | 'ok' | 'error';
  error: string | null;
}

export function composeRoutines(runs: RoutineRunFact[]): JournalLine[] {
  const ordered = [...runs].sort((a, b) => a.at - b.at);
  const out: JournalLine[] = [];

  const ok = ordered.filter((r) => r.status === 'ok');
  if (ok.length > 0) {
    const last = ok[ok.length - 1] as RoutineRunFact;
    out.push(
      line(
        `routine:${last.id}`,
        last.at,
        'routine',
        ok.length === 1
          ? `Corrí la rutina «${quote(last.name, 50)}».`
          : `Corrí ${count(ok.length, 'rutina', 'rutinas', 'f')}.`,
        { tone: 'emerald', href: '/schedules' },
      ),
    );
  }

  out.push(
    ...groupOrSingle(
      ordered.filter((r) => r.status === 'error'),
      (r) =>
        line(
          `routine-failed:${r.id}`,
          r.at,
          'routine',
          `La rutina «${quote(r.name, 50)}» falló${because(r.error)}.`,
          {
            tone: 'rose',
            href: '/schedules',
            attention: true,
          },
        ),
      (rows, last) =>
        line(
          `routine-failed-many:${last.id}`,
          last.at,
          'routine',
          `${cardinal(rows.length, 'f')} rutinas fallaron.`,
          { tone: 'rose', href: '/schedules', attention: true },
        ),
    ),
  );

  return out;
}

/** Un encargo que cambió de estado dentro de la ventana. */
export interface ErrandFact {
  id: string;
  at: number;
  request: string;
  state: 'delivered' | 'failed' | 'exhausted' | 'blocked' | 'cancelled' | 'other';
  closingNote: string | null;
}

/**
 * Encargos. Cada uno es una investigación que alguien pidió con sus propias
 * palabras, así que cada uno lleva línea propia hasta el tope: agruparlos
 * borraría lo único que los distingue, que es lo que se preguntó.
 */
export function composeErrands(errands: ErrandFact[]): JournalLine[] {
  const ordered = [...errands].sort((a, b) => a.at - b.at);
  const out: JournalLine[] = [];

  out.push(
    ...groupOrSingle(
      ordered.filter((e) => e.state === 'delivered'),
      (e) =>
        line(`errand:${e.id}`, e.at, 'errand', `Entregué el encargo «${quote(e.request, 60)}».`, {
          tone: 'emerald',
          href: `/errands/${e.id}`,
        }),
      (rows, last) =>
        line(
          `errand-many:${last.id}`,
          last.at,
          'errand',
          `Entregué ${cardinal(rows.length, 'm')} encargos.`,
          {
            tone: 'emerald',
            href: '/errands',
          },
        ),
    ),
  );

  out.push(
    ...groupOrSingle(
      ordered.filter((e) => e.state === 'blocked'),
      (e) =>
        line(
          `errand-blocked:${e.id}`,
          e.at,
          'errand',
          `El encargo «${quote(e.request, 60)}» se atascó y te preguntó algo.`,
          { tone: 'amber', href: `/errands/${e.id}`, attention: true },
        ),
      (rows, last) =>
        line(
          `errand-blocked-many:${last.id}`,
          last.at,
          'errand',
          `${cardinal(rows.length, 'm')} encargos se atascaron esperando una respuesta tuya.`,
          { tone: 'amber', href: '/errands', attention: true },
        ),
    ),
  );

  out.push(
    ...groupOrSingle(
      ordered.filter((e) => e.state === 'failed' || e.state === 'exhausted'),
      (e) =>
        line(
          `errand-failed:${e.id}`,
          e.at,
          'errand',
          `El encargo «${quote(e.request, 50)}» no salió${because(e.closingNote)}.`,
          { tone: 'rose', href: `/errands/${e.id}`, attention: true },
        ),
      (rows, last) =>
        line(
          `errand-failed-many:${last.id}`,
          last.at,
          'errand',
          `${cardinal(rows.length, 'm')} encargos no salieron.`,
          {
            tone: 'rose',
            href: '/errands',
            attention: true,
          },
        ),
    ),
  );

  return out;
}

/** Una memoria que el cron de las 02:00 propuso sobre cómo trabaja alguien. */
export interface MemoryFact {
  id: string;
  at: number;
}

export function composeMemories(memories: MemoryFact[]): JournalLine[] {
  if (memories.length === 0) return [];
  const ordered = [...memories].sort((a, b) => a.at - b.at);
  const first = ordered[0] as MemoryFact;
  return [
    line(
      `memory:${first.id}`,
      first.at,
      'memory',
      `Anoté ${count(ordered.length, 'cosa', 'cosas', 'f')} que aprendí de cómo trabajas.`,
      { tone: 'primary', href: '/settings/memory' },
    ),
  ];
}

/** Lo que dejó la pasada de aprendizaje de las 04:20. */
export interface LearningFact {
  /** Ajustes de recuperación aplicados sobre Brain Knowledge. */
  adjustments: number;
  /** Conclusiones que Cortex NO puede aplicar solo y deja escritas. */
  proposals: number;
  /** El instante del ajuste más reciente, si hubo. */
  adjustedAt: number | null;
  /** El instante de la propuesta más reciente, si hubo. */
  proposedAt: number | null;
}

export function composeLearning(f: LearningFact): JournalLine[] {
  const out: JournalLine[] = [];

  if (f.adjustments > 0 && f.adjustedAt !== null) {
    out.push(
      line(
        `learning-adjust:${f.adjustedAt}`,
        f.adjustedAt,
        'learning',
        `Repasé cómo se está usando Brain Knowledge y ajusté ${count(f.adjustments, 'fragmento', 'fragmentos', 'm')}.`,
        { tone: 'primary', href: '/learning' },
      ),
    );
  }

  // Una propuesta es, por definición, algo que Cortex concluyó y NO tiene
  // permiso de aplicar. Va marcada como atención porque muere ahí si nadie la
  // lee, que es la forma silenciosa de que el aprendizaje no sirva de nada.
  if (f.proposals > 0 && f.proposedAt !== null) {
    out.push(
      line(
        `learning-propose:${f.proposedAt}`,
        f.proposedAt,
        'learning',
        `Y te dejé ${count(f.proposals, 'conclusión', 'conclusiones', 'f')} que no puedo aplicar solo.`,
        { tone: 'amber', href: '/learning', attention: true },
      ),
    );
  }

  return out;
}

/** Un correo mandado hace tiempo del que nadie contestó nunca. */
export interface LingeringFact {
  id: string;
  /** Cuándo salió. */
  at: number;
  recipient: string;
  subject: string;
  /** Días enteros desde que salió. */
  days: number;
}

/**
 * LO QUE SIGUE SIN MOVERSE.
 *
 * Un cobro cuyo punto era que el cliente pagara y lleva nueve días en silencio
 * es trabajo de Cortex que NO funcionó, y es invisible en todas partes: la
 * acción está `approved`, ejecutada y sin error, así que ninguna cola la
 * reclama. Se dice aquí, ordenado por el que más lleva.
 */
export function composeLingering(rows: LingeringFact[]): JournalLine[] {
  const ordered = [...rows].sort((a, b) => b.days - a.days).slice(0, SINGLED_OUT_CAP);
  return ordered.map((r) =>
    line(
      `lingering:${r.id}`,
      r.at,
      'lingering',
      `El correo a ${quote(r.recipient, 45)} («${quote(r.subject, 45)}») lleva ${dayPhrase(r.days)} sin respuesta.`,
      { tone: 'amber', href: '/actions', attention: true },
    ),
  );
}

/**
 * La excepción con tope, en un sitio.
 *
 * Hasta `SINGLED_OUT_CAP` filas se cuentan una por una porque cada una tiene un
 * nombre distinto y una decisión distinta detrás. Pasado ese punto, el nombre
 * deja de ser lo importante y lo importante es el número.
 */
function groupOrSingle<T extends { at: number }>(
  rows: T[],
  single: (row: T) => JournalLine,
  grouped: (rows: T[], last: T) => JournalLine,
): JournalLine[] {
  if (rows.length === 0) return [];
  if (rows.length <= SINGLED_OUT_CAP) return rows.map(single);
  return [grouped(rows, rows[rows.length - 1] as T)];
}

// ---------------------------------------------------------------------------
// La jornada entera
// ---------------------------------------------------------------------------

/** Lo que `buildJournal` necesita saber para ordenar y titular. */
export interface JournalInput {
  lines: JournalLine[];
  lingering: JournalLine[];
  gaps: string[];
  /** El instante «ahora», para saber qué día es hoy en Bogotá. */
  now: number;
}

/**
 * Ordena, agrupa por día de Bogotá y escribe la frase de arriba.
 *
 * Descendente dentro de cada día: lo último que hizo Cortex es lo primero que
 * alguien quiere ver al llegar. Los días, también descendentes — hoy antes que
 * ayer.
 */
export function buildJournal(input: JournalInput): Journal {
  const today = bogotaDay(input.now);
  const yesterday = bogotaDay(input.now - 86_400_000);

  const byDay = new Map<string, JournalLine[]>();
  for (const l of [...input.lines].sort((a, b) => b.at - a.at)) {
    const day = bogotaDay(l.at);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(l);
    else byDay.set(day, [l]);
  }

  const days: JournalDay[] = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, lines]) => ({
      date,
      label: date === today ? 'Hoy' : date === yesterday ? 'Ayer' : date,
      lines,
    }));

  const total = input.lines.length;
  const attention = input.lines.filter((l) => l.attention).length;
  const todayCount = byDay.get(today)?.length ?? 0;

  return {
    headline: journalHeadline({ total, todayCount, attention, lingering: input.lingering.length }),
    days,
    total,
    attention,
    lingering: input.lingering,
    gaps: input.gaps,
  };
}

/**
 * LA FRASE DE ARRIBA.
 *
 * Estructura fija: una cabeza que cuenta lo hecho, y como mucho una coletilla
 * que dice lo que no salió. El caso vacío NO se disfraza —«todavía no he hecho
 * nada»— porque un parte de trabajo con relleno es peor que ninguno: la primera
 * vez que alguien comprueba que la línea de las 06:00 no ocurrió, deja de creer
 * también las que sí.
 *
 *   Hoy he hecho nueve cosas.
 *   Hoy he hecho nueve cosas y una no salió como debía.
 *   Hoy todavía no he hecho nada; ayer hice cuatro cosas.
 *   Anoche no había nada que revisar y hoy todavía no he hecho nada.
 */
export function journalHeadline(f: {
  total: number;
  todayCount: number;
  attention: number;
  lingering: number;
}): string {
  if (f.total === 0) {
    // Ni siquiera aquí se afirma que los crons corrieran: «no había nada que
    // revisar» es lo que se puede sostener desde cero filas.
    return f.lingering > 0
      ? 'Anoche no había nada que revisar y hoy todavía no he hecho nada, pero hay algo mío que sigue sin moverse.'
      : 'Anoche no había nada que revisar y hoy todavía no he hecho nada.';
  }

  const head =
    f.todayCount > 0
      ? `Hoy he hecho ${count(f.todayCount, 'cosa', 'cosas', 'f')}`
      : `Hoy todavía no he hecho nada; ayer hice ${count(f.total, 'cosa', 'cosas', 'f')}`;

  if (f.attention === 0) return `${head}.`;
  return f.attention === 1
    ? `${head} y una no salió como debía.`
    : `${head} y ${cardinal(f.attention, 'f')} no salieron como debían.`;
}
