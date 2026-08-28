import { type MailHeader, headerValue, parseAddress, parseAddressList } from '../inbox/filters';
import { type GmailFetchContext, gmailFetch } from './client';
import {
  type MimePart,
  type RawAttachment,
  collectAttachments,
  extractText,
  stripQuotedReply,
} from './mime';

/**
 * Los hilos de Gmail, en la forma que necesita todo lo que NO es una respuesta
 * de chat: la carga histórica, el barrido diario y la ingesta al cerebro.
 *
 * `list-threads.ts` y `read-thread.ts` siguen siendo lo que un modelo llama a
 * mitad de una conversación y devuelven lo que un modelo puede leer. Esto de
 * aquí es la capa de abajo: un mensaje con su fecha en milisegundos, sus
 * direcciones ya separadas y su cuerpo sin la cita del mensaje anterior. Nada
 * de esto pasa por un modelo — se convierte en documento y se queda en la base.
 */

/** Un mensaje de Gmail, ya desenvuelto y utilizable. */
export interface MailMessage {
  id: string;
  threadId: string;
  /** Message-ID de RFC 5322: el identificador que sobrevive a salirse de Google. */
  internetMessageId: string | null;
  /** La cabecera `From` tal cual, para poder mostrarla como la escribió quien fuera. */
  from: string | null;
  fromEmail: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  /** ISO. Sale de `internalDate`, que es el reloj de Google y no el del remitente. */
  date: string | null;
  ms: number;
  labelIds: string[];
  body: string;
  headers: MailHeader[];
  /**
   * Lo que venía colgando de este mensaje, ya enumerado pero sin descargar
   * (0124). Se lleva en el mensaje y no se vuelve a leer del árbol más tarde
   * porque el árbol se descarta en cuanto se normaliza, y volver a pedirlo a
   * Gmail para saber si había un PDF sería una llamada por mensaje.
   */
  attachments: RawAttachment[];
}

interface RawMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: MimePart & { headers?: MailHeader[] };
}

interface RawThread {
  id: string;
  historyId?: string;
  messages?: RawMessage[];
}

/**
 * `internalDate` y no la cabecera `Date`.
 *
 * La cabecera la escribe el cliente del remitente y miente con regularidad
 * —relojes mal puestos, zonas horarias inventadas, reenvíos que conservan la
 * fecha vieja—. `internalDate` es cuándo lo recibió Google, que es el único
 * reloj compartido por todos los mensajes del buzón y por tanto el único con el
 * que ordenar un hilo tiene sentido.
 */
