import 'server-only';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './auth';

export const SPANISH_CONSENT_PHRASE =
  'Soy el propietario de esta voz y doy mi consentimiento para que OpenAI la utilice para crear un modelo de voz sintética.';

export interface WorkspaceVoiceProfile {
  id: string;
  name: string;
  language: string;
  active: boolean;
  createdAt: string;
}

interface VoiceRow {
  id: string;
  name: string;
  language: string;
  provider_voice_id: string;
  active: boolean;
  created_at: Date | string;
}

function profile(row: VoiceRow): WorkspaceVoiceProfile {
  return {
    id: row.id,
    name: row.name,
    language: row.language,
    active: row.active,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function canManageWorkspaceVoice(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export async function listWorkspaceVoices(ownerId: string): Promise<WorkspaceVoiceProfile[]> {
  const { rows } = await pool.query<VoiceRow>(
    `select id,name,language,provider_voice_id,active,created_at
       from public.workspace_voice_profiles
      where owner_id=$1
      order by created_at desc`,
    [ownerId],
  );
  return rows.map(profile);
}

/** Server-only provider voice object used by speech/realtime callers. */
export async function readWorkspaceVoice(ownerId: string): Promise<{ id: string } | null> {
  const { rows } = await pool.query<{ provider_voice_id: string }>(
    `select provider_voice_id from public.workspace_voice_profiles
      where owner_id=$1 and active=true limit 1`,
    [ownerId],
  );
  return rows[0] ? { id: rows[0].provider_voice_id } : null;
}

export async function findWorkspaceVoice(
  ownerId: string,
  profileId: string,
): Promise<{ id: string; providerId: string; active: boolean } | null> {
  const { rows } = await pool.query<{ id: string; provider_voice_id: string; active: boolean }>(
    'select id,provider_voice_id,active from public.workspace_voice_profiles where owner_id=$1 and id=$2',
    [ownerId, profileId],
  );
  return rows[0]
    ? { id: rows[0].id, providerId: rows[0].provider_voice_id, active: rows[0].active }
    : null;
}

export async function saveWorkspaceVoice(input: {
  ownerId: string;
  name: string;
  language: string;
  providerVoiceId: string;
  providerConsentId: string;
  createdBy: string;
  consentConfirmedAt: string;
}): Promise<WorkspaceVoiceProfile> {
  const { rows } = await pool.query<VoiceRow>(
    `insert into public.workspace_voice_profiles
       (id,owner_id,name,language,provider_voice_id,provider_consent_id,active,metadata)
     values ($1,$2,$3,$4,$5,$6,false,$7::jsonb)
     returning id,name,language,provider_voice_id,active,created_at`,
    [
      randomUUID(),
      input.ownerId,
      input.name,
      input.language,
      input.providerVoiceId,
      input.providerConsentId,
      JSON.stringify({
        createdBy: input.createdBy,
        consentConfirmedAt: input.consentConfirmedAt,
      }),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('Voice profile was not saved');
  return profile(row);
}

export async function activateWorkspaceVoice(
  ownerId: string,
  profileId: string | null,
): Promise<string | null | undefined> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // One transaction per workspace serializes two tabs activating at once.
    await client.query('select id from public.ba_organization where id=$1 for update', [ownerId]);
    if (profileId) {
      const owned = await client.query<{ id: string }>(
        'select id from public.workspace_voice_profiles where owner_id=$1 and id=$2',
        [ownerId, profileId],
      );
      if (!owned.rows[0]) {
        await client.query('rollback');
        return undefined;
      }
    }
    await client.query(
      'update public.workspace_voice_profiles set active=false,updated_at=now() where owner_id=$1 and active=true',
      [ownerId],
    );
    if (profileId) {
      await client.query(
        'update public.workspace_voice_profiles set active=true,updated_at=now() where owner_id=$1 and id=$2',
        [ownerId, profileId],
      );
    }
    await client.query('commit');
    return profileId;
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function safeRollback(client: PoolClient): Promise<void> {
  await client.query('rollback').catch(() => undefined);
}
