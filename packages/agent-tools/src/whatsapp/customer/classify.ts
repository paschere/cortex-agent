import type { BusinessHours, FaqEntry, Intent } from './shape';

/**
 * QUÉ PIDE QUIEN ESCRIBE — SIN MODELO.
 *
 * Un clasificador de reglas, a propósito. Lo que el bot puede contestar solo es
 * una lista cerrada (estado de pedido o guía, saldo, facturas, datos públicos,
 * preguntas aprobadas) y cada respuesta sale de datos, nunca redactada. Para
 * eso no hace falta un modelo, y un modelo traería lo único que aquí no puede
 * pasar: una respuesta distinta cada vez para el mismo hecho, o una cifra
 * «razonable» que no está en ninguna factura. Lo que no encaja con seguridad
 * es `otro`, y `otro` va a una persona.
 */

/** Minúsculas, sin tildes, sin signos, espacios simples. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[¿?¡!.,;:()"'«»*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Baja y alta: el mensaje ENTERO, nunca una palabra suelta
// ---------------------------------------------------------------------------
// «No me escriban más» es una baja; «la factura dice baja de inventario» no.
// Por eso se compara el mensaje completo contra frases cerradas.
const OPT_OUT =
  /^(stop|baja|de baja|darme de baja|dame de baja|dar de baja|no me escrib\w*( mas)?|no me vuelvan a escribir|no quiero (recibir )?mas mensajes|no mas mensajes|no me interesa|cancelar (suscripcion|mensajes)|desuscrib\w*|unsubscribe)$/;
const OPT_IN = /^(start|activar|reactivar|alta|volver a activar)$/;

export function isOptOut(text: string): boolean {
  return OPT_OUT.test(fold(text));
}

export function isOptIn(text: string): boolean {
  return OPT_IN.test(fold(text));
}

// ---------------------------------------------------------------------------
// Referencias: NIT, factura, guía o pedido
// ---------------------------------------------------------------------------

/** El NIT que alguien escribió («NIT 900.123.456-7»), en dígitos, o null. */
export function extractNit(text: string, opts: { loose?: boolean } = {}): string | null {
  const explicit =
    /\bnit\b\s*(?:es\s+|n[°ºo]\.?\s*|#\s*|:\s*|-\s*)?(\d[\d.]{4,16}\d(?:\s*-\s*\d)?)/i.exec(text);
  const raw =
    explicit?.[1] ??
    // Sin la palabra «NIT», sólo cuando se le acaba de pedir: un número de 8 a
    // 10 dígitos con puntos o con dígito de verificación.
    (opts.loose
      ? /(?<![\w-])(\d{1,3}(?:\.\d{3}){2,3}(?:-\d)?|\d{8,10}-\d)(?![\w-])/.exec(text)?.[1]
      : null);
  if (!raw) return null;
  const tail = /-\s*(\d)\s*$/.exec(raw);
  const digits = raw.replace(/-\s*\d\s*$/, '').replace(/\D/g, '');
  if (!/^\d{6,15}$/.test(digits)) return null;
  return tail ? `${digits}-${tail[1]}` : digits;
}

/** El número de factura que alguien escribió («factura FV-1234», «FE 88»), o null. */
export function extractInvoiceNumber(text: string): string | null {
  const keyword =
    /\b(?:factura|fact|fra)\b\.?\s*(?:electronica\s*)?(?:n[°ºo]\.?|numero|nro\.?|#|:)?\s*([a-z]{0,6}[\s-]?\d{1,12})\b/i.exec(
      text.normalize('NFD').replace(/\p{M}/gu, ''),
    );
  if (keyword?.[1]) return keyword[1].replace(/\s+/g, '').toUpperCase();
  // Sin la palabra, un prefijo de factura colombiano pegado a un número.
  const prefixed = /\b((?:fv|fe|fc|fac|sete|setp)[\s-]?\d{1,12})\b/i.exec(text);
  return prefixed?.[1] ? prefixed[1].replace(/\s+/g, '').toUpperCase() : null;
}

/** El número de guía o pedido que alguien escribió, o null. Siempre lleva al menos un dígito. */
export function extractOrderNumber(text: string): string | null {
  const plain = text.normalize('NFD').replace(/\p{M}/gu, '');
  const keyword =
    /\b(?:guia|pedido|orden|remesa|envio|tracking|despacho|rastreo)\b\s*(?:de\s+(?:carga|transporte)\s*)?(?:n[°ºo]\.?|numero|nro\.?|#|:)?\s*([a-z0-9][a-z0-9-]{2,29})\b/i.exec(
      plain,
    );
  const candidate = keyword?.[1];
  if (candidate && /\d/.test(candidate)) return candidate.toUpperCase();
  return null;
}

/** Un número suelto de guía (sólo cuando se acaba de pedir): 5+ caracteres con dígitos. */
export function extractBareReference(text: string): string | null {
  const m = /(?<![\w-])([a-z]{0,4}-?\d[\d-]{3,29})(?![\w-])/i.exec(text.trim());
  return m?.[1] ? m[1].toUpperCase() : null;
}

/** Para comparar números de factura o guía: mayúsculas y sólo letras y dígitos. */
export function normalizeReference(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * ¿Es la misma factura? Igual sin signos, o — si quien escribe sólo puso el
 * número — los mismos dígitos («1234» y «FV-1234»). Sólo se usa DESPUÉS de
 * haber encontrado al cliente por su NIT, así que el número sólo se compara
 * contra las facturas de ese cliente.
 */
export function sameReference(typed: string, stored: string | null | undefined): boolean {
  const a = normalizeReference(typed);
  const b = normalizeReference(stored);
  if (!a || !b) return false;
  if (a === b) return true;
  const digits = (s: string) => s.replace(/\D/g, '').replace(/^0+/, '');
  return /^\d+$/.test(a) && digits(a).length >= 3 && digits(a) === digits(b);
}

// ---------------------------------------------------------------------------
// La intención
// ---------------------------------------------------------------------------

const RULES: Array<{ intent: Intent; re: RegExp }> = [
  {
    intent: 'queja',
    re: /\b(queja|reclamo|reclamar|danad\w*|averiad\w*|rot[oa]s?|perdid[oa]s?|pesim\w*|inaceptable|molest\w*|inconform\w*|mal servicio|estafa|devolucion|indignad\w*)\b/,
  },
  {
    intent: 'persona',
    re: /\b(asesor\w*|humano|persona|agente|operador\w*|hablar con|comunicarme con|llamenme|llamar(me)?|alguien (del|de la) (equipo|empresa))\b/,
  },
  {
    intent: 'cotizacion',
    re: /\b(cotiz\w*|precio\w*|tarifa\w*|cuanto (cuesta|vale|cobran|sale)|presupuesto|propuesta comercial)\b/,
  },
  {
    intent: 'estado_pedido',
    re: /\b(guia|pedido|orden de compra|envio|despacho|remesa|rastre\w*|tracking|mi carga|mercancia|cuando llega|donde va|donde esta mi|ya salio|ya despacharon)\b/,
  },
  {
    intent: 'saldo',
    re: /\b(saldo|cuanto (le )?debo|cuanto (les )?debemos|deuda|estado de cuenta|cartera|pendiente por pagar|cuanto tengo pendiente|paz y salvo)\b/,
  },
  {
    intent: 'facturas',
    re: /\b(factura\w*|vencid\w*|por vencer)\b/,
  },
  {
    intent: 'empresa',
    re: /\b(horario\w*|a que hora|abren|cierran|atienden|direccion|donde (quedan|estan|los encuentro)|ubicacion|sede\w*|telefono\w*|correo|email|medios? de pago|como (les )?pago)\b/,
  },
];

const GREETING =
  /^(hola|ola|holi|buen(os|as)( dias| tardes| noches)?|buenas|hey|saludos|que tal|buen dia)( \w+){0,4}$/;
const THANKS =
  /^(muchas )?(gracias|grx|thx|ok|okay|vale|listo|perfecto|entendido|de acuerdo|super|excelente)( \w+){0,3}$/;

export interface Classification {
  intent: Intent;
  /** `alta` cuando una regla pegó; `baja` cuando se adivinó (y entonces va a una persona). */
  confidence: 'alta' | 'baja';
  faq: FaqEntry | null;
}

/**
 * Clasifica un mensaje. `faq` son las preguntas que la empresa aprobó; se
 * prueban DESPUÉS de las reglas de datos («¿cuánto debo?» nunca debe caer en
 * una pregunta frecuente que hable de pagos).
 */
export function classify(text: string, faq: readonly FaqEntry[] = []): Classification {
  const folded = fold(text);
  if (!folded) return { intent: 'otro', confidence: 'baja', faq: null };
  if (isOptOut(text)) return { intent: 'baja', confidence: 'alta', faq: null };
  if (isOptIn(text)) return { intent: 'alta', confidence: 'alta', faq: null };

  for (const rule of RULES) {
    if (rule.re.test(folded)) {
      // «Hola, ¿a qué hora abren?» es empresa; pero si la empresa aprobó una
      // pregunta frecuente que encaja mejor, gana la de la empresa.
      if (rule.intent === 'empresa') {
        const hit = matchFaq(text, faq);
        if (hit) return { intent: 'faq', confidence: 'alta', faq: hit };
      }
      return { intent: rule.intent, confidence: 'alta', faq: null };
    }
  }

  const hit = matchFaq(text, faq);
  if (hit) return { intent: 'faq', confidence: 'alta', faq: hit };
  if (GREETING.test(folded)) return { intent: 'saludo', confidence: 'alta', faq: null };
  if (THANKS.test(folded)) return { intent: 'gracias', confidence: 'alta', faq: null };
  return { intent: 'otro', confidence: 'baja', faq: null };
}

const STOP = new Set([
  'como',
  'cual',
  'cuales',
  'cuando',
  'donde',
  'para',
  'pero',
  'porque',
  'puedo',
  'pueden',
  'quiero',
  'tienen',
  'tiene',
  'hola',
  'buenas',
  'buenos',
  'favor',
  'ustedes',
  'esta',
  'estan',
  'este',
  'esto',
  'sobre',
  'algo',
  'hacer',
  'saber',
  'necesito',
  'gracias',
]);

function tokens(text: string): string[] {
  return fold(text)
    .split(' ')
    .filter((w) => w.length >= 4 && !STOP.has(w));
}

/**
 * La pregunta frecuente que encaja, o null. Exige mucho a propósito: una
 * palabra clave que la empresa escribió, o al menos dos palabras con peso de
 * la pregunta y la mitad de lo que se escribió. Un empate entre dos preguntas
 * es «no sé», y «no sé» va a una persona.
 */
export function matchFaq(text: string, faq: readonly FaqEntry[]): FaqEntry | null {
  const words = new Set(tokens(text));
  if (words.size === 0 || faq.length === 0) return null;
  const folded = ` ${fold(text)} `;

  let best: { entry: FaqEntry; score: number } | null = null;
  let tie = false;
  for (const entry of faq) {
    const keywordHit = (entry.keywords ?? []).some((k) => {
      const key = fold(k);
      return key.length >= 2 && folded.includes(` ${key} `);
    });
    const qWords = new Set(tokens(entry.q));
    let overlap = 0;
    for (const w of words) if (qWords.has(w)) overlap += 1;
    const ratio = overlap / words.size;
    const score = keywordHit ? 10 + overlap : overlap >= 2 && ratio >= 0.5 ? overlap : 0;
    if (score === 0) continue;
    if (!best || score > best.score) {
      best = { entry, score };
      tie = false;
    } else if (score === best.score) {
      tie = true;
    }
  }
  return best && !tie ? best.entry : null;
}

// ---------------------------------------------------------------------------
// Horario
// ---------------------------------------------------------------------------

const WEEKDAY: Record<string, string> = {
  Mon: '1',
  Tue: '2',
  Wed: '3',
  Thu: '4',
  Fri: '5',
  Sat: '6',
  Sun: '7',
};
const DAY_NAME: Record<string, string> = {
  '1': 'el lunes',
  '2': 'el martes',
  '3': 'el miércoles',
  '4': 'el jueves',
  '5': 'el viernes',
  '6': 'el sábado',
  '7': 'el domingo',
};

function localParts(now: Date, timeZone: string): { day: string; hhmm: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Bogota',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: WEEKDAY[get('weekday')] ?? '1', hhmm: `${get('hour')}:${get('minute')}` };
}

/** ¿Hay alguien atendiendo ahora? Sin horario configurado, siempre. */
export function isWithinHours(hours: BusinessHours, timeZone: string, now: Date): boolean {
  const days = Object.values(hours ?? {});
  if (days.every((slots) => !slots || slots.length === 0)) return true;
  const { day, hhmm } = localParts(now, timeZone);
  return (hours[day] ?? []).some(([from, to]) => hhmm >= from && hhmm < to);
}

/** «hoy a las 08:00», «mañana a las 08:00», «el lunes a las 08:00»; null sin horario. */
export function nextOpening(hours: BusinessHours, timeZone: string, now: Date): string | null {
  const days = Object.values(hours ?? {});
  if (days.every((slots) => !slots || slots.length === 0)) return null;
  const { day, hhmm } = localParts(now, timeZone);
  const today = Number(day);
  for (let offset = 0; offset < 8; offset += 1) {
    const key = String(((today - 1 + offset) % 7) + 1);
    const slots = [...(hours[key] ?? [])].sort((a, b) => a[0].localeCompare(b[0]));
    const slot = slots.find(([from]) => offset > 0 || from > hhmm);
    if (!slot) continue;
    const when = offset === 0 ? 'hoy' : offset === 1 ? 'mañana' : DAY_NAME[key];
    return `${when} a las ${slot[0]}`;
  }
  return null;
}

/** El horario como lo diría una persona: «lunes a viernes 08:00–18:00; sábado 08:00–12:00». */
export function describeHours(hours: BusinessHours): string | null {
  const names = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const groups: Array<{ from: number; to: number; text: string }> = [];
  for (let d = 1; d <= 7; d += 1) {
    const slots = hours[String(d)] ?? [];
    if (slots.length === 0) continue;
    const text = slots.map(([a, b]) => `${a}–${b}`).join(' y ');
    const last = groups[groups.length - 1];
    if (last && last.text === text && last.to === d - 1) last.to = d;
    else groups.push({ from: d, to: d, text });
  }
  if (groups.length === 0) return null;
  return groups
    .map((g) =>
      g.from === g.to
        ? `${names[g.from]} ${g.text}`
        : `${names[g.from]} a ${names[g.to]} ${g.text}`,
    )
    .join('; ');
}

// ---------------------------------------------------------------------------
// Teléfonos
// ---------------------------------------------------------------------------

/**
 * ¿Es el mismo teléfono? Un contacto se guarda como la gente lo escribe
 * («300 111 2233», «+57 (300) 111-2233»); WhatsApp lo da con indicativo. Se
 * comparan los dígitos, y si a uno le falta el indicativo, los últimos diez —
 * nunca menos, porque emparejar por siete dígitos es emparejar con un extraño.
 */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? '').replace(/\D/g, '');
  const y = (b ?? '').replace(/\D/g, '');
  if (x.length < 10 || y.length < 10) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 10 && long.endsWith(short) && long.length - short.length <= 3;
}