function momentOf(m: RawMessage): number {
  const ms = Number.parseInt(m.internalDate ?? '', 10);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const header = headerValue(m.payload?.headers ?? [], 'Date');
  const parsed = header ? Date.parse(header) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeMessage(raw: RawMessage): MailMessage {
  const headers = raw.payload?.headers ?? [];
  const fromRaw = headerValue(headers, 'From');
  const ms = momentOf(raw);
  return {
    id: raw.id ?? '',
    threadId: raw.threadId ?? '',
    internetMessageId: headerValue(headers, 'Message-ID'),
    from: fromRaw,
    fromEmail: parseAddress(fromRaw ?? '')?.email ?? null,
    to: parseAddressList(headerValue(headers, 'To')).map((a) => a.email),
    cc: parseAddressList(headerValue(headers, 'Cc')).map((a) => a.email),
    subject: headerValue(headers, 'Subject'),
    date: ms > 0 ? new Date(ms).toISOString() : null,
    ms,
    labelIds: raw.labelIds ?? [],
    body: stripQuotedReply(extractText(raw.payload).trim()),
    headers,
    attachments: collectAttachments(raw.payload),
  };
}

/** Un hilo entero, en orden, con los cuerpos ya desenvueltos. */
export async function fetchThreadMessages(
  ctx: GmailFetchContext,
  threadId: string,
): Promise<MailMessage[]> {
  const thread = await gmailFetch<RawThread>(ctx, `/threads/${threadId}?format=full`);
  return (thread.messages ?? []).map(normalizeMessage).sort((a, b) => a.ms - b.ms);
}

/**
 * Todas las direcciones que aparecen en el hilo, en orden de aparición.
 *
 * INCLUYE AL DUEÑO DEL BUZÓN, a propósito y al revés que el digest. El digest
 * pregunta «¿con quién estoy hablando?» y ahí uno mismo sobra; esto alimenta la
 * decisión de si el hilo es interno o no, y para esa pregunta el dueño cuenta
 * exactamente igual que los demás.
 */
export function threadParticipants(messages: MailMessage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    for (const address of [m.fromEmail, ...m.to, ...m.cc]) {
      if (!address) continue;
      const norm = address.trim().toLowerCase();
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// El buzón: quién es, y qué hay
// ---------------------------------------------------------------------------

export interface MailboxProfile {
  emailAddress: string;
  /** El puntero de HOY. Guardarlo ANTES de leer nada es lo que hace que el
   * barrido de mañana no se salte lo que llegue durante esta carga. */
  historyId: string | null;
}

export async function fetchProfile(ctx: GmailFetchContext): Promise<MailboxProfile> {
  const p = await gmailFetch<{ emailAddress?: string; historyId?: string }>(ctx, '/profile');
  return { emailAddress: p.emailAddress ?? '', historyId: p.historyId ?? null };
}

export interface ThreadPage {
  threadIds: string[];
  nextPageToken: string | null;
  /** Lo que Gmail estima que hay en total para la consulta. Aproximado, y sirve
   * para poder decir «van 1.240 de unos 9.000» en vez de sólo «van 1.240». */
  estimatedTotal: number | null;
}

/**
 * Una página de ids de hilo para una consulta de Gmail.
 *
 * Sólo ids: pedir aquí los metadatos sería pagar una llamada por hilo para
 * información que la ingesta va a volver a pedir completa de todas formas.
 */
export async function listThreadPage(
  ctx: GmailFetchContext,
  opts: { query: string; pageToken?: string | null; pageSize?: number },
): Promise<ThreadPage> {
  const params = new URLSearchParams({
    q: opts.query,
    maxResults: String(Math.min(Math.max(opts.pageSize ?? 100, 1), 500)),
  });
  if (opts.pageToken) params.set('pageToken', opts.pageToken);
  const page = await gmailFetch<{
    threads?: Array<{ id: string }>;
    nextPageToken?: string;
    resultSizeEstimate?: number;
  }>(ctx, `/threads?${params.toString()}`);
  return {
    threadIds: (page.threads ?? []).map((t) => t.id).filter(Boolean),
    nextPageToken: page.nextPageToken ?? null,
    estimatedTotal: typeof page.resultSizeEstimate === 'number' ? page.resultSizeEstimate : null,
  };
}

/**
 * La ventana de la carga histórica, como consulta de Gmail.
 *
 * `-in:chats` porque los mensajes de Google Chat aparecen en la API de Gmail y
 * no son correo: son conversaciones de mensajería que llegarían al cerebro sin
 * remitente reconocible y sin asunto. `in:anywhere` para que entre también lo
 * archivado y lo que está en la papelera de otro año, que es donde vive la
 * mitad de un histórico real.
 */
export const BACKFILL_WINDOWS = {
  '1m': 30,
  '90d': 90,
  '6m': 180,
  '12m': 365,
} as const;

export type BackfillWindow = keyof typeof BACKFILL_WINDOWS;

export function backfillQuery(window: BackfillWindow, now = new Date()): string {
  const days = BACKFILL_WINDOWS[window];
  const since = new Date(now.getTime() - days * 86_400_000);
  return `in:anywhere -in:chats after:${gmailDate(since)}`;
}

/** Gmail quiere `YYYY/MM/DD` y no ISO. */
export function gmailDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

// ---------------------------------------------------------------------------
// El puntero incremental
// ---------------------------------------------------------------------------

export interface HistoryResult {
  /** Los hilos que cambiaron desde el puntero, sin repetir. */
  threadIds: string[];
  /** El puntero nuevo. Null si Gmail no lo devolvió, y entonces no se avanza. */
  historyId: string | null;
  /**
   * true cuando Gmail ya no reconoce el puntero (404). No es un fallo: es lo
   * que pasa cuando el barrido lleva días sin correr. Quien llama tiene que
   * caer a una consulta por fecha; ver `gmail-sync.ts`.
   */
  expired: boolean;
}

/**
 * Qué cambió en este buzón desde `startHistoryId`.
 *
 * SE PIDE `messageAdded` Y NADA MÁS. La History API también cuenta etiquetas
 * puestas y quitadas, y un buzón donde alguien archiva cincuenta correos
 * devolvería cincuenta cambios que no son correo nuevo. Lo que este producto
 * quiere saber es qué se dijo, no qué se ordenó.
 */
export async function listHistoryThreadIds(
  ctx: GmailFetchContext,
  startHistoryId: string,
): Promise<HistoryResult> {
  const threadIds = new Set<string>();
  let pageToken: string | null = null;
  let historyId: string | null = null;

  do {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: 'messageAdded',
      maxResults: '500',
    });
    if (pageToken) params.set('pageToken', pageToken);

    let page: {
      history?: Array<{ messagesAdded?: Array<{ message?: { threadId?: string } }> }>;
      nextPageToken?: string;
      historyId?: string;
    };
    try {
      page = await gmailFetch(ctx, `/history?${params.toString()}`);
    } catch (err) {
      // 404 = el puntero caducó. Cualquier otra cosa es un fallo de verdad y
      // sube: tragárselo aquí convertiría «Google está caído» en «no llegó
      // ningún correo hoy», que es una mentira que nadie detecta.
      if (/\b404\b/.test((err as Error).message)) {
        return { threadIds: [], historyId: null, expired: true };
      }
      throw err;
    }

    for (const h of page.history ?? []) {
      for (const added of h.messagesAdded ?? []) {
        const id = added.message?.threadId;
        if (id) threadIds.add(id);
      }
    }
    historyId = page.historyId ?? historyId;
    pageToken = page.nextPageToken ?? null;
  } while (pageToken);

  return { threadIds: [...threadIds], historyId, expired: false };
}
