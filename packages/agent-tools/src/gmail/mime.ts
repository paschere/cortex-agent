import type { MailHeader } from '../inbox/filters';

/**
 * Sacar el texto de un mensaje de Gmail, que llega como un árbol MIME en
 * base64url.
 *
 * ESTABA ESCRITO DENTRO DE `read-thread.ts` y sale aquí sin cambiarlo, porque
 * ahora tiene un segundo lector: la ingesta al cerebro. Dos copias de un
 * decodificador MIME es la manera clásica de que un hilo se lea distinto según
 * quién lo pida — y en un producto cuya firma es la procedencia, «la cita no
 * coincide con el correo» es el peor síntoma posible.
 */

export type MimePart = {
  mimeType?: string;
  /**
   * `attachmentId` está aquí desde que los adjuntos entran al cerebro (0124):
   * es el asa con la que se piden los bytes de esta parte, y sólo viene cuando
   * el contenido NO está en línea.
   */
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: MimePart[];
  filename?: string;
  headers?: MailHeader[];
};

export function decodeBase64Url(s: string): string {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(norm, 'base64').toString('utf-8');
}

/**
 * El primer `text/plain` del árbol, con el cuerpo suelto como último recurso.
 *
 * PREFIERE PLANO SOBRE HTML a propósito. Un correo corporativo trae el mismo
 * texto dos veces —una en plano y otra envuelta en tres tablas y una firma con
 * logo— y la versión en HTML, una vez desmarcada, es mayoritariamente ruido que
 * se llevaría los embeddings por delante.
 */
export function extractText(payload: MimePart | undefined): string {
  if (!payload) return '';
  // DOS PASADAS Y NO UNA. Un `multipart/alternative` trae el HTML ANTES que el
  // plano más veces de las que no, así que una sola recursión «devuelve el
  // primero que tenga texto» devuelve el HTML — con sus tablas, su firma y su
  // logo— aunque el plano estuviera dos partes más abajo. Buscar primero en
  // todo el árbol lo que se prefiere, y sólo entonces conformarse, es la
  // diferencia entre archivar el correo y archivar su maquetación.
  return findPlain(payload) || findAny(payload);
}

function findPlain(payload: MimePart): string {
  if (payload.body?.data && payload.mimeType?.startsWith('text/plain')) {
    return decodeBase64Url(payload.body.data);
  }
  for (const p of payload.parts ?? []) {
    const t = findPlain(p);
    if (t) return t;
  }
  return '';
}

function findAny(payload: MimePart): string {
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  for (const p of payload.parts ?? []) {
    const t = findAny(p);
    if (t) return t;
  }
  return '';
}

/**
 * Lo que una respuesta arrastra del mensaje anterior, fuera.
 *
 * POR QUÉ IMPORTA MÁS DE LO QUE PARECE. Un hilo de diez respuestas contiene el
 * primer mensaje diez veces, porque cada cliente de correo vuelve a pegar todo
 * lo anterior debajo. Sin esta poda, el hilo se archiva con el texto original
 * repetido diez veces: se paga diez veces el embedding, y una búsqueda de una
 * frase devuelve diez pasajes idénticos que empujan fuera a todo lo demás.
 *
 * Los cortes son los que producen prácticamente todos los clientes reales
 * (Gmail, Outlook, Apple Mail, y los `>` de siempre). Se corta en el PRIMERO
 * que aparezca y sólo si deja algo detrás: una respuesta que es únicamente cita
 * se prefiere entera, antes que desaparecida.
 */
const QUOTE_MARKERS: RegExp[] = [
  /^\s*On .{5,120}\s+wrote:\s*$/m,
  /^\s*El .{5,120}\s+escribió:\s*$/m,
  /^\s*-{2,}\s*(Original Message|Mensaje original|Forwarded message|Mensaje reenviado)\s*-{2,}\s*$/im,
  /^\s*_{5,}\s*$/m,
  /^\s*(De|From):\s.+$/m,
];

export function stripQuotedReply(text: string): string {
  let cut = text.length;
  for (const marker of QUOTE_MARKERS) {
    const m = marker.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  const kept = text.slice(0, cut).trimEnd();
  // Un mensaje que sólo era cita se queda como estaba: perder el texto entero
  // es peor que guardarlo repetido.
  return kept.trim().length > 0 ? kept : text.trimEnd();
}

/**
 * Los adjuntos del árbol MIME, sin bajarse ni un byte.
 *
 * Gmail no devuelve el contenido de un adjunto dentro del mensaje: devuelve la
 * PARTE, con su nombre, su tipo, su tamaño y un `attachmentId` con el que se
 * pide aparte. Eso es exactamente lo que hace falta para decidir si merece la
 * pena pedirlo, que es todo el sentido de enumerarlos antes de descargarlos.
 *
 * QUÉ CUENTA COMO ADJUNTO, aquí: una parte con nombre de archivo. Sin nombre es
 * el cuerpo del mensaje en alguna de sus versiones, y con nombre pero sin
 * `attachmentId` es una parte incrustada cuyo contenido ya venía en línea —
 * típicamente el logo de una firma. Las dos se dejan pasar hacia el filtro de
 * `mail/attachments.ts`, que es quien decide; esto sólo LEE el árbol, y una
 * función que lee un árbol no debería además tener opiniones.
 */
export type RawAttachment = {
  key: string | null;
  filename: string;
  mime: string;
  sizeBytes: number;
};

export function collectAttachments(payload: MimePart | undefined): RawAttachment[] {
  const out: RawAttachment[] = [];
  walk(payload, out);
  return out;
}

function walk(part: MimePart | undefined, out: RawAttachment[]): void {
  if (!part) return;
  const filename = (part.filename ?? '').trim();
  if (filename) {
    out.push({
      key: (part.body as { attachmentId?: string } | undefined)?.attachmentId ?? null,
      filename,
      mime: part.mimeType ?? '',
      sizeBytes: part.body?.size ?? 0,
    });
  }
  for (const child of part.parts ?? []) walk(child, out);
}
