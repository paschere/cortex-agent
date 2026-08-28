import { logger } from '@cortex/core';
/**
 * Reglas CEL por tenant sobre el choke point: la frontera que el administrador
 * escribe con sus palabras, no la que nosotros preprogramamos.
 *
 * Portado del motor de OpenBot (CopilotKit/openbot, server/src/computer/policy.ts)
 * y adaptado a nuestro modelo: allí la política ES el modelo de riesgo; aquí es
 * una CAPA ENCIMA de la matriz sensibilidad×radio, los mandatos y las dos
 * puertas de confirmación, que siguen intactas debajo. Lo que se conserva de
 * OpenBot, porque es lo que hace al motor creíble:
 *
 * - CEL y no una tabla de columnas. La frontera que una empresa quiere es una
 *   frase («nada que envíe datos de pago fuera en horario no laboral»); una
 *   tabla expresa las formas que se nos ocurrieron, un lenguaje de expresiones
 *   expresa la que se le ocurrió al cliente.
 * - `deny` gana a `allow`, siempre. Una regla que quita permiso no puede ser
 *   derrotada por otra más ancha que lo concede, o la empresa no puede razonar
 *   sobre lo que ha prohibido.
 * - Fail-closed asimétrico: un `deny` roto sigue negando, un `allow` roto no
 *   concede. Un typo bloquea — ruidoso, inmediato y seguro — en vez de admitir.
 * - `dry-run` decide y registra, y deja pasar todo. Existe para que alguien
 *   escriba una regla contra tráfico real y lea el rastro antes de que empiece
 *   a rechazar el trabajo de nadie. Una función de gobierno que nadie se
 *   atreve a encender no es una función de gobierno.
 *
 * Lo que cambia deliberadamente respecto a OpenBot: allí una política sin
 * `allow` no permite nada (default-deny). Aquí `allow` ausente equivale a
 * `["true"]`: nuestro suelo ya lo pone la matriz de riesgo, y un administrador
 * que escribe su primer `deny` no debe dejar el workspace inutilizable por no
 * saber que también tenía que conceder todo lo demás.
 *
 * El contexto lo arma el servidor desde su propia clasificación — nunca desde
 * lo que el modelo dice que va a hacer. Una política que decide sobre una
 * etiqueta suministrada por el llamador es decoración.
 */
import { evaluate as celEvaluate } from 'cel-js';
import type { BlastRadius, RiskLevel, Sensitivity, Surface } from './policy.js';

export type ActionPolicyMode = 'dry-run' | 'enforce';

export interface ActionPolicy {
  /** `enforce` bloquea. `dry-run` decide y registra, y deja pasar. */
  mode: ActionPolicyMode;
  /** Se evalúa primero. Cualquier expresión true = rechazada, diga lo que diga `allow`. */
  deny: string[];
  /** Cualquier expresión true = permitida. `["true"]` es el valor por omisión. */
  allow: string[];
}

/**
 * Los atributos contra los que se puede escribir una regla.
 *
 * Todo sale de la clasificación que `evaluate()` ya calculó del lado servidor:
 * la regla ve lo que la llamada ES (familia, radio, señales), no lo que el
 * llamador dice que es. Ejemplos de reglas reales:
 *
 *   tool.family == "payments"
 *   risk.blastRadius == "external_send" && surface == "schedule"
 *   contains(risk.signals, "compensation-in-payload")
 *   matches(tool.id, "^hubspot\\.") && risk.level != "low"
 */
export interface ActionPolicyContext {
  tool: { id: string; family: string };
  /** 'web' | 'mcp' | 'schedule' — schedule significa desatendido. */
  surface: Surface;
  user: { id: string };
  agent: { id: string };
  risk: {
    level: RiskLevel;
    sensitivity: Sensitivity;
    blastRadius: BlastRadius;
    signals: string[];
  };
  /** True cuando una persona ya aprobó esta llamada concreta. */
  confirmed: boolean;
}

export interface ActionPolicyDecision {
  allowed: boolean;
  mode: ActionPolicyMode;
  /** La expresión que decidió, para que la fila de auditoría diga por qué. */
  matched: string | null;
  /** De qué lista salió. `default` = nada casó y aplicó el suelo. */
  source: 'deny' | 'allow' | 'default';
  /** True cuando la acción debe ejecutarse de verdad (todo dry-run, o allow en enforce). */
  forward: boolean;
  /** El porqué, en palabras que van delante de una persona. */
  reason: string;
}

