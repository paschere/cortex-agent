export * from './types.js';
export * from './runtime.js';
export { salesAgent, systemPrompt } from './sales/index.js';
export { recruitingAgent } from './recruiting/index.js';

import { salesAgent } from './sales/index.js';
import { recruitingAgent } from './recruiting/index.js';
import type { AgentDefinition } from './types.js';

const REGISTRY = new Map<string, AgentDefinition>();
REGISTRY.set(salesAgent.id, salesAgent);
REGISTRY.set(recruitingAgent.id, recruitingAgent);

export function getAgent(slug: string): AgentDefinition | undefined {
  return REGISTRY.get(slug);
}

export function listAgents(): AgentDefinition[] {
  return [...REGISTRY.values()];
}
