import { decryptToken, encryptToken } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Third-party logins, encrypted the way the OAuth tokens already are.
 *
 * Same primitive as `integrations.ts`: AES-256-GCM under `TOKEN_ENCRYPTION_KEY`
 * via `packages/core/src/crypto.ts`. Not a second scheme, not a second key --
 * one key with one rotation story is the whole point, and a module that
 * invents its own crypto is a module whose crypto nobody reviews.
 *
 * THE SHAPE OF THIS FILE IS THE SECURITY PROPERTY. There is exactly one
 * function that reads `secret_encrypted` -- `unlockForRun` -- and it returns a
 * plain object that the caller hands straight to the browser service. Every
 * other function in here selects an explicit column list that does not include
 * it. So "could a credential reach an API response" is not a question about
 * discipline at forty call sites; it is a question about the four functions
 * below, and the answer is visible in each one's select.
 */

export interface CredentialSummary {
  id: string;
  label: string;
  host: string;
  fieldNames: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

/** Columns that are safe to render, return over an API, or put in a log. */
const SAFE_COLUMNS = 'id, label, host, field_names, created_at, last_used_at';

function toSummary(row: Record<string, unknown>): CredentialSummary {
  return {
    id: row.id as string,
    label: row.label as string,
    host: row.host as string,
    fieldNames: (row.field_names as string[]) ?? [],
    createdAt: row.created_at as string,
    lastUsedAt: (row.last_used_at as string | null) ?? null,
  };
}

/** Normalise a URL down to the origin a credential belongs to. */
export function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return '';
  }
}

export async function listCredentials(db: SupabaseClient): Promise<CredentialSummary[]> {
  const { data } = await db
    .from('browser_credentials')
    .select(SAFE_COLUMNS)
    .order('label', { ascending: true });
  return ((data as Record<string, unknown>[]) ?? []).map(toSummary);
}

export async function createCredential(
  db: SupabaseClient,
  input: { label: string; host: string; fields: Record<string, string>; createdBy: string },
): Promise<CredentialSummary> {
  const host = originOf(input.host) || input.host;
  const { data, error } = await db
    .from('browser_credentials')
    .insert({
      label: input.label,
      host,
      // The names travel in the clear because the teaching screen has to offer
      // them when binding a step, and a field name is not a secret. The values
      // go into one encrypted blob so that adding a field later does not mean
      // a schema change.
      field_names: Object.keys(input.fields),
      secret_encrypted: encryptToken(JSON.stringify(input.fields)),
      created_by: input.createdBy,
    })
    .select(SAFE_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toSummary(data as Record<string, unknown>);
}

/** Replace the values, keeping the id so bound flows keep working. */
export async function rotateCredential(
  db: SupabaseClient,
  id: string,
  fields: Record<string, string>,
): Promise<void> {
  const { error } = await db
    .from('browser_credentials')
    .update({
      field_names: Object.keys(fields),
      secret_encrypted: encryptToken(JSON.stringify(fields)),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteCredential(db: SupabaseClient, id: string): Promise<void> {
  await db.from('browser_credentials').delete().eq('id', id);
}

/**
 * The ONLY read of the secret, and the only place it exists as text inside
 * Cortex.
 *
 * The caller is `execute.ts`, which passes the returned object into the
 * browser-service request body and lets it go out of scope. It is never
 * returned to a route, never put on a run row, never rendered and never given
 * to a model.
 *
 * The host check is not paranoia about our own code, it is about the row: a
 * flow's `start_url` is editable on screen, and without this check somebody
 * could point a flow that carries the DIAN login at a site they control and
 * have Cortex type the password into it. The credential names the origin it is
 * for, and it only ever unlocks for that origin.
 */
export async function unlockForRun(
  db: SupabaseClient,
  credentialId: string,
  expectedHost: string,
): Promise<Record<string, string>> {
  const { data } = await db
    .from('browser_credentials')
    .select('id, host, secret_encrypted')
    .eq('id', credentialId)
    .maybeSingle();
  if (!data) throw new Error('Esa credencial ya no existe.');

  const row = data as Record<string, unknown>;
  if ((row.host as string).toLowerCase() !== expectedHost.toLowerCase()) {
    throw new Error(
      'La credencial guardada es de otro sitio que el que abre este trámite. No la voy a usar.',
    );
  }

  const fields = JSON.parse(decryptToken(row.secret_encrypted as string)) as Record<string, string>;
  await db
    .from('browser_credentials')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', credentialId);
  return fields;
}
