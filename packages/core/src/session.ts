import type { Role, UUID } from './types';
export interface SessionUser {
  id: UUID;
  email: string;
  name: string | null;
  role: Role;
}
