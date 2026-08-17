import { type ManagerMap, escalationTarget } from '../directory/line';
import type { ActionRow } from './shape';

/**
 * Qué aprobaciones llevan tanto tiempo paradas que ya hay que avisarle a
 * alguien por encima, y a quién. Ni base de datos, ni reloj, ni red.
 *
 * ===========================================================================
 * POR QUÉ ESTO ES UNA FUNCIÓN PURA Y NO UNA CONSULTA CON UN `WHERE` LARGO
 * ===========================================================================
 * Lo que se decide aquí es A QUIÉN LE LLEGA UN CORREO POR ENCIMA DE SU CABEZA,
 * y —a diferencia de casi todo lo demás— NINGUNO DE SUS ERRORES SE VE. Escalar
 * al jefe equivocado deja la fila igual de correcta, el barrido igual de verde y
 * los registros diciendo «entregado»; el único síntoma es que quien tenía que
 * enterarse no se enteró. Escalar de más es peor todavía, porque el daño es
 * acumulativo: un jefe al que le llegan tres avisos que no tocaban deja de abrir
 * el cuarto, que era el que importaba, y nadie puede señalar el día en que este
 * camino de escalado se apagó.
 *
 * Ninguna de esas dos cosas se puede observar mirando el producto. Así que se
 * observan en una prueba, y para eso la regla tiene que ser una función que
 * recibe filas, un instante y dos mapas, y devuelve una lista. Es la misma
 * disciplina de `directory/line.ts` (`escalationTarget`), de `commitments/
 * shape.ts` (`noticesOwed`) y de `actions/sweep.ts` (`planOwnerReminders`), por
 * el mismo motivo: la parte que decide quién recibe qué se prueba caso por caso
 * en Node.
 *
 * ===========================================================================
 * ESCALAR NO ES TRANSFERIR
 * ===========================================================================
 * `claimAction` sólo deja aprobar al `user_id` dueño de la fila, y así tiene que
 * seguir siendo: el correo sale del Gmail de esa persona y va firmado con su
 * nombre. El destinatario que devuelve esto NO puede aprobar nada — es el que
 * recibe un «esto lleva N horas parado». Nada de este módulo cambia `user_id`
 * ni tiene manera de hacerlo: `EscalationDue` no lo lleva.
 *
 * ===========================================================================
 * LA OTRA COLA NO SE ESCALA, Y ES DELIBERADO
 * ===========================================================================
 * Este producto tiene dos colas de aprobación. `public.actions` (la de aquí)
 * vive SIETE DÍAS. `public.mcp_pending_actions` vive QUINCE MINUTOS
 * (`APPROVAL_TTL_MS`, apps/web/lib/approval-email.ts). Un barrido diario no
 * puede escalar algo que muere en quince minutos: cuando el cron mira, todo lo
 * que había expiró hace horas, y avisarle al jefe de una llamada que ya nadie
 * puede aprobar es exactamente el ruido del párrafo de arriba. Esa cola ya
 * responde al silencio como corresponde a su escala —correo y DM de Google Chat
 * a la vez, para alcanzar la superficie que la persona tenga abierta AHORA— y si
 * hay que mejorarla se mejora ahí, en segundos, no aquí con un cron.
 */

// ---------------------------------------------------------------------------
// El umbral
// ---------------------------------------------------------------------------

/**
 * Cuántas horas parada tiene que llevar una propuesta antes de subirla.
 *
 * CUARENTA Y OCHO, Y EL NÚMERO SALE DE LOS DATOS QUE YA HAY, no del gusto:
 *
 *   · La propuesta vive 7 días (`PROPOSAL_TTL_MS`). Ése es todo el presupuesto.
 *   · El barrido corre UNA VEZ AL DÍA, a las 06:30 de Bogotá. O sea que el
 *     umbral no se mide en horas finas: se redondea hacia arriba hasta la
 *     mañana siguiente. Cualquier valor entre 24 y 48 escala, en la práctica,
 *     en la misma corrida.
 *   · 48 h le deja al dueño DOS MAÑANAS COMPLETAS para contestar lo suyo sin que
 *     nadie por encima se entere. Una sola mañana no basta: alguien que propuso
 *     el lunes por la tarde y está de viaje el martes recibiría un escalado por
 *     no haber abierto el correo en un día hábil, y eso enseña a la gente que el
 *     escalado es un castigo aleatorio.
 *   · Y todavía deja CINCO DÍAS de margen entre el aviso al jefe y el vencimiento
 *     de la propuesta. Ése es el número que de verdad importa: escalar sirve si
 *     queda tiempo para que el escalado sirva de algo. Un umbral de 6 días
 *     avisaría al jefe la víspera de que la fila se muera, que es avisar por
 *     cumplir.
 */
