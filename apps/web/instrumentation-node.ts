import { browserDocumentSink } from '@/lib/browser-download';
import { setDocumentSink } from '@cortex/agent-tools';
import * as Sentry from '@sentry/nextjs';

/**
 * Where a file fetched by a trámite goes.
 *
 * Registered here, once, because `runFlow` is reached from inside
 * `@cortex/agent-tools` (the agent's two chat tools) as well as from routes,
 * and that package cannot import Supabase Storage or Inngest. See
 * `browser/download.ts` for why this is a registration rather than an argument.
 */
setDocumentSink(browserDocumentSink());

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    enabled: process.env.NODE_ENV === 'production',
  });
}
