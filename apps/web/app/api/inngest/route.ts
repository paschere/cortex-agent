import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest';
import { functions } from '@/inngest/functions';

const handlers = serve({ client: inngest, functions });

// Without a signing key the serve handler would accept unauthenticated
// invocations (dev mode). Refuse to expose the endpoint until Inngest Cloud
// is provisioned (INNGEST_SIGNING_KEY set).
function guarded<A extends unknown[]>(handler: (...args: A) => Promise<Response> | Response) {
  return (...args: A): Promise<Response> | Response => {
    if (!process.env.INNGEST_SIGNING_KEY) {
      return new Response('Inngest is not configured', { status: 404 });
    }
    return handler(...args);
  };
}

export const GET = guarded(handlers.GET);
export const POST = guarded(handlers.POST);
export const PUT = guarded(handlers.PUT);
