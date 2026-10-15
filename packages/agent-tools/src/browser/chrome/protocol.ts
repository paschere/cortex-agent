/**
 * El contrato entre Cortex y la extensión «Cortex en tu Chrome».
 *
 * MÓDULO PURO Y SIN DEPENDENCIAS (ni zod): lo importan el servidor y la
 * extensión, y los dos validan con ESTE código. La extensión no se fía de lo
 * que le llega — una orden mal formada, vieja o con campos de más se rechaza
 * aquí antes de tocar la pestaña de nadie — y el servidor no se fía de lo que
 * vuelve: un resultado es dato de una página ajena, no instrucción.
 */

export const SESSION_PREFIX = 'chr_';
const SESSION_ID_RE = /^chr_[a-f0-9]{16}$/;
const COMMAND_ID_RE = /^[0-9a-f-]{36}$/;

export const LIMITS = {
  /** Acciones que una sesión puede ejecutar antes de pedir otra aprobación. */
  actionCap: 150,
  /** Una orden que lleva más de esto en cola ya no se ejecuta. */
  commandTtlMs: 120_000,
  urlMax: 600,
  textMax: 500,
  nameMax: 120,
  reasonMax: 300,
  elements: 120,
  pageText: 2_500,
  readChunk: 6_000,
  resultMaxBytes: 700_000,
  shotMaxChars: 120_000,
} as const;

/** Las teclas que Cortex puede presionar. Nada de atajos con modificadores. */
export const ALLOWED_KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'PageDown',
  'PageUp',
  'Space',
] as const;

export type CommandBody =
  | { op: 'open'; url: string; purpose: string }
  | { op: 'goto'; url: string }
  | { op: 'read'; offset: number }
  | { op: 'click'; ref: string; name: string }
  | { op: 'fill'; ref: string; name: string; text: string }
  | { op: 'select'; ref: string; name: string; text: string }
  | { op: 'check'; ref: string; name: string }
  | { op: 'press'; key: (typeof ALLOWED_KEYS)[number] }
  | { op: 'scroll'; dy: number }
  | { op: 'wait'; ms: number }
  | { op: 'help'; reason: string }
  | { op: 'secret'; ref: string; name: string; label: string }
  | { op: 'close' };

export type CommandOp = CommandBody['op'];

/** Lo que cuenta contra el tope de acciones de la sesión. */
export const COUNTED_OPS: readonly CommandOp[] = [
  'open',
  'goto',
  'click',
  'fill',
  'select',
  'check',
  'press',
  'scroll',
  'secret',
];

export type Command = CommandBody & {
  id: string;
  sessionId: string;
  /** Epoch ms en que se encoló; la extensión descarta lo que pasó de `commandTtlMs`. */
  issuedAt: number;
  /** Tope de acciones de la sesión (la extensión lo cuenta por su lado también). */
  cap: number;
};

export type ResultCode =
  | 'denied'
  | 'blocked'
  | 'stopped'
  | 'cap'
  | 'person_driving'
  | 'no_tab'
  | 'stale'
  | 'secret_field'
  | 'unsupported'
  | 'expired'
  | 'failed'
  | 'bad_command';

export interface PageElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  /** Contraseña, tarjeta, código de un solo uso: el valor jamás sale de la página. */
  sensitive?: boolean;
}

export interface PageView {
  url: string;
  title: string;
  headings: string[];
  alerts: string[];
  text: string;
  elements: PageElement[];
}

export interface CommandResult {
  ok: boolean;
  code?: ResultCode;
  error?: string;
  page?: PageView;
  content?: { text: string; offset: number; nextOffset: number | null; total: number };
  /** JPEG chico en base64, sin el prefijo `data:`. */
  shot?: string;
  /** Sitio sobre el que se actuó (para la auditoría). */
  site?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number, min = 0): v is string =>
  typeof v === 'string' && v.length >= min && v.length <= max;

