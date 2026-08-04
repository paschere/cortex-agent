'use client';

import { adminClient, organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  // NEXT_PUBLIC_* is baked in at build time, so a deployment built before the
  // variable was set carries the fallback forever — which sent production
  // sign-ups to http://localhost:3000. In the browser the current origin is
  // always the right answer and needs no rebuild; the env var only matters
  // for any server-side render, and the literal is the last resort.
  baseURL:
    process.env.NEXT_PUBLIC_APP_URL ??
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'),
  plugins: [
    organizationClient(),
    adminClient(),
    twoFactorClient({
      // A signed-in user whose account requires TOTP is bounced to the
      // challenge page instead of silently receiving a partial session.
      onTwoFactorRedirect() {
        window.location.href = '/two-factor';
      },
    }),
  ],
});
