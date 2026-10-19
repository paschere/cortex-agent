import {
  InvalidToolArgumentsError,
  NoSuchToolError,
  type ToolCallRepairFunction,
  type ToolSet,
} from 'ai';

/**
 * RED DE SEGURIDAD: el modelo llama una herramienta que no vino en la selección.
 *
 * La selección por turno recorta el catálogo, y el system prompt puede nombrar
 * una herramienta de un flujo que quedó fuera. El SDK lanzaba
 * `AI_NoSuchToolError` y el turno moría. Ahora la llamada se redirige a
 * `use_tool`, una herramienta despachadora que siempre va declarada y que
 * ejecuta la real con `runTool` (confirmaciones, políticas, auditoría
 * intactas). Si la herramienta no existe o no está permitida, `use_tool`
 * devuelve un resultado de error que el modelo puede leer — nunca una excepción.
 */

export const DISPATCH_TOOL_NAME = 'use_tool';

/** Marca que lleva una llamada de argumentos rotos reenviada a `use_tool`. */
export const INVALID_ARGS_MARK = '__invalid_arguments';

/** Un candidato mínimo: lo que la ruta ya filtró por permisos, denegaciones y módulos. */
export interface DispatchCandidate {
  id: string;
  kind: string;
}

/** El nombre que ve el modelo para un id del registro. */
export const sdkToolName = (id: string) => id.replaceAll('.', '_');

/**
 * LA ENTRADA DE `use_tool` = LA ENTRADA DE LA HERRAMIENTA.
 *
 * El modelo escribe la llamada de dos maneras y las dos son razonables:
 *   { tool, args: { ... } }                 (lo que dice la descripción)
 *   { tool, tracker: "x", values: { ... } } (los argumentos al lado de `tool`)
 * y a veces `args` llega como un texto JSON. Antes sólo funcionaba la primera:
 * en la segunda `args` quedaba vacío y la herramienta fallaba con «Invalid
 * input», que el modelo leyó como «no tengo herramienta». Esta función junta
 * las tres formas en el objeto que la herramienta recibe; lo de `args` manda
 * sobre lo suelto.
 */
export function mergeDispatchArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const { tool: _tool, args, [INVALID_ARGS_MARK]: _mark, ...loose } = raw;
  let nested: Record<string, unknown> = {};
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    nested = args as Record<string, unknown>;
  } else if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        nested = parsed as Record<string, unknown>;
    } catch {
      /* texto que no es JSON: se ignora, la herramienta dirá qué falta */
    }
  }
  return { ...loose, ...nested };
}

export type DispatchResolution<T extends DispatchCandidate> =
  | { ok: true; candidate: T }
  | { ok: false; message: string };

/**
 * Busca la herramienta pedida (con punto o con guion bajo) entre las PERMITIDAS.
 * Sólo del registro: las de servidores MCP no se despachan por aquí.
 */
export function resolveDispatch<T extends DispatchCandidate>(
  requested: string,
  allowed: readonly T[],
): DispatchResolution<T> {
  const wanted = sdkToolName(requested.trim());
  const found = allowed.find((c) => c.kind === 'registry' && sdkToolName(c.id) === wanted);
  if (found) return { ok: true, candidate: found };
  const stem = wanted.split('_')[0] ?? wanted;
  const family = allowed
    .filter((c) => c.kind === 'registry' && sdkToolName(c.id).startsWith(`${stem}_`))
    .map((c) => sdkToolName(c.id));
  // Un nombre de FAMILIA («trackers», «trackers_») es una pregunta: qué hay ahí.
  const asksFamily = wanted === stem || wanted === `${stem}_`;
  const similar = family.slice(0, asksFamily ? 25 : 5);
  return {
    ok: false,
    message:
      asksFamily && similar.length > 0
        ? `«${requested}» es una familia, no una herramienta. Herramientas de ${stem}: ${similar.join(', ')}. Llama una con use_tool (tool + args) o directamente si ya la tienes declarada.`
        : `La herramienta «${requested}» no existe o no está permitida para este usuario.${
            similar.length > 0
              ? ` Prueba con: ${similar.join(', ')}.`
              : ' Usa una de las herramientas que tienes declaradas.'
          }`,
  };
}

/**
 * Envuelve la reparación de argumentos: un NoSuchToolError se convierte en una
 * llamada a `use_tool` con { tool, args }; lo demás pasa a la reparación base.
 */
export function withNoSuchToolRedirect<TOOLS extends ToolSet>(
  base: ToolCallRepairFunction<TOOLS>,
  dispatcherName = DISPATCH_TOOL_NAME,
): ToolCallRepairFunction<TOOLS> {
  return async (options) => {
    const { toolCall, error, tools } = options;
    if (!NoSuchToolError.isInstance(error)) return base(options);
    if (toolCall.toolName === dispatcherName || !(dispatcherName in tools)) return null;
    let args: unknown = {};
    try {
      args = toolCall.args ? JSON.parse(toolCall.args) : {};
    } catch {
      args = {};
    }
    return {
      ...toolCall,
      toolName: dispatcherName,
      args: JSON.stringify({ tool: toolCall.toolName, args }),
    };
  };
}

/**
 * ARGUMENTOS ROTOS QUE NI LA REPARACIÓN ARREGLÓ: el turno NO se cae.
 *
 * Cuando el modelo manda argumentos que no pasan el esquema y la reparación
 * (determinista y por modelo, lib/tool-call-repair.ts) no los arregla, el SDK
 * lanzaba `AI_InvalidToolArgumentsError` y el turno moría con «No pude terminar
 * esta respuesta por un error» (2026-10-19 08:59 y 09:35: `trackers_query` con
 * la fuente «cortex.ventas» como tabla, y `apps_apply_draft` con un JSON de
 * pantallas roto). Ahora la llamada se reenvía a `use_tool` con los argumentos
 * tal cual y la marca de invalidez: allí la herramienta real los valida con su
 * mensaje en español —qué campo falla y por qué— y el modelo recibe un error
 * legible para corregir, como con cualquier otro fallo de herramienta.
 */
export function withInvalidArgsRedirect<TOOLS extends ToolSet>(
  base: ToolCallRepairFunction<TOOLS>,
  dispatcherName = DISPATCH_TOOL_NAME,
): ToolCallRepairFunction<TOOLS> {
  return async (options) => {
    const repaired = await base(options);
    if (repaired) return repaired;
    const { toolCall, error, tools } = options;
    if (!InvalidToolArgumentsError.isInstance(error)) return null;
    if (toolCall.toolName === dispatcherName || !(dispatcherName in tools)) return null;
    let args: Record<string, unknown> = {};
    let readable = true;
    try {
      const parsed: unknown = toolCall.args ? JSON.parse(toolCall.args) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        args = parsed as Record<string, unknown>;
      else readable = false;
    } catch {
      readable = false;
    }
    return {
      ...toolCall,
      toolName: dispatcherName,
      args: JSON.stringify({
        tool: toolCall.toolName,
        args,
        [INVALID_ARGS_MARK]: readable ? 'schema' : 'json',
      }),
    };
  };
}

/** Lo que el modelo lee cuando sus argumentos no eran JSON válido. */
export function brokenJsonMessage(tool: string): string {
  return `Los argumentos de ${tool} llegaron como JSON roto o incompleto (casi siempre porque la llamada era demasiado grande o tenía un error de sintaxis). Vuelve a llamar ${tool} con el JSON completo y válido; si es muy grande, pártelo en llamadas más pequeñas (por ejemplo crea lo básico y agrega el resto con una herramienta de cambio).`;
}
