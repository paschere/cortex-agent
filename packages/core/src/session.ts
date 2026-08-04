import type { Role, UUID } from './types';

/**
 * Role a user holds *inside a workspace*, as issued by better-auth's
 * organization plugin. Distinct from `Role`, which is the legacy
 * single-company role stored on public.users.
 */
export type OrgRole = 'owner' | 'admin' | 'member';

/** The workspace (tenant) a session is currently acting in. */
export interface ActiveOrganization {
  id: string;
  name: string;
  slug: string | null;
  /** The signed-in user's role within this workspace. */
  role: OrgRole;
}

export interface SessionUser {
  id: UUID;
  email: string;
  name: string | null;
  role: Role;
  /**
   * Never null for a signed-in user: every account is guaranteed a workspace
   * on first authenticated request (see apps/web/lib/organization.ts). Data
   * scoping keys off this id.
   */
  organization: ActiveOrganization;
}
