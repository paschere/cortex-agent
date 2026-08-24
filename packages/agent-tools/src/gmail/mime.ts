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
  body?: { data?: string; size?: number };
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
