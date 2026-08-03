export * from './types.js';
export * from './runtime.js';
export { cortexAgent } from './cortex/index.js';
// Legacy definitions kept for reference/back-compat imports; they are NOT in
// the registry — Cortex is the only agent the product exposes (migration 0037
// archives the others in the DB).
export { salesAgent, systemPrompt } from './sales/index.js';
export { recruitingAgent } from './recruiting/index.js';

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
