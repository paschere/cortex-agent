'use server';

import { createHash, randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';

export async function issueToken(formData: FormData) {
  const user = await requireSession();
  const name = (formData.get('name') as string | null)?.trim();
  const agentId = (formData.get('agentId') as string | null) || null;

  if (!name || name.length === 0 || name.length > 60) {
    throw new Error('El nombre del token debe tener entre 1 y 60 caracteres.');
  }

  // Generate plaintext: zda_ + 32 base64url chars (randomBytes(24) → 32 base64url chars)
  const raw = `zda_${randomBytes(24).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 12); // "zda_" + 8 random chars

  const sb = getSupabaseServiceClient();
  const { error } = await sb.from('mcp_tokens').insert({
    user_id: user.id,
    agent_id: agentId,
    name,
    token_hash: tokenHash,
    prefix,
  });

  if (error) {
    throw new Error(`No se pudo crear el token: ${error.message}`);
  }

  revalidatePath('/mcp-tokens');
  redirect(`/mcp-tokens?just_issued=${encodeURIComponent(raw)}`);
}

export async function revokeToken(formData: FormData) {
  const user = await requireSession();
  const tokenId = (formData.get('tokenId') as string | null)?.trim();

  if (!tokenId) {
    throw new Error('Falta el identificador del token.');
  }

  const sb = getSupabaseServiceClient();
  const { error } = await sb
    .from('mcp_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', tokenId)
    .eq('user_id', user.id); // security: only revoke own tokens

  if (error) {
    throw new Error(`No se pudo revocar el token: ${error.message}`);
  }

  revalidatePath('/mcp-tokens');
}
