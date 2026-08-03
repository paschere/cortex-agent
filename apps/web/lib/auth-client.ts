'use client';

import { createAuthClient } from 'better-auth/react';
import { adminClient, organizationClient, twoFactorClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
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