/** Ref de elemento: e1, e27… Nada más. */
export function validRef(v: unknown): v is string {
  return typeof v === 'string' && /^e\d{1,4}$/.test(v);
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Valida el CUERPO de una orden (lo que el modelo puede pedir). */
export function parseCommandBody(raw: unknown): Parsed<CommandBody> {
  if (!isObj(raw)) return { ok: false, error: 'La orden no es un objeto.' };
  const op = raw.op;
  const bad = (m: string): Parsed<CommandBody> => ({ ok: false, error: m });
  switch (op) {
    case 'open':
      if (!isStr(raw.url, LIMITS.urlMax, 8)) return bad('url inválida');
      return {
        ok: true,
        value: { op, url: raw.url, purpose: isStr(raw.purpose, 200) ? raw.purpose : '' },
      };
    case 'goto':
      if (!isStr(raw.url, LIMITS.urlMax, 8)) return bad('url inválida');
      return { ok: true, value: { op, url: raw.url } };
    case 'read': {
      const offset = raw.offset === undefined ? 0 : raw.offset;
      if (
        typeof offset !== 'number' ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 5_000_000
      )
        return bad('offset inválido');
      return { ok: true, value: { op, offset } };
    }
    case 'click':
    case 'check':
      if (!validRef(raw.ref)) return bad('ref inválida');
      if (!isStr(raw.name, LIMITS.nameMax)) return bad('name inválido');
      return { ok: true, value: { op, ref: raw.ref, name: raw.name } };
    case 'fill':
    case 'select':
      if (!validRef(raw.ref)) return bad('ref inválida');
      if (!isStr(raw.name, LIMITS.nameMax)) return bad('name inválido');
      if (!isStr(raw.text, LIMITS.textMax)) return bad('text inválido');
      return { ok: true, value: { op, ref: raw.ref, name: raw.name, text: raw.text } };
    case 'press':
      if (!(ALLOWED_KEYS as readonly unknown[]).includes(raw.key)) return bad('tecla no permitida');
      return { ok: true, value: { op, key: raw.key as (typeof ALLOWED_KEYS)[number] } };
    case 'scroll':
      if (typeof raw.dy !== 'number' || !Number.isFinite(raw.dy) || Math.abs(raw.dy) > 3000)
        return bad('dy inválido');
      return { ok: true, value: { op, dy: Math.round(raw.dy) } };
    case 'wait':
      if (typeof raw.ms !== 'number' || !Number.isFinite(raw.ms) || raw.ms < 0 || raw.ms > 10_000)
        return bad('ms inválido');
      return { ok: true, value: { op, ms: Math.round(raw.ms) } };
    case 'help':
      if (!isStr(raw.reason, LIMITS.reasonMax, 3)) return bad('reason inválido');
      return { ok: true, value: { op, reason: raw.reason } };
    case 'secret':
      if (!validRef(raw.ref)) return bad('ref inválida');
      if (!isStr(raw.name, LIMITS.nameMax)) return bad('name inválido');
      if (!isStr(raw.label, 120, 3)) return bad('label inválido');
      return { ok: true, value: { op, ref: raw.ref, name: raw.name, label: raw.label } };
    case 'close':
      return { ok: true, value: { op } };
    default:
      return bad('operación desconocida');
  }
}

/** Valida la orden completa tal como llega a la extensión. */
export function parseCommand(raw: unknown, now = Date.now()): Parsed<Command> {
  if (!isObj(raw)) return { ok: false, error: 'La orden no es un objeto.' };
  if (typeof raw.id !== 'string' || !COMMAND_ID_RE.test(raw.id))
    return { ok: false, error: 'id inválido' };
  if (typeof raw.sessionId !== 'string' || !SESSION_ID_RE.test(raw.sessionId))
    return { ok: false, error: 'sesión inválida' };
  if (typeof raw.issuedAt !== 'number' || !Number.isFinite(raw.issuedAt))
    return { ok: false, error: 'issuedAt inválido' };
  if (now - raw.issuedAt > LIMITS.commandTtlMs) return { ok: false, error: 'La orden venció.' };
  if (raw.issuedAt - now > 60_000) return { ok: false, error: 'issuedAt en el futuro' };
  if (typeof raw.cap !== 'number' || !Number.isInteger(raw.cap) || raw.cap < 1 || raw.cap > 1000)
    return { ok: false, error: 'cap inválido' };
  const body = parseCommandBody(raw);
  if (!body.ok) return body;
  return {
    ok: true,
    value: {
      ...body.value,
      id: raw.id,
      sessionId: raw.sessionId,
      issuedAt: raw.issuedAt,
      cap: raw.cap,
    },
  };
}

const RESULT_CODES: readonly string[] = [
  'denied',
  'blocked',
  'stopped',
  'cap',
  'person_driving',
  'no_tab',
  'stale',
  'secret_field',
  'unsupported',
  'expired',
  'failed',
  'bad_command',
];

function parsePage(raw: unknown): PageView | null {
  if (!isObj(raw)) return null;
  if (!isStr(raw.url, 2_000) || !isStr(raw.title, 500) || !isStr(raw.text, 20_000)) return null;
  const strs = (v: unknown, n: number): string[] | null =>
    Array.isArray(v) && v.length <= n && v.every((s) => isStr(s, 400)) ? (v as string[]) : null;
  const headings = strs(raw.headings, 30);
  const alerts = strs(raw.alerts, 30);
  if (!headings || !alerts || !Array.isArray(raw.elements) || raw.elements.length > 400)
    return null;
  const elements: PageElement[] = [];
  for (const e of raw.elements) {
    if (!isObj(e) || !validRef(e.ref) || !isStr(e.role, 40) || !isStr(e.name, 400)) return null;
    const el: PageElement = { ref: e.ref, role: e.role, name: e.name };
    // Un campo sensible JAMÁS lleva valor, aunque la extensión se equivocara.
    if (e.sensitive === true) el.sensitive = true;
    else if (isStr(e.value, 400) && e.value) el.value = e.value;
    if (e.disabled === true) el.disabled = true;
    elements.push(el);
  }
  return { url: raw.url, title: raw.title, headings, alerts, text: raw.text, elements };
}

/** Valida y NORMALIZA un resultado que vuelve de la extensión (no se confía en nada). */
export function parseResult(raw: unknown): Parsed<CommandResult> {
  if (!isObj(raw) || typeof raw.ok !== 'boolean')
    return { ok: false, error: 'Resultado mal formado.' };
  const out: CommandResult = { ok: raw.ok };
  if (raw.code !== undefined) {
    if (typeof raw.code !== 'string' || !RESULT_CODES.includes(raw.code))
      return { ok: false, error: 'code inválido' };
    out.code = raw.code as ResultCode;
  }
  if (raw.error !== undefined) {
    if (!isStr(raw.error, 600)) return { ok: false, error: 'error inválido' };
    out.error = raw.error;
  }
  if (raw.page !== undefined) {
    const page = parsePage(raw.page);
    if (!page) return { ok: false, error: 'page inválida' };
    out.page = page;
  }
  if (raw.content !== undefined) {
    const c = raw.content;
    if (
      !isObj(c) ||
      !isStr(c.text, LIMITS.readChunk + 200) ||
      typeof c.offset !== 'number' ||
      typeof c.total !== 'number' ||
      !(c.nextOffset === null || typeof c.nextOffset === 'number')
    )
      return { ok: false, error: 'content inválido' };
    out.content = { text: c.text, offset: c.offset, nextOffset: c.nextOffset, total: c.total };
  }
  if (raw.shot !== undefined) {
    if (
      typeof raw.shot !== 'string' ||
      raw.shot.length > LIMITS.shotMaxChars ||
      !/^[A-Za-z0-9+/=]+$/.test(raw.shot)
    )
      return { ok: false, error: 'shot inválido' };
    out.shot = raw.shot;
  }
  if (raw.site !== undefined) {
    if (!isStr(raw.site, 253)) return { ok: false, error: 'site inválido' };
    out.site = raw.site;
  }
  return { ok: true, value: out };
}

/**
 * La ref del modelo, resuelta contra una mirada fresca y verificada contra el
 * nombre que el modelo dice haber leído. La misma tesis de live.ts: la ref es
 * un índice sobre una página que pudo cambiar, así que se exige el nombre.
 * Devuelve el elemento o una frase «mira de nuevo».
 */
export function resolveElement(
  elements: readonly PageElement[],
  ref: string,
  claimedName: string,
): { el: PageElement } | { stale: string } {
  const el = elements.find((e) => e.ref === ref);
  if (!el) {
    return {
      stale: `La página ya no tiene un elemento ${ref}. Cambió desde tu último vistazo: mira de nuevo y elige otra vez.`,
    };
  }
  const wanted = claimedName.trim().toLowerCase();
  const actual = (el.name ?? '').trim().toLowerCase();
  if (
    wanted &&
    actual &&
    actual !== wanted &&
    !actual.includes(wanted) &&
    !wanted.includes(actual)
  ) {
    return {
      stale: `El elemento ${ref} ahora se llama «${el.name}», no «${claimedName}». La página cambió: mira de nuevo antes de actuar.`,
    };
  }
  return { el };
}

/** ¿Un campo con estas pistas guarda un secreto? (clave, tarjeta, código de un solo uso) */
export function looksSensitive(hints: {
  type?: string | null;
  autocomplete?: string | null;
  name?: string | null;
  id?: string | null;
  label?: string | null;
}): boolean {
  if ((hints.type ?? '').toLowerCase() === 'password') return true;
  const auto = (hints.autocomplete ?? '').toLowerCase();
  if (/(password|one-time-code|cc-number|cc-csc|cc-exp|cc-name)/.test(auto)) return true;
  const blob = `${hints.name ?? ''} ${hints.id ?? ''} ${hints.label ?? ''}`.toLowerCase();
  return /(pass(word|wd)?\b|contrase|\bclave\b|\bcvv\b|\bcvc\b|\bpin\b|\botp\b|token|secret|api.?key|llave|\bnip\b|iban|tarjeta|card.?num|cardnumber|c[oó]digo de (seguridad|verificaci))/.test(
    blob,
  );
}

/** Tope de acciones: ¿cabe una más? Pura, para el servidor y para la extensión. */
export function capDecision(
  used: number,
  cap: number,
  op: CommandOp,
): { ok: true; counts: boolean } | { ok: false; message: string } {
  const counts = COUNTED_OPS.includes(op);
  if (counts && used >= cap) {
    return {
      ok: false,
      message: `Se llegó al tope de ${cap} acciones en esta sesión de tu Chrome. Cierra la sesión y, si hace falta, abre otra con la aprobación de la persona.`,
    };
  }
  return { ok: true, counts };
}

/** Un id de sesión nuevo (la entropía la pone quien llama). */
export function newSessionId(hex16: string): string {
  return `${SESSION_PREFIX}${hex16}`;
}

export function isChromeSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}
