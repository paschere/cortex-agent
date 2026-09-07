export function normalizedWorkspaceIds(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

export function sameWorkspaceScope(a: string[], b: string[]): boolean {
  return JSON.stringify(normalizedWorkspaceIds(a)) === JSON.stringify(normalizedWorkspaceIds(b));
}

export function assertWorkspaceScope(selected: string[], memberships: string[]): void {
  const allowed = new Set(memberships);
  if (selected.length > 30 || selected.some((id) => !allowed.has(id))) {
    throw new Error('Ya no tienes acceso a uno de los espacios seleccionados.');
  }
}

// A deliberate allowlist: lack of requiresConfirmation is NOT proof of a read.
// Every additional reader needs a review of its data scope and side effects.
export const GLOBAL_READ_TOOLS = [
  'kb.search',
  'kb.list_spaces',
  'gmail.search',
  'gmail.list_threads',
  'goals.list',
  'commitments.due_soon',
  'errands.status',
] as const;
export function globalToolAllowed(id: string, role: string): boolean {
  if (!GLOBAL_READ_TOOLS.some((allowed) => allowed === id)) return false;
  // Team-wide management readers do not become accessible merely by joining.
  if (['goals.list', 'commitments.due_soon', 'errands.status'].includes(id)) {
    return role === 'owner' || role === 'admin';
  }
  return true;
}