/**
 * Helpers de cadena registrados como globales CEL.
 *
 * cel-js 0.8 no implementa métodos de string: `tool.id.contains("x")` lanza
 * «Unknown method». Estos globales hacen exigibles las reglas de subcadena.
 * Ambos son case-insensitive, y `contains` acepta listas — una regla sobre
 * `risk.signals` es de las primeras que alguien escribe.
 */
const POLICY_FUNCTIONS: Record<string, CallableFunction> = {
  contains: (haystack: unknown, needle: unknown): boolean => {
    if (Array.isArray(haystack)) {
      return haystack.some((h) => String(h).toLowerCase() === String(needle).toLowerCase());
    }
    return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
  },
  matches: (value: unknown, pattern: unknown): boolean => {
    try {
      return new RegExp(String(pattern), 'i').test(String(value));
    } catch {
      // Un regex imparseable es una regla rota, no un no-match. El llamador
      // trata la excepción como fail-closed; devolver false aquí debilitaría
      // en silencio una regla deny.
      throw new Error(`not a valid pattern: ${String(pattern)}`);
    }
  },
};

/**
 * Evalúa una expresión. Nunca lanza.
 *
 * `onError` decide qué significa una expresión rota, porque la respuesta segura
 * difiere por lista: un `allow` roto no debe permitir, y un `deny` roto no debe
 * dejar de negar.
 */
function matchesExpression(
  expression: string,
  context: ActionPolicyContext,
  onError: boolean,
): boolean {
  try {
    return (
      celEvaluate(expression, context as unknown as Record<string, unknown>, POLICY_FUNCTIONS) ===
      true
    );
  } catch (err) {
    logger.error(
      { expression, err: String(err), treatedAs: onError },
      'action-policy: expression failed to evaluate',
    );
    return onError;
  }
}

export function evaluateActionPolicy(
  policy: ActionPolicy,
  context: ActionPolicyContext,
): ActionPolicyDecision {
  const { mode } = policy;

  // Deny primero, y un deny roto sigue negando (en enforce). Un typo bloquea
  // la acción en vez de admitirla: el fallo es ruidoso, inmediato y seguro.
  for (const expression of policy.deny) {
    if (matchesExpression(expression, context, true)) {
      return {
        allowed: false,
        mode,
        matched: expression,
        source: 'deny',
        // dry-run registra el rechazo y deja seguir el trabajo — eso es lo que
        // hace seguro encenderlo contra tráfico real.
        forward: mode === 'dry-run',
        reason:
          `This workspace's policy does not allow that: ${context.tool.id} ` +
          `is blocked by the rule \`${expression}\`. An org admin can change the policy.`,
      };
    }
  }

  for (const expression of policy.allow) {
    if (matchesExpression(expression, context, false)) {
      return {
        allowed: true,
        mode,
        matched: expression,
        source: 'allow',
        forward: true,
        reason: 'Permitted by policy.',
      };
    }
  }

  return {
    allowed: false,
    mode,
    matched: null,
    source: 'default',
    forward: mode === 'dry-run',
    reason:
      `No rule in this workspace's policy permits ${context.tool.id}, so it was refused. ` +
      'An org admin can add one.',
  };
}

/**
 * Valida una política que llegó de fuera (la fila `action_policy`, o la tool
 * `security.set_action_policy`). Rechaza en vez de coaccionar: «aceptamos tu
 * regla pero no con la forma en que la escribiste» es lo único que no puede
 * pasar aquí — el administrador creería en vigor una restricción que no lo está.
 *
 * Las expresiones NO se validan semánticamente al entrar, solo que sean
 * cadenas: si una regla tiene sentido es asunto del motor, que ahí falla
 * cerrado, y prevalidar aquí serían dos parsers que mantener de acuerdo.
 */
export function parseActionPolicy(
  input: unknown,
): { ok: true; policy: ActionPolicy } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'A policy must be an object with mode, deny and allow.' };
  }
  const candidate = input as Record<string, unknown>;

  const mode = candidate.mode;
  if (mode !== 'dry-run' && mode !== 'enforce') {
    return { ok: false, error: 'mode must be "dry-run" or "enforce".' };
  }

  const lists: { deny: string[]; allow: string[] } = { deny: [], allow: ['true'] };
  for (const key of ['deny', 'allow'] as const) {
    const value = candidate[key];
    if (value === undefined) continue; // deny ausente = []; allow ausente = ["true"]
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
      return { ok: false, error: `${key} must be an array of non-empty CEL expression strings.` };
    }
    lists[key] = [...(value as string[])];
  }

  return { ok: true, policy: { mode, deny: lists.deny, allow: lists.allow } };
}
