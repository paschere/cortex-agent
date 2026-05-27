import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  experimental: { serverActions: { bodySizeLimit: '12mb' } },
  transpilePackages: ['@zipdev/core', '@zipdev/agent-tools', '@zipdev/agents'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default process.env.SENTRY_DSN
  ? withSentryConfig(config, { silent: true })
  : config;
