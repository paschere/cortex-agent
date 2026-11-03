import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ValidationError } from '@cortex/core';
import { FUNCTION_NAME_RE } from './files';

/**
 * FUNCIONES DE SERVIDOR: LAS PIEZAS PURAS (fase 2, migración 0244).
 *
 * Aquí no hay base ni red: nombres, entrada de la función, el token corto con
 * que la función vuelve a llamar a Cortex, el hash de los tokens de webhook, y
 * el enganche (`FunctionRunner`) con el que la app web pone el Sandbox. El
 * paquete no puede importar `@vercel/sandbox`, igual que no importa esbuild
 * (ver build.ts): la implementación real vive en apps/web/lib/apps/function-runner.ts.
 */

export const FN_TIMEOUT_MS = 60_000;
/** Lo más que cabe en el resultado de una función (JSON). */
export const FN_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Lo más que cabe en la entrada que recibe. */
export const FN_MAX_INPUT_BYTES = 256 * 1024;
/** Cuánto log se guarda por corrida. */
export const FN_LOG_MAX = 20 * 1024;
export const FN_CALLS_PER_MINUTE = 30;
/** Llamadas por minuto que una función le puede hacer al SDK de Cortex (más holgado que el de una pantalla). */
export const FN_SDK_CALLS_PER_MINUTE = 600;
export const FN_TOKEN_TTL_MS = 5 * 60_000;
export const MAX_SECRETS_PER_APP = 50;
export const MAX_SECRET_BYTES = 8 * 1024;
export const MAX_RUNS_KEPT = 500;

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export type RunTrigger = 'screen' | 'rule' | 'schedule' | 'webhook' | 'chat';
export const RUN_TRIGGERS: readonly RunTrigger[] = [
  'screen',
  'rule',
  'schedule',
  'webhook',
  'chat',
];

export function assertFunctionName(name: string): void {
  if (!FUNCTION_NAME_RE.test(name))
    throw new ValidationError(
      'El nombre de una función: minúsculas, números y «_», empieza con letra (2 a 48).',
    );
}

export function assertSecretName(name: string): void {
  if (!SECRET_NAME_RE.test(name))
    throw new ValidationError(
      'El nombre de un secreto va en MAYÚSCULAS con números y «_» (p.ej. SIIGO_API_KEY).',
    );
}

/** La entrada de la función ya serializable y dentro del tope; lanza `ValidationError` si no. */
export function checkFunctionInput(input: unknown): unknown {
  if (input === undefined) return {};
  let text: string | undefined;
  try {
    text = JSON.stringify(input);
  } catch {
    throw new ValidationError('La entrada de la función debe poder escribirse como JSON.');
  }
  if (text === undefined) return {};
  if (Buffer.byteLength(text) > FN_MAX_INPUT_BYTES)
    throw new ValidationError(`La entrada de la función pasa de ${FN_MAX_INPUT_BYTES / 1024} KB.`);
  return JSON.parse(text);
}

/** Recorta un log a `max` caracteres dejando el principio y el final. */
export function capLog(log: string, max = FN_LOG_MAX): string {
  if (log.length <= max) return log;
  const head = Math.floor(max / 4);
  return `${log.slice(0, head)}\n… [recortado] …\n${log.slice(-(max - head - 20))}`;
}

// ---------------------------------------------------------------------------
// Entrada de una regla (`run_function`)
// ---------------------------------------------------------------------------

/**
 * La entrada que una regla le pasa a la función: cada texto de `template`
 * admite `{{campos}}` (los pinta `render`, el mismo de las demás acciones);
 * números, booleanos y null pasan tal cual. Con `row`, agrega `row` (los
 * valores de la fila) y `rowId`.
 */
