import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { getEnv } from '@zipdev/core';

let _service: ReturnType<typeof createClient> | null = null;

export function getSupabaseServiceClient() {
  if (_service) return _service;
  const env = getEnv();
  _service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _service;
}
