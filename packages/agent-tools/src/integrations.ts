import {
  IntegrationError,
  type IntegrationProvider,
  type Logger,
  type UUID,
  decryptToken,
  encryptToken,
} from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { IntegrationsClient } from './types';

type RefreshFn = (refreshToken: string) => Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}>;

// github/linear are absent: their tokens are long-lived (null expires_at), so the
// refresh path in getAccessToken is never reached for them.
const REFRESHERS: Partial<Record<IntegrationProvider, RefreshFn>> = {
  async google(rt) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        refresh_token: rt,
        grant_type: 'refresh_token',
      }),
    });
    if (!r.ok) throw new IntegrationError(`Google refresh failed: ${r.status}`, 'google');
    return r.json() as Promise<{ access_token: string; expires_in: number; scope: string }>;
  },
  async hubspot(rt) {
    const r = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.HUBSPOT_CLIENT_ID ?? '',
        client_secret: process.env.HUBSPOT_CLIENT_SECRET ?? '',
        refresh_token: rt,
      }),
    });
    if (!r.ok) throw new IntegrationError(`HubSpot refresh failed: ${r.status}`, 'hubspot');
    return r.json() as Promise<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
    }>;
  },
};

/**
 * HubSpot "service account": a Private App token (pat-...) shared by the whole
 * workspace. When HUBSPOT_PRIVATE_APP_TOKEN is set, every user transparently
 * uses it — no per-user OAuth connect flow, no refresh. Scope enforcement
 * happens in HubSpot (the private app's configured scopes); requiredScopes
 * checks pass because the token is portal-wide. Per-user attribution is
 * preserved in our own audit_events.
 */
function privateAppToken(provider: IntegrationProvider): string | null {
  if (provider === 'hubspot') return process.env.HUBSPOT_PRIVATE_APP_TOKEN ?? null;
  return null;
}

export function createIntegrationsClient(
  db: SupabaseClient,
  userId: UUID,
  logger: Logger,
): IntegrationsClient {
  return {
    async getAccessToken(provider) {
      const serviceToken = privateAppToken(provider);
      if (serviceToken) return { token: serviceToken, scopes: ['*'] };
      const { data, error } = await db
        .from('integrations')
        .select('id, access_token_enc, refresh_token_enc, scopes, expires_at')
        .eq('user_id', userId)
        .eq('provider', provider)
        .maybeSingle();
      if (error || !data)
        throw new IntegrationError(`No ${provider} integration for user`, provider);

      const expired = data.expires_at
        ? new Date(data.expires_at as string).getTime() - 60_000 < Date.now()
        : false;
      if (!expired) {
        return {
          token: decryptToken(data.access_token_enc as string),
          scopes: data.scopes as string[],
        };
      }
      if (!data.refresh_token_enc)
        throw new IntegrationError(`No refresh token for ${provider}`, provider);
      const refresher = REFRESHERS[provider];
      if (!refresher) throw new IntegrationError(`No refresher for ${provider}`, provider);
      const refreshed = await refresher(decryptToken(data.refresh_token_enc as string));
      const newScopes = refreshed.scope ? refreshed.scope.split(' ') : (data.scopes as string[]);
      const newRefresh = refreshed.refresh_token ?? decryptToken(data.refresh_token_enc as string);
      await db
        .from('integrations')
        .update({
          access_token_enc: encryptToken(refreshed.access_token),
          refresh_token_enc: encryptToken(newRefresh),
          scopes: newScopes,
          expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', data.id as string);
      logger.info({ provider, userId }, 'refreshed integration token');
      return { token: refreshed.access_token, scopes: newScopes };
    },
    async hasScopes(provider, scopes) {
      if (privateAppToken(provider)) return true;
      const { data } = await db
        .from('integrations')
        .select('scopes')
        .eq('user_id', userId)
        .eq('provider', provider)
        .maybeSingle();
      if (!data) return false;
      const have = new Set(data.scopes as string[]);
      return scopes.every((s) => have.has(s));
    },
  };
}
