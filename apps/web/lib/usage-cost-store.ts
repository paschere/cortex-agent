import 'server-only';
import { DEFAULT_USD_COP, type UsageRow } from '@/lib/usage-cost';
import { isCompanyManager } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/** La lectura de `model_usage` (0228). Cada consulta revisa su `error`. */

const COLUMNS =
  'user_id, conversation_id, task_id, surface, source, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, occurred_at';

interface Raw {
  user_id: string | null;
  conversation_id: string | null;
  task_id: string | null;
  surface: string;
  source: string;
  model: string;
  input_tokens: number | string;
  cache_read_tokens: number | string;
  cache_write_tokens: number | string;
  output_tokens: number | string;
  occurred_at: string;
}

function adapt(r: Raw): UsageRow {
  return {
    userId: r.user_id,
    conversationId: r.conversation_id,
    taskId: r.task_id,
    surface: r.surface,
    source: r.source,
    model: r.model,
    input: Number(r.input_tokens) || 0,
    cacheRead: Number(r.cache_read_tokens) || 0,
    cacheWrite: Number(r.cache_write_tokens) || 0,
    output: Number(r.output_tokens) || 0,
    at: r.occurred_at,
  };
}

export const USAGE_READ_CAP = 20_000;

export async function loadUsageRows(
  db: SupabaseClient,
  opts: { since?: string; conversationId?: string; taskId?: string; userId?: string },
): Promise<{ rows: UsageRow[]; truncated: boolean }> {
  let q = db.from('model_usage').select(COLUMNS);
  if (opts.since) q = q.gte('occurred_at', opts.since);
  if (opts.conversationId) q = q.eq('conversation_id', opts.conversationId);
  if (opts.taskId) q = q.eq('task_id', opts.taskId);
  if (opts.userId) q = q.eq('user_id', opts.userId);
  const { data, error } = await q
    .order('occurred_at', { ascending: false })
    .limit(USAGE_READ_CAP + 1);
  if (error) throw error;
  const all = ((data ?? []) as Raw[]).map(adapt);
  return { rows: all.slice(0, USAGE_READ_CAP), truncated: all.length > USAGE_READ_CAP };
}

/** La tasa USD→COP de la empresa, o la que trae el código. */
export async function loadUsdCopRate(
  db: SupabaseClient,
): Promise<{ rate: number; custom: boolean }> {
  const { data, error } = await db.from('ledger_settings').select('usd_cop_rate').maybeSingle();
  if (error) return { rate: DEFAULT_USD_COP, custom: false };
  const v = Number((data as { usd_cop_rate?: number | string | null } | null)?.usd_cop_rate);
  return Number.isFinite(v) && v > 0
    ? { rate: v, custom: true }
    : { rate: DEFAULT_USD_COP, custom: false };
}

export async function saveUsdCopRate(
  db: SupabaseClient,
  rate: number,
  userId: string,
): Promise<void> {
  if (!(await isCompanyManager(db, userId)))
    throw new Error('Sólo quien administra la empresa fija la tasa del dólar.');
  const { error } = await db
    .from('ledger_settings')
    .upsert(
      { usd_cop_rate: rate, updated_by: userId, updated_at: new Date().toISOString() },
      { onConflict: 'organization_id' },
    );
  if (error) throw error;
}
