import 'server-only';
import { listTools } from '@zipdev/agent-tools';
import { type BuilderTool, familyOf } from './playbook';

/**
 * The live tool registry, flattened for the builder's tool picker. Server-only
 * so the registry never lands in the client bundle — the pages pass the result
 * down as a plain prop.
 */
export function builderToolCatalog(): BuilderTool[] {
  return listTools()
    .filter((t) => !t.id.startsWith('test.'))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => ({
      id: t.id,
      description: t.description,
      family: familyOf(t.id),
      requiresConfirmation: !!t.requiresConfirmation,
    }));
}
