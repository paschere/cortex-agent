import 'server-only';
import { DEFAULT_USD_COP, type UsageRow } from '@/lib/usage-cost';
import { isCompanyManager } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/** La lectura de `model_usage` (0228). Cada consulta revisa su `error`. */

const BASE_COLUMNS =
  'user_id, conversation_id, task_id, surface, source, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, occurred_at';
// `steps` y `message_id` existen desde 0228; lo del experimento, desde 0236.
const COLUMNS = `${BASE_COLUMNS}, steps, message_id`;
const EXPERIMENT_COLUMNS = `${COLUMNS}, experiment_arm, tool_errors, retries, refusals, fell_back`;

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
  steps?: number | string | null;
  message_id?: string | null;
  experiment_arm?: string | null;
  tool_errors?: number | string | null;
  retries?: number | string | null;
  refusals?: number | string | null;
  fell_back?: boolean | null;
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
    steps: Math.max(Number(r.steps) || 1, 1),
    messageId: r.message_id ?? null,
    arm: r.experiment_arm === 'haiku' || r.experiment_arm === 'sonnet' ? r.experiment_arm : null,
    toolErrors: Number(r.tool_errors) || 0,
    retries: Number(r.retries) || 0,
    refusals: Number(r.refusals) || 0,
    fellBack: r.fell_back === true,
  };
}

export const USAGE_READ_CAP = 20_000;

export async function loadUsageRows(
  db: SupabaseClient,
  opts: { since?: string; conversationId?: string; taskId?: string; userId?: string },
): Promise<{ rows: UsageRow[]; truncated: boolean }> {
  const query = (columns: string) => {
    let q = db.from('model_usage').select(columns);
    if (opts.since) q = q.gte('occurred_at', opts.since);
    if (opts.conversationId) q = q.eq('conversation_id', opts.conversationId);
    if (opts.taskId) q = q.eq('task_id', opts.taskId);
    if (opts.userId) q = q.eq('user_id', opts.userId);
    return q.order('occurred_at', { ascending: false }).limit(USAGE_READ_CAP + 1);
  };
  let res = await query(EXPERIMENT_COLUMNS);
  // Sin la 0236 las columnas del experimento no existen: se lee lo de siempre.
  if (res.error) res = await query(COLUMNS);
  if (res.error) throw res.error;
  const all = ((res.data ?? []) as unknown as Raw[]).map(adapt);
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
