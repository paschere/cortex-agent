import { type AttentionThread, needsYourAttention } from './attention';

/**
 * DE QUÉ MERECE LA PENA INTERRUMPIR A ALGUIEN.
 *
 * ===========================================================================
 * LA REGLA DE SILENCIO SIGUE EN PIE
 * ===========================================================================
 * `gmail-learn.ts` lo dice desde que existe: nada que sea una COLA se avisa.
 * Una propuesta esperando, un correo por leer, un pendiente — eso vive en una
 * pantalla con su contador y sigue siendo verdad mañana. La campana es para
 * desenlaces.
 *
 * Un correo entrante no es un desenlace de Cortex, pero puede ser un hecho del
 * mundo que cambia el día de alguien, y ésa es la única grieta que este módulo
 * abre. Por eso la abre estrecha: no basta con que el correo merezca una
 * respuesta —eso es la cola de siempre—, hace falta ADEMÁS una razón para no
 * esperar al resumen de mañana.
 *
 * ===========================================================================
 * LAS TRES RAZONES, EN ORDEN DE FUERZA
 * ===========================================================================
 *   1. COMPROMISO. Hay algo prometido con fecha con esa contraparte. Es la más
 *      fuerte porque el reloj ya estaba corriendo antes de que llegara el
 *      correo: enterarse mañana puede ser enterarse tarde de verdad.
 *   2. CLIENTE. El dominio de quien escribe está registrado a nombre de un
 *      cliente. Alguien de la empresa se tomó el trabajo de decir que ese
 *      dominio importa, y esto es cobrar ese trabajo.
 *   3. ESPERA. Alguien de fuera escribió y la pelota es suya. Es la más ancha
 *      y por eso va última: entra sólo si sobra techo después de las otras dos.
 *
 * Un correo que no encaja en ninguna NO se pierde: se archivó igual y sale en
 * el resumen de la mañana. La diferencia entre avisar y no avisar es sólo
 * CUÁNDO se entera la persona, nunca SI se entera.
 *
 * ===========================================================================
 * FUNCIÓN PURA, Y ESO NO ES UN DETALLE
 * ===========================================================================
 * Todo lo que decide entra por parámetro. Es lo que permite que alguien audite
 * «¿por qué me avisó de esto?» leyendo cuarenta líneas en vez de levantando un
 * buzón, y es lo que hace que los tres frenos de la 0126 —el techo, la franja
 * horaria y la unicidad por hilo— vivan fuera, donde se pueden cambiar sin
 * tocar el criterio.
 */

export type AlertReason = 'commitment' | 'client' | 'waiting';

export interface MailAlert {
  thread: AttentionThread;
  reason: AlertReason;
  /** Una frase que se le puede leer a la persona, tal cual. */
  detail: string;
  /** A quién habría que contestarle. Sale del último mensaje. */
  from: string;
}

export interface PlanAlertsInput {
  threads: AttentionThread[];
  /** La dirección del dueño del buzón, para saber de quién es la pelota. */
  mailbox: string;
  /** Hilos que ya interrumpieron alguna vez. Un hilo interrumpe una vez. */
  alreadyAlerted: Set<string>;
  /** Dominio en minúsculas → nombre del cliente registrado (`client_domains`). */
  clientsByDomain: Map<string, string>;
  /**
   * Nombre de cliente en minúsculas → el compromiso más urgente con él.
   *
   * SE ENTRA POR EL NOMBRE Y NO POR UN ID porque `commitments.counterparty` es
   * texto libre (migración 0069, y ahí está explicado por qué). El emparejado
   * falla cuando alguien escribió el nombre distinto, y cuando falla no se
   * pierde nada: el hilo sigue teniendo la razón 'client' o 'waiting'. Lo único
   * que se pierde es la razón más afilada de las tres.
   */
  commitmentsByClient: Map<string, { title: string; dueLabel: string }>;
  /** Cuántos avisos caben todavía hoy. Cero significa callar. */
  budget: number;
}

const RANK: Record<AlertReason, number> = { commitment: 0, client: 1, waiting: 2 };

/** El dominio de un correo, en minúsculas y sin la arroba. */
function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at === -1) return null;
  const d = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return d.length > 0 ? d : null;
}

export function planMailAlerts(input: PlanAlertsInput): MailAlert[] {
  if (input.budget <= 0) return [];

  const mailbox = input.mailbox.trim().toLowerCase();
  const found: MailAlert[] = [];

  for (const thread of input.threads) {
    if (input.alreadyAlerted.has(thread.threadId)) continue;

    // El filtro de siempre primero: si esto no le toca a una persona, no hay
    // razón que valga. Es el mismo que decide qué proponer (mail/attention.ts).
    const verdict = needsYourAttention(thread, mailbox);
    if (!verdict.needsYou) continue;

    const domain = thread.counterpartDomain?.toLowerCase() ?? domainOf(verdict.from);
    const client = domain ? input.clientsByDomain.get(domain) : undefined;
    const commitment = client
      ? input.commitmentsByClient.get(client.trim().toLowerCase())
      : undefined;

    if (client && commitment) {
      found.push({
        thread,
        reason: 'commitment',
        detail: `${client} escribió, y tienes con ellos «${commitment.title}» ${commitment.dueLabel}.`,
        from: verdict.from,
      });
    } else if (client) {
      found.push({
        thread,
        reason: 'client',
        detail: `${client} escribió y la respuesta está de tu lado.`,
        from: verdict.from,
      });
    } else {
      found.push({
        thread,
        reason: 'waiting',
        detail: `${verdict.from} escribió y está esperando respuesta.`,
        from: verdict.from,
      });
    }
  }

  // Primero por fuerza de la razón, y dentro de cada razón lo más reciente: un
  // correo de hace un rato todavía se puede contestar a tiempo, y uno de ayer
  // ya perdió el momento en que la respuesta valía.
  return found
    .sort(
      (a, b) =>
        RANK[a.reason] - RANK[b.reason] ||
        b.thread.lastMessageAt.localeCompare(a.thread.lastMessageAt),
    )
    .slice(0, input.budget);
}

/**
 * ¿Se puede interrumpir a esta hora?
 *
 * La franja se lee en la zona horaria de la persona, no en la del servidor —
 * que es UTC y no es la zona de nadie. Una franja que cruza la medianoche
 * («22:00 a 07:00») se entiende como tal en vez de quedar vacía, porque alguien
 * que trabaja de noche la va a escribir así y una franja vacía silenciaría la
 * función entera sin decir por qué.
 */
export function withinQuietHours(now: Date, timeZone: string, from: string, to: string): boolean {
  const minutes = (hhmm: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
    return h * 60 + mm;
  };

  const start = minutes(from);
  const end = minutes(to);
  // Una franja que no se entiende no puede callar a nadie: se falla al lado de
  // avisar, que es el lado que la persona puede corregir con un clic.
  if (start === null || end === null) return true;

  let local: string;
  try {
    local = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
  } catch {
    return true;
  }
  const nowMinutes = minutes(local);
  if (nowMinutes === null) return true;

  if (start === end) return true;
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  // Cruza la medianoche.
  return nowMinutes >= start || nowMinutes < end;
}