export const APPROVAL_ESCALATION_DEFAULT_HOURS = 48;

/**
 * El suelo y el techo de lo que se acepta por configuración.
 *
 * El techo NO es una precaución de estilo: escalar exige que la propuesta siga
 * viva (ver más abajo), así que cualquier umbral ≥ 168 h —los 7 días del
 * `PROPOSAL_TTL_MS`— apaga el escalado ENTERO en silencio, sin un error, sin un
 * registro, y sin que se note hasta que alguien pregunte por qué nadie escala
 * nada. 120 h (cinco días) es lo más alto que sigue dejando dos días de margen
 * para que el jefe pueda mover algo.
 *
 * El suelo es 1 h por honestidad más que por defensa: con un barrido diario,
 * cualquier cosa por debajo de 24 h significa «a la mañana siguiente», y un 0
 * significaría escalar propuestas recién nacidas en la misma corrida que las
 * creó — el dueño no ha tenido ni la ocasión de verlas.
 */
export const MIN_ESCALATION_HOURS = 1;
export const MAX_ESCALATION_HOURS = 120;

/**
 * El umbral, leído de `APPROVAL_ESCALATION_HOURS`.
 *
 * Recibe el texto crudo en vez de leer `process.env` para que siga siendo puro y
 * probable. TODO lo que no sea un número finito y positivo cae al valor por
 * defecto: vacío, espacios, «48h», «mucho», `NaN`, negativos, infinito. La
 * alternativa —lanzar— convertiría una variable de entorno mal escrita en un
 * despliegue caído, y la otra alternativa —`Number(raw) || DEFAULT`— trata el
 * 0 y el vacío igual que el 48 por accidente en vez de por decisión.
 *
 * Fuera de rango se recorta, no se rechaza: quien puso 500 quería «casi nunca»,
 * y darle 120 es más cerca de lo que pidió que apagarle el escalado entero.
 */
export function escalationHoursFrom(raw: string | undefined | null): number {
  const text = (raw ?? '').trim();
  if (text.length === 0) return APPROVAL_ESCALATION_DEFAULT_HOURS;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return APPROVAL_ESCALATION_DEFAULT_HOURS;
  return Math.min(MAX_ESCALATION_HOURS, Math.max(MIN_ESCALATION_HOURS, value));
}

/**
 * Cuántas se escalan por corrida y por espacio de trabajo.
 *
 * No es un límite de rendimiento: es un límite de atención, el mismo argumento
 * que `MAX_PROPOSALS_PER_RUN` en el barrido. Un jefe que abre el correo y
 * encuentra treinta avisos de escalado el primer día no los trabaja: los archiva
 * todos y aprende que ese remitente no hay que leerlo. Con el orden por
 * antigüedad, el tope escala primero lo que lleva más tiempo parado y lo demás
 * espera a mañana — que es exactamente donde debería estar.
 */
export const MAX_ESCALATIONS_PER_RUN = 10;

// ---------------------------------------------------------------------------
// La decisión
// ---------------------------------------------------------------------------

/** Lo mínimo de una acción que hace falta para decidir. Un subconjunto de `ActionRow`. */
export type EscalatableAction = Pick<
  ActionRow,
  'id' | 'user_id' | 'state' | 'created_at' | 'expires_at' | 'escalated_at'
>;

/** Los dos únicos caminos que se escriben. Ver el CHECK de la migración 0113. */
export type ActionEscalationVia = 'manager' | 'admin';

export interface EscalationDue {
  actionId: string;
  /** A quién se le avisa. Nunca es el dueño, y nunca puede aprobar nada. */
  toUserId: string;
  via: ActionEscalationVia;
  /** Horas completas que lleva esperando. Es lo que dice el correo. */
  hoursWaiting: number;
}

export interface EscalationsDueInput {
  actions: readonly EscalatableAction[];
  now: Date;
  /** El umbral, ya en milisegundos. Ver `escalationHoursFrom`. */
  afterMs: number;
  /** La línea de mando del espacio (`loadManagerMap`). */
  managers: ManagerMap;
  /** Los administradores del espacio, EN ORDEN ESTABLE. Ver `orgAdmins`. */
  admins: readonly string[];
  /** Tope por corrida. Por defecto `MAX_ESCALATIONS_PER_RUN`. */
  limit?: number;
}

