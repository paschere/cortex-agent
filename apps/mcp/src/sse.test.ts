/**
 * Smoke tests for the Workers SSE transport.
 *
 * These tests exercise the protocol-level behaviour of handleSseGet / handleSsePost
 * without starting a real Worker or connecting to Supabase.
 */

import { describe, expect, it, vi } from 'vitest';
import { handleSseGet, handleSsePost } from './sse';

// Minimal MCP Server stub — just enough for transport.connect() to work.
function makeServerStub() {
  return {
    async connect(transport: {
      start(): Promise<void>;
      onmessage?: unknown;
      onerror?: unknown;
      onclose?: unknown;
    }) {
      await transport.start();
    },
  } as Parameters<typeof handleSseGet>[0] extends () => infer S ? S : never;
}

// Read the first SSE event from the stream, returning a reader so the stream stays open.
async function readFirstEvent(
  response: Response,
): Promise<{ event: string; data: string; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // A complete SSE event ends with \n\n
    if (buffer.includes('\n\n')) break;
  }

  // Do NOT cancel the reader — cancelling triggers the stream's cancel() callback
  // which removes the session from the session map before we can POST to it.
  const lines = buffer.replace(/\n\n$/, '').split('\n');
  const eventLine = lines.find((l) => l.startsWith('event:')) ?? '';
  const dataLine = lines.find((l) => l.startsWith('data:')) ?? '';
  return {
    event: eventLine.slice('event:'.length).trim(),
    data: dataLine.slice('data:'.length).trim(),
    reader,
  };
}

describe('handleSseGet', () => {
  it('returns a text/event-stream response', () => {
    const res = handleSseGet(() => makeServerStub(), 'https://mcp.example.com/sse/messages');
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.body).not.toBeNull();
  });

  it('sends an `endpoint` event with a sessionId URL', async () => {
    const messagesUrl = 'https://mcp.example.com/sse/messages';
    const res = handleSseGet(() => makeServerStub(), messagesUrl);
    const first = await readFirstEvent(res);
    expect(first.event).toBe('endpoint');
    expect(first.data).toMatch(/^https:\/\/mcp\.example\.com\/sse\/messages\?sessionId=[\w-]+$/);
  });
});

describe('handleSsePost', () => {
  it('returns 400 when sessionId is missing', async () => {
    const res = await handleSsePost(
      new Request('https://mcp.example.com/sse/messages', { method: 'POST', body: '{}' }),
      new URL('https://mcp.example.com/sse/messages'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when session does not exist', async () => {
    const res = await handleSsePost(
      new Request('https://mcp.example.com/sse/messages?sessionId=nonexistent', {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      }),
      new URL('https://mcp.example.com/sse/messages?sessionId=nonexistent'),
    );
    expect(res.status).toBe(404);
  });

  it('returns 202 and routes the message to the session after GET /sse', async () => {
    const received: unknown[] = [];

    const serverStub = {
      async connect(transport: {
        start(): Promise<void>;
        onmessage?: (msg: unknown) => void;
        onerror?: unknown;
        onclose?: unknown;
      }) {
        await transport.start();
        // Capture messages the transport injects
        transport.onmessage = (msg) => received.push(msg);
      },
    } as Parameters<typeof handleSseGet>[0] extends () => infer S ? S : never;

    const messagesUrl = 'https://mcp.example.com/sse/messages';
    const sseRes = handleSseGet(() => serverStub, messagesUrl);

    // Read the endpoint event to get the sessionId
    const first = await readFirstEvent(sseRes);
    expect(first.event).toBe('endpoint');

    const sessionUrl = first.data;
    const sessionId = new URL(sessionUrl).searchParams.get('sessionId')!;
    expect(sessionId).toBeTruthy();

    const body = JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 });
    const postRes = await handleSsePost(
      new Request(`${messagesUrl}?sessionId=${sessionId}`, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' },
      }),
      new URL(`${messagesUrl}?sessionId=${sessionId}`),
    );

    expect(postRes.status).toBe(202);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ jsonrpc: '2.0', method: 'ping', id: 1 });
  });
});
