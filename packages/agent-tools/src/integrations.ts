import {
  IntegrationError,
  type IntegrationProvider,
  type Logger,
  type UUID,
  decryptToken,
  encryptToken,
} from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { microsoftTokenUrl, normalizeGraphScopes } from './msgraph/client';
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
  /**
   * Microsoft 365 (Graph), delegated. Two things differ from the two above.
   *
   * REFRESH TOKENS ROTATE. Entra ID returns a NEW refresh token on every
   * exchange and retires the one just used, so the response's `refresh_token`
   * must be persisted — which the caller below already does, because HubSpot
   * behaves the same way. A deployment that kept the original would work for
   * exactly one refresh and then look like a revocation.
   *
   * A FAILURE HERE IS USUALLY PERMANENT. Microsoft answers 400 with
   * `invalid_grant` for every end of the grant: the user changed their
   * password, an administrator revoked the app or the user's sessions, the
   * 90-day inactivity window lapsed, or a conditional-access policy now demands
   * a fresh sign-in. None of those get better by retrying, and "Microsoft
   * refresh failed: 400" would send a person to a log they cannot read. So the
   * message says the one thing that fixes it.
   */
  async microsoft(rt) {
    const r = await fetch(microsoftTokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID ?? '',
        client_secret: process.env.MICROSOFT_CLIENT_SECRET ?? '',
        refresh_token: rt,
        grant_type: 'refresh_token',
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      // Never log or echo the body wholesale: the error payload from Entra ID
      // carries correlation ids and, on some flows, the request that was sent.
      const revoked = r.status === 400 || r.status === 401 || /invalid_grant/i.test(body);
      throw new IntegrationError(
        revoked
          ? 'Your Microsoft 365 connection is no longer valid — Microsoft rejected the stored refresh token. That happens when the password changed, an administrator revoked the app, or nobody used the connection for 90 days. Reconnect Microsoft 365 from the Integrations screen; retrying will not help.'
          : `Microsoft could not refresh the connection right now (${r.status}). Nothing is broken on our side — try again in a few minutes, and reconnect from the Integrations screen if it keeps failing.`,
        'microsoft',
      );
    }
    const tok = (await r.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };
    return {
      ...tok,
      // Entra ID hands scopes back resource-qualified
      // ("https://graph.microsoft.com/Mail.Read"). Normalising on the way in
      // keeps the column in one spelling, so `hasScopes` compares like with
      // like and a refresh never silently narrows what a tool is allowed to do.
      scope: tok.scope ? normalizeGraphScopes(tok.scope).join(' ') : undefined,
    };
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
