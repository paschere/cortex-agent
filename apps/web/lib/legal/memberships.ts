/**
 * Pura: a quién le impide borrar su usuario ser la única dueña de una empresa
 * con más gente, y qué espacios se van con la cuenta porque sólo estaba ella.
 * Ver lib/legal/account-deletion.ts.
 */

export interface DeletionBlocker {
  organizationId: string;
  organizationName: string;
}

export interface Membership {
  organizationId: string;
  organizationName: string;
  role: string;
  members: number;
  owners: number;
}

/** Pura: qué empresas impiden borrar la cuenta y cuáles se purgan con ella. */
export function classifyMemberships(memberships: readonly Membership[]): {
  blockers: DeletionBlocker[];
  solo: Membership[];
  shared: Membership[];
} {
  const blockers: DeletionBlocker[] = [];
  const solo: Membership[] = [];
  const shared: Membership[] = [];
  for (const m of memberships) {
    if (m.members <= 1) solo.push(m);
    else if (m.role === 'owner' && m.owners <= 1) {
      blockers.push({ organizationId: m.organizationId, organizationName: m.organizationName });
    } else shared.push(m);
  }
  return { blockers, solo, shared };
}