/**
 * Qué se escala esta mañana, a quién, y desde hace cuánto.
 *
 * ===========================================================================
 * LAS CINCO PUERTAS, Y QUÉ DEJA ENTRAR CADA UNA SI FALTA
 * ===========================================================================
 *   1. `state === 'proposed'`. Una aprobada ya se ejecutó y una descartada la
 *      descartó una persona a propósito: ninguna de las dos espera a nadie.
 *      Sin esta puerta, el jefe recibe avisos sobre trabajo YA HECHO, que es la
 *      forma más rápida que existe de enseñarle que estos correos son mentira.
 *
 *   2. `expires_at > now`. ESCALAR ALGO QUE YA NO SE PUEDE APROBAR ES RUIDO
 *      PURO. La 0077 es explícita: expirar REVOCA la posibilidad de aprobar, y
 *      la reparación honesta de una propuesta vencida es una propuesta nueva con
 *      cifras nuevas, no que alguien la rescate. Un correo al jefe sobre una
 *      fila que nadie —ni él ni el dueño— puede tocar le pide que haga algo
 *      imposible.
 *
 *   3. `now - created_at >= afterMs`. La razón de ser del umbral: el dueño tiene
 *      derecho a un plazo para contestar lo suyo antes de que su jefe se entere.
 *      Se mide contra `created_at` y no contra `updated_at` a propósito —
 *      editar el borrador no reinicia el reloj, porque lo que lleva parado es la
 *      DECISIÓN, no el texto.
 *
 *   4. `escalated_at == null`. NUNCA DOS VECES. El barrido corre todas las
 *      mañanas y la propuesta sigue viva siete días; sin esta puerta, la misma
 *      fila le llega al mismo jefe cinco mañanas seguidas. Aquí es donde se
 *      decide, y la base lo respalda: el UPDATE que marca la fila lleva
 *      `escalated_at is null` en su WHERE, así que dos corridas simultáneas
 *      mandan un aviso y no dos.
 *
 *   5. Hay destinatario, y no es el propio dueño. `escalationTarget` sube UN
 *      escalón —el jefe del dueño— y sólo se cae al primer administrador cuando
 *      no hay jefe puesto; jamás se salta al jefe para ir al jefe del jefe, que
 *      dejaría de ser «tu jefe se enteró» para ser «te acusaron ante el
 *      gerente». Y un administrador que se escala a sí mismo NO ES UN ESCALADO:
 *      es el segundo correo idéntico a la misma persona que ya no contestó el
 *      primero, con la fila marcada como atendida y nadie por encima enterándose.
 *      Es el caso normal, no el raro: en una empresa que todavía no ha puesto ni
 *      un `manager_id`, el dueño de media cola ES el administrador.
 *
 * ORDEN Y TOPE. Sale por antigüedad —lo que lleva más tiempo parado primero—,
 * con el id de desempate para que dos filas creadas en el mismo milisegundo no
 * dependan del orden en que llegaron de Postgres. El tope se aplica DESPUÉS de
 * ordenar, así que lo que se queda fuera es siempre lo más nuevo.
 *
 * FECHAS ILEGIBLES. Una fila cuyo `created_at` o `expires_at` no se pueda leer
 * se descarta en silencio en vez de tratarse como «lleva infinito esperando».
 * Es la misma postura de `findReply` con una fecha rota: el error barato es un
 * escalado que llega un día tarde; el caro es un correo al jefe que no tocaba.
 */
export function escalationsDue(input: EscalationsDueInput): EscalationDue[] {
  const now = input.now.getTime();
  const due: Array<EscalationDue & { createdAt: number }> = [];

  for (const action of input.actions) {
    if (action.state !== 'proposed') continue;
    if (action.escalated_at) continue;

    const createdAt = Date.parse(action.created_at);
    const expiresAt = Date.parse(action.expires_at);
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) continue;

    if (expiresAt <= now) continue;
    const waited = now - createdAt;
    if (waited < input.afterMs) continue;

    // `escalateToUserId: null` siempre: una acción no tiene dónde nombrar a
    // nadie a mano — eso es de `commitments`, y esa rama de `escalationTarget`
    // existe para aquéllos. Aquí sólo caben el jefe y el administrador.
    const target = escalationTarget({
      escalateToUserId: null,
      ownerUserId: action.user_id,
      managers: input.managers,
      admins: input.admins,
    });
    if (!target.userId) continue;
    if (target.userId === action.user_id) continue;
    if (target.via !== 'manager' && target.via !== 'admin') continue;

    due.push({
      actionId: action.id,
      toUserId: target.userId,
      via: target.via,
      hoursWaiting: Math.floor(waited / 3_600_000),
      createdAt,
    });
  }

  due.sort((a, b) => a.createdAt - b.createdAt || a.actionId.localeCompare(b.actionId));
  return due
    .slice(0, input.limit ?? MAX_ESCALATIONS_PER_RUN)
    .map(({ createdAt: _createdAt, ...rest }) => rest);
}
