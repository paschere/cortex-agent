/**
 * Cloudflare Workers-compatible SSE transport for the MCP protocol.
 *
 * MCP SSE protocol:
 *   GET  /sse               — open SSE stream; server sends `endpoint` event with POST URL
 *   POST /sse/messages      — client sends JSON-RPC requests; responses come back via SSE stream
 *
 * The SDK's SSEServerTransport relies on Node http streams and can't run in Workers.
 * We implement the Transport interface directly using the Web Streams API.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

interface SSESession {
  transport: WorkersSSETransport;
  server: Server;
}

// Module-scoped session map. Valid within a single Worker isolate.
const sessions = new Map<string, SSESession>();

const encoder = new TextEncoder();

function sseEvent(event: string, data: string): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${data}\n\n`);
}

class WorkersSSETransport implements Transport {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  setController(ctrl: ReadableStreamDefaultController<Uint8Array>) {
    this.controller = ctrl;
  }

  async start(): Promise<void> {
    // Controller is injected before start(); nothing to do here.
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.controller) throw new Error('SSE transport not connected');
    this.controller.enqueue(sseEvent('message', JSON.stringify(message)));
  }

  async close(): Promise<void> {
    try {
      this.controller?.close();
    } catch {
      // Already closed — ignore.
    }
    this.controller = null;
    this.onclose?.();
  }

  /** Feed an inbound JSON-RPC message from the POST handler into the server. */
  receive(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }

  /** Propagate a transport-level error into the server. */
  error(err: Error): void {
    this.onerror?.(err);
  }
}

/**
 * Handle GET /sse — opens the SSE stream and returns a streaming Response.
 *
 * @param buildServer Factory that creates a new MCP Server bound to the caller's context.
 * @param messagesUrl  Full URL for the POST /sse/messages endpoint (sent as the `endpoint` event).
 */
export function handleSseGet(buildServer: () => Server, messagesUrl: string): Response {
  const sessionId = crypto.randomUUID();
  const transport = new WorkersSSETransport();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      transport.setController(controller);
      sessions.set(sessionId, { transport, server: buildServer() });

      // Announce the POST endpoint to the client.
      controller.enqueue(sseEvent('endpoint', `${messagesUrl}?sessionId=${sessionId}`));

      // Attach the transport to the MCP server (sets onmessage/onerror/onclose, calls start()).
      sessions.get(sessionId)!.server.connect(transport).catch((err: Error) => {
        transport.error(err);
      });
    },
    cancel() {
      sessions.delete(sessionId);
      transport.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * Handle POST /sse/messages — receives a JSON-RPC message and feeds it to the session transport.
 * The MCP server processes it and sends the response back via the SSE stream.
 */
export async function handleSsePost(request: Request, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return new Response('Missing sessionId', { status: 400 });

  const session = sessions.get(sessionId);
  if (!session) return new Response('Session not found or expired', { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  try {
    session.transport.receive(body as JSONRPCMessage);
    return new Response(null, { status: 202 });
  } catch (err) {
    return new Response((err as Error).message, { status: 500 });
  }
}
