import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface BrowserProfile {
  id: string;
  organization_id: string;
  owner_id: string;
  name: string;
  shared: boolean;
  revision: number;
}
export interface ProfileRef {
  key: string;
  revision: number;
}
export function browserActorKey(organizationId: string, userId: string): string {
  return `person-${createHash('sha256')
    .update(JSON.stringify([organizationId, userId]))
    .digest('hex')}`;
}
export function profileRef(profile: BrowserProfile): ProfileRef {
  return { key: `profile-${profile.id}`, revision: profile.revision };
}
export function mayUseProfile(profile: BrowserProfile, userId: string): boolean {
  return profile.owner_id === userId || profile.shared;
}
export async function listBrowserProfiles(
  db: SupabaseClient,
  userId: string,
): Promise<BrowserProfile[]> {
  const { data, error } = await db
    .from('browser_profiles')
    .select('*')
    .or(`owner_id.eq.${userId},shared.eq.true`)
    .order('created_at', { ascending: true });
  if (error) throw new Error('No se pudieron leer los perfiles del navegador.');
  return (data ?? []) as BrowserProfile[];
}
export async function getBrowserProfile(
  db: SupabaseClient,
  id: string,
  userId: string,
): Promise<BrowserProfile> {
  const { data, error } = await db.from('browser_profiles').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error('No se pudo leer el perfil.');
  if (!data || !mayUseProfile(data as BrowserProfile, userId))
    throw new Error('El perfil no existe o no tienes acceso.');
  return data as BrowserProfile;
}
export async function defaultBrowserProfile(
  db: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<BrowserProfile> {
  const h = createHash('sha256').update(`default:${organizationId}:${userId}`).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const { error } = await db
    .from('browser_profiles')
    .upsert(
      { id, owner_id: userId, name: 'Mi navegador' },
      { onConflict: 'id', ignoreDuplicates: true },
    );
  if (error) throw new Error('No se pudo preparar tu perfil privado.');
  return getBrowserProfile(db, id, userId);
}

export async function visibleProfileFlows<T extends { profileId?: string | null }>(
  db: SupabaseClient,
  userId: string,
  flows: T[],
): Promise<T[]> {
  if (!flows.some((f) => f.profileId)) return flows;
  const allowed = new Set((await listBrowserProfiles(db, userId)).map((p) => p.id));
  return flows.filter((f) => !f.profileId || allowed.has(f.profileId));
}
