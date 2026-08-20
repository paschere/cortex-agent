import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  experimental: { serverActions: { bodySizeLimit: '12mb' } },
  transpilePackages: ['@cortex/core', '@cortex/agent-tools', '@cortex/agents'],
  // 'ws' se deja fuera del bundle: trae binarios opcionales (bufferutil,
  // utf-8-validate) que webpack no debe empaquetar. Lo usa el modo voz para el
  // WebSocket de TTS de Deepgram (app/api/voice/turn).
  serverExternalPackages: ['inngest', 'ws'],
  webpack(webpackConfig) {
    // Allow webpack to resolve .js imports as .ts for ESM workspace packages
    webpackConfig.resolve = webpackConfig.resolve ?? {};
    webpackConfig.resolve.extensionAlias = {
      ...(webpackConfig.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return webpackConfig;
  },
  async rewrites() {
    // Canonical MCP connector URL is /mcp (matches the RFC 9728 resource id and
    // the path-based protected-resource metadata). The handler lives at /api/mcp.
    return [{ source: '/mcp', destination: '/api/mcp' }];
  },
  async redirects() {
    return [
      {
        // WhatsApp moved out of Brain Knowledge and into Integrations: it is a
        // connection somebody pairs, not a document. The old address was live
        // and shareable, so it keeps working — permanently, because the screen
        // is never coming back to /kb.
        source: '/kb/whatsapp',
        destination: '/integrations/whatsapp',
        permanent: true,
      },
    ];
  },
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
