import type { SupabaseClient } from '@supabase/supabase-js';
import { RateLimitError, type UUID } from '@zipdev/core';

export async function consumeToken(
  db: SupabaseClient,
  userId: string,
  toolId: string,
  perMinute: number,
): Promise<void> {
  try {
    const { data, error } = await (db as any).rpc('consume_rate_limit_token', {
      p_user_id: userId,
      p_tool_id: toolId,
      p_per_minute: perMinute,
    })
    if (error) {
      if (error.message?.includes('does not exist')) {
        // RPC not yet deployed — use legacy path silently
        return consumeTokenLegacy(db, userId, toolId, perMinute)
      }
      throw error
    }
    if (data === false) throw new RateLimitError(toolId)
  } catch (err) {
    if (err instanceof RateLimitError) throw err
    // Non-fatal on unexpected errors
  }
}

async function consumeTokenLegacy(
  db: SupabaseClient,
  userId: string,
  toolId: string,
  perMinute: number,
): Promise<void> {
  const now = new Date();
  const { data: existing } = await db
    .from('rate_limit_buckets')
    .select('tokens, refill_at')
    .eq('user_id', userId)
    .eq('tool_id', toolId)
    .maybeSingle();

  let tokens = existing?.tokens ?? perMinute;
  let refillAt = existing?.refill_at
    ? new Date(existing.refill_at as string)
    : new Date(now.getTime() + 60_000);

  if (now >= refillAt) {
    tokens = perMinute;
    refillAt = new Date(now.getTime() + 60_000);
  }
  if (tokens <= 0) throw new RateLimitError(`Rate limit for ${toolId} (${perMinute}/min)`);
  tokens -= 1;

  await db.from('rate_limit_buckets').upsert({
    user_id: userId,
    tool_id: toolId,
    tokens,
    refill_at: refillAt.toISOString(),
  });
}
