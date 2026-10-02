import { CortexError } from '@cortex/core';
import { z } from 'zod';
import type { ToolContext } from '../types';
import { idempotencyKey } from './canonical';
import type { ActionRow, AnySafeActionPolicy, VerifyArgs, VerifyOutcome } from './types';

/**
 * Las piezas que `runTool` usa para cumplir una `SafeActionPolicy`. Viven aquí
 * y no en `registry.ts` para que el registro siga siendo legible: allí queda el
 * orden de las puertas, aquí el detalle de cada una.
 */

/** Ventana por defecto: un día, para envíos. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;

/** Lo máximo que una verificación puede retrasar la respuesta. */
export const VERIFY_TIMEOUT_MS = 5_000;

/**
 * EL CAMPO CON EL QUE SE PIDE REPETIR.
 *
 * Se añade al esquema de entrada de toda herramienta con política (ver
 * `registerTool`), así que el modelo lo ve en la declaración y lo puede pasar;
 * `runTool` lo quita antes de que la herramienta vea su input, y lo deja en el
 * input de la confirmación para que la tarjeta y la aprobación sepan que es una
 * repetición pedida. La descripción es la regla: sólo tras pedirlo la persona.
 * Que la regla se cumpla depende del modelo — por eso la confirmación de una
 * repetición dice «repetición» en la tarjeta, y por eso la auditoría la marca.
 */
export const REPEAT_FLAG = 'repeatConfirmedByUser';

const REPEAT_FLAG_SCHEMA = z
  .boolean()
  .optional()
  .describe(
    'Solo true cuando la persona pidió EXPLÍCITAMENTE repetir una acción que Cortex ya había hecho (p. ej. «sí, envíalo otra vez»). Nunca lo pongas por tu cuenta: sin él, una acción idéntica ya hecha se devuelve en vez de repetirse.',
  );

/** El esquema que ve el modelo: el de la herramienta más el campo de repetir. */
export function withRepeatFlag<T>(schema: z.ZodType<T>): z.ZodType<T> {
  if (schema instanceof z.ZodObject && !(REPEAT_FLAG in schema.shape)) {
    return schema.extend({ [REPEAT_FLAG]: REPEAT_FLAG_SCHEMA }) as unknown as z.ZodType<T>;
  }
  return schema;
}

/** Separa el campo de repetir del input real de la herramienta. */
export function splitRepeatFlag<T>(data: T): { data: T; repeatRequested: boolean } {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !(REPEAT_FLAG in data)) {
    return { data, repeatRequested: false };
  }
  const { [REPEAT_FLAG]: flag, ...rest } = data as Record<string, unknown>;
  return { data: rest as T, repeatRequested: flag === true };
}

export interface ActionGuard {
  key: string;
  windowMs: number;
  scope: string | null;
}

/** La clave de ESTA llamada, o null si la política la deja sin guardia. */
export function guardFor(
  policy: AnySafeActionPolicy,
  toolId: string,
  input: unknown,
  ctx: Pick<ToolContext, 'organizationId' | 'userId' | 'idempotencyScope'>,
): ActionGuard | null {
  const windowMs = policy.windowMs ?? DEFAULT_WINDOW_MS;
  if (windowMs <= 0) return null;
  const material = policy.key ? (policy.key as (i: unknown) => unknown)(input) : input;
  if (material === null || material === undefined) return null;
  const scope = ctx.idempotencyScope ?? null;
  return {
    key: idempotencyKey({
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      toolId,
      input: material,
      scope,
    }),
    windowMs,
    scope,
  };
}

// ---------------------------------------------------------------------------
// Las frases. Español, porque las lee una persona (a través del modelo o en la
// auditoría). La hora, en la de Bogotá: es la del producto mientras no haya
// zona por persona en este camino.
// ---------------------------------------------------------------------------

const TIME_ZONE = 'America/Bogota';

export function whenSaid(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'antes';
  const at = new Date(iso);
  const time = at.toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TIME_ZONE,
  });
  const day = (d: Date) => d.toLocaleDateString('es-CO', { timeZone: TIME_ZONE });
  if (day(at) === day(now)) return `a las ${time}`;
  const date = at.toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
    timeZone: TIME_ZONE,
  });
  return `el ${date} a las ${time}`;
}

function nounOf(policy: AnySafeActionPolicy | undefined): string {
  return policy?.noun ?? 'esto';
}