export interface PhoneContact {
  id: string;
  client_id: string;
  phone: string | null;
  status?: string | null;
}

export type PhoneMatch =
  | { kind: 'one'; clientId: string; contactId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; clientIds: string[] };

/**
 * El cliente de este número. Si el número es contacto de DOS clientes, no es
 * de ninguno: se pide verificación, porque contestarle a uno con los datos del
 * otro es exactamente la fuga que esto existe para impedir.
 */
export function matchPhone(contacts: readonly PhoneContact[], phone: string): PhoneMatch {
  const hits = contacts.filter((c) => c.status !== 'left' && samePhone(c.phone, phone));
  const clients = [...new Set(hits.map((c) => c.client_id))];
  if (clients.length === 0) return { kind: 'none' };
  if (clients.length > 1) return { kind: 'ambiguous', clientIds: clients };
  const first = hits[0] as PhoneContact;
  return { kind: 'one', clientId: first.client_id, contactId: first.id };
}

// ---------------------------------------------------------------------------
// Ritmo
// ---------------------------------------------------------------------------

/** ¿Puede contestar otra vez el bot en esta conversación esta hora? */
export function underRateLimit(botRepliesLastHour: number, maxPerHour: number): boolean {
  return botRepliesLastHour < Math.max(1, maxPerHour);
}
