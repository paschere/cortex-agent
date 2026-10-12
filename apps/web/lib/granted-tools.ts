import 'server-only';
import { isToolDenied } from '@/lib/tool-access';
import { type AnyTool, filterTools, toolAllowedByModules } from '@cortex/agent-tools';

/**
 * LO QUE EL AGENTE TIENE CONCEDIDO EN UNA SUPERFICIE (`ToolContext.grantedToolIds`).
 *
 * `research.parallel` reparte piezas que llaman herramientas; sólo puede darles
 * las que esta superficie concede. El chat las calcula con: concesiones del
 * agente -> lista de denegados de los equipos de la persona -> módulos
 * apagados -> familias silenciadas. Todas las demás superficies (MCP, rutinas,
 * tareas en segundo plano, Chat de Google, automatizaciones, orquestador) usan
 * ESTE mismo cálculo, así que ninguna puede conceder de más.
 *
 * Falla cerrado: sin denegados/módulos conocidos, quien llama no debe armar la
 * lista; `undefined` en el contexto significa «no se sabe» y las piezas no
 * reciben herramientas.
 */
export interface GrantInputs {
  allowedTools: readonly string[];
  /** Patrones denegados por los equipos de la persona (`deniedToolPatterns`). */
  denied: string[];
  /** Módulos prendidos (`enabledModules`). */
  modulesOn: Parameters<typeof toolAllowedByModules>[1];
  /** Familias silenciadas en la conversación (sólo el chat). */
  mutedFamilies?: ReadonlySet<string>;
  /** Techo propio de la superficie; sólo resta. */
  extraFilter?: (tool: { id: string }) => boolean;
}

export function grantedTools(input: GrantInputs): AnyTool[] {
  return filterTools([...input.allowedTools])
    .filter((t) => input.denied.length === 0 || !isToolDenied(t.id, input.denied))
    .filter((t) => toolAllowedByModules(t.id, input.modulesOn))
    .filter((t) => !input.mutedFamilies?.has(t.id.split('.')[0] ?? t.id))
    .filter((t) => (input.extraFilter ? input.extraFilter(t) : true));
}

export function grantedToolIdsFor(input: GrantInputs): string[] {
  return grantedTools(input).map((t) => t.id);
}

/** Los ids de una lista de herramientas ya filtrada por la superficie. */
export function idsOf(list: readonly { id: string }[]): string[] {
  return list.map((t) => t.id);
}

/**
 * MCP: el catálogo por persona ya viene filtrado por equipos y módulos; aquí se
 * acota al agente que atribuye la llamada (nunca más de lo que ese agente permite).
 */
export function grantedForAgent(
  entries: Iterable<{ agentId: string; tool: { id: string } }>,
  agentId: string,
): string[] {
  return [...entries].filter((e) => e.agentId === agentId).map((e) => e.tool.id);
}
