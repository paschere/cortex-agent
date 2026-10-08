import { NoSuchToolError, type ToolCallRepairFunction, type ToolSet } from 'ai';

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

/** Un candidato mínimo: lo que la ruta ya filtró por permisos, denegaciones y módulos. */
export interface DispatchCandidate {
  id: string;
  kind: string;
}

/** El nombre que ve el modelo para un id del registro. */
export const sdkToolName = (id: string) => id.replaceAll('.', '_');

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
  const similar = allowed
    .filter((c) => c.kind === 'registry' && sdkToolName(c.id).startsWith(`${stem}_`))
    .slice(0, 5)
    .map((c) => sdkToolName(c.id));
  return {
    ok: false,
    message: `La herramienta «${requested}» no existe o no está permitida para este usuario.${
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
