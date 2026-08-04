export * from './types.js';
export * from './runtime.js';
export { cortexAgent, systemPrompt } from './cortex/index.js';
// The `sales` and `recruiting` definitions that used to sit beside this one are
// gone. They were never in the registry (Cortex is the only agent the product
// exposes, and migration 0037 archived the rest in the DB), and their tool
// lists and prompts were written around the rate, recruiting and ATS families
// that migration 0063 retired — so what survived here was a static description
// of capabilities the product no longer has. The archived DB rows remain the
// record of what those agents were allowed to reach.

import { cortexAgent } from './cortex/index.js';
import type { AgentDefinition } from './types.js';

const REGISTRY = new Map<string, AgentDefinition>();
REGISTRY.set(cortexAgent.id, cortexAgent);

export function getAgent(slug: string): AgentDefinition | undefined {
  return REGISTRY.get(slug);
}

export function listAgents(): AgentDefinition[] {
  return [...REGISTRY.values()];
}