export function buildRuleInput(
  template: Record<string, string | number | boolean | null>,
  render: (text: string) => string,
  row?: { id?: string; values: Record<string, unknown> } | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) out[k] = typeof v === 'string' ? render(v) : v;
  if (row) {
    out.row = row.values;
    if (row.id) out.rowId = row.id;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Token corto: la función vuelve a llamar a Cortex
// ---------------------------------------------------------------------------

export interface FnTokenClaims {
  /** Versión del formato. */
  v: 1;
  org: string;
  app: string;
  /** Quién es el actor de la llamada: un miembro de Cortex o un usuario externo de la app. */
  actor: { kind: 'member' | 'external'; id: string; name: string };
  /** Clave del rol de la app con que corren las llamadas (`administrador` sólo si una persona administradora la disparó). */
  role: string;
  attributes: Record<string, string>;
  /** La pantalla desde la que se disparó (para auditar como una edición de la pantalla). */
  screen?: string;
  /** Una corrida de «Ver como…» no escribe. */
  readOnly: boolean;
  /** La función que corre (informativo, va al registro). */
  fn: string;
  /** Vence (epoch ms). */
  exp: number;
}

function tokenKey(): Buffer {
  const secret = (process.env.JOBS_SECRET ?? '').trim();
  if (!secret) throw new Error('JOBS_SECRET is not configured; cannot sign function tokens');
  // Una llave derivada por propósito: el mismo secreto no firma cosas distintas.
  return createHmac('sha256', secret).update('cortex.app-fn-sdk.v1').digest();
}

function sign(encoded: string, key: Buffer): string {
  return createHmac('sha256', key).update(encoded).digest('base64url');
}

/** Firma el token de una corrida (5 min). Lanza si JOBS_SECRET no existe. */
export function mintFnToken(
  claims: Omit<FnTokenClaims, 'v' | 'exp'>,
  now: number = Date.now(),
  ttlMs: number = FN_TOKEN_TTL_MS,
): string {
  const full: FnTokenClaims = { ...claims, v: 1, exp: now + ttlMs };
  const encoded = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded, tokenKey())}`;
}

/** El contenido de un token válido y vigente, o null (sin decir por qué). */
export function verifyFnToken(token: string, now: number = Date.now()): FnTokenClaims | null {
  let key: Buffer;
  try {
    key = tokenKey();
  } catch {
    return null;
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const encoded = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const want = Buffer.from(sign(encoded, key), 'base64url');
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const c = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as FnTokenClaims;
    if (c.v !== 1 || typeof c.exp !== 'number' || c.exp <= now) return null;
    if (!c.org || !c.app || !c.role || !c.actor?.id) return null;
    if (c.actor.kind !== 'member' && c.actor.kind !== 'external') return null;
    return c;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token de webhook
// ---------------------------------------------------------------------------

/** Un token de webhook nuevo: 256 bits aleatorios, con prefijo para reconocerlo. */
export function newHookToken(): string {
  return `cxh_${randomBytes(32).toString('base64url')}`;
}

/** El token es aleatorio de 256 bits: un sha256 sin sal alcanza para guardarlo. */
export function hashHookToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** ¿Este token es el del webhook guardado? Compara en tiempo constante. */
export function hookTokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashHookToken(token));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// El enganche con el Sandbox
// ---------------------------------------------------------------------------

export interface FunctionJob {
  organizationId: string;
  appId: string;
  buildId: string;
  name: string;
  /** TODAS las funciones de la compilación ({nombre: js}): el sandbox de la app las carga una vez. */
  functions: Record<string, string>;
  input: unknown;
  secrets: Record<string, string>;
  user: { id: string; name: string; role: string; attributes: Record<string, string> } | null;
  /** Token para que la función llame al SDK de Cortex (POST /api/apps/code/fn-sdk). */
  token: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface FunctionJobResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  log: string;
  timedOut?: boolean;
}

export interface FunctionRunner {
  run(job: FunctionJob): Promise<FunctionJobResult>;
}

/** Como los de build.ts: en `globalThis`, porque Next carga el módulo más de una vez. */
const RUNNER_KEY = Symbol.for('cortex.app-code.function-runner');

export function setFunctionRunner(runner: FunctionRunner | null): void {
  (globalThis as unknown as Record<symbol, FunctionRunner | null>)[RUNNER_KEY] = runner;
}

export function getFunctionRunner(): FunctionRunner {
  const runner = (globalThis as unknown as Record<symbol, FunctionRunner | null | undefined>)[
    RUNNER_KEY
  ];
  if (!runner)
    throw new ValidationError('Correr funciones de servidor no está disponible en este entorno.');
  return runner;
}
