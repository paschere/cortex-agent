import type { SupabaseClient } from '@supabase/supabase-js';
import { RateLimitError, type UUID } from '@zipdev/core';

export async function consumeToken(
  db: SupabaseClient,
  userId: UUID,
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