/** El aviso que viaja con un resultado devuelto en vez de repetido. */
export function replayNotice(row: ActionRow, policy: AnySafeActionPolicy, now = new Date()) {
  const at = row.finished_at ?? row.claimed_at;
  const noun = nounOf(policy);
  const capital = noun.charAt(0).toUpperCase() + noun.slice(1);
  return {
    outcome: 'replayed' as const,
    firstDoneAt: at,
    notice: `Ya lo había hecho ${whenSaid(at, now)}; no lo repetí. ${capital} ya había salido bien con exactamente estos datos.`,
    howToRepeat: `Si la persona pide explícitamente repetirlo, vuelve a llamar con ${REPEAT_FLAG}: true.`,
    relayToUser: true,
  };
}

/** El aviso de una repetición que sí se hizo, porque se pidió. */
export function repeatNotice(prior: ActionRow, now = new Date()) {
  const at = prior.finished_at ?? prior.claimed_at;
  return {
    outcome: 'repeated' as const,
    firstDoneAt: at,
    notice: `Lo repetí porque se pidió; la vez anterior fue ${whenSaid(at, now)}.`,
    relayToUser: true,
  };
}

export function verificationNotice(outcome: VerifyOutcome) {
  const prefix =
    outcome.status === 'verified'
      ? 'Verificado'
      : outcome.status === 'not_verified'
        ? 'No verificado'
        : 'No se pudo verificar';
  return {
    status: outcome.status,
    notice: `${prefix}: ${outcome.detail}`,
    // Sólo lo que no cuadra merece interrumpir: «verificado» es contexto.
    relayToUser: outcome.status === 'not_verified',
  };
}

// ---------------------------------------------------------------------------
// Las dos negativas. Errores con mensaje en español: el envoltorio de cada
// superficie (`toolErrorMessage`) lo pasa tal cual al modelo.
// ---------------------------------------------------------------------------

export class ActionInFlightError extends CortexError {
  constructor(
    public readonly toolId: string,
    public readonly startedAt: string,
  ) {
    super(
      `Esto mismo se está ejecutando ahora (empezó ${whenSaid(startedAt)}). No lo lancé otra vez para no hacerlo dos veces; espera a que termine y revisa el resultado.`,
      'ACTION_IN_FLIGHT',
    );
    this.name = 'ActionInFlightError';
  }
}

export class ActionOutcomeUnknownError extends CortexError {
  constructor(
    public readonly toolId: string,
    public readonly startedAt: string,
  ) {
    super(
      `Hay un intento de esto mismo de ${whenSaid(startedAt)} que no terminó, y no sé si llegó a hacerse. No lo repetí: revisa primero (por ejemplo, en Enviados o en el calendario). Si la persona confirma que quiere hacerlo de nuevo, vuelve a llamar con ${REPEAT_FLAG}: true.`,
      'ACTION_OUTCOME_UNKNOWN',
    );
    this.name = 'ActionOutcomeUnknownError';
  }
}

/** La verificación, con tope de tiempo y sin poder romper la llamada. */
export async function runVerify<I, O>(
  verify: (args: VerifyArgs<I, O>) => Promise<VerifyOutcome>,
  args: VerifyArgs<I, O>,
  timeoutMs = VERIFY_TIMEOUT_MS,
): Promise<VerifyOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      verify(args),
      new Promise<VerifyOutcome>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              status: 'unverifiable',
              detail: 'la comprobación tardó demasiado; no la esperé.',
            }),
          timeoutMs,
        );
      }),
    ]);
  } catch {
    return {
      status: 'unverifiable',
      detail: 'la comprobación falló al consultar el servicio.',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Una línea corta del resultado, para la fila de idempotencia. */
export function summarizeResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const pick = ['messageId', 'paymentId', 'id', 'subject', 'markdown', 'outcome'];
  const parts: string[] = [];
  for (const k of pick) {
    const v = r[k];
    if (typeof v === 'string' && v) parts.push(`${k}=${v.slice(0, 80)}`);
  }
  const event = r.event as Record<string, unknown> | undefined;
  if (event && typeof event.id === 'string') parts.push(`event=${event.id}`);
  const row = r.row as Record<string, unknown> | undefined;
  if (row && typeof row.id === 'string') parts.push(`row=${row.id}`);
  return parts.length ? parts.join(' ') : null;
}
