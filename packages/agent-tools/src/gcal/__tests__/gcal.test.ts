import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { gcalListEvents } from '../list-events';
import { gcalCreateEvent } from '../create-event';
import { runTool } from '../../index';
import { ConfirmationRequiredError, IntegrationError } from '@cortex/core';
import type { ToolContext } from '../../types';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const noRow = { data: null, error: null };
  const fromBuilder = {
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
    update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(noRow),
        }),
        maybeSingle: vi.fn().mockResolvedValue(noRow),
      }),
    }),
  };
  const db = { from: vi.fn().mockReturnValue(fromBuilder) };
  const integrations = {
    getAccessToken: vi.fn().mockResolvedValue({ token: 'test-token', scopes: [] }),
    hasScopes: vi.fn().mockResolvedValue(true),
  };
  const logger = {
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(),
  };
  return {
    organizationId: 'org-test',
    userId: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    conversationId: '00000000-0000-0000-0000-000000000003',
    db: db as unknown as ToolContext['db'],
    integrations: integrations as unknown as ToolContext['integrations'],
    logger: logger as unknown as ToolContext['logger'],
    ...overrides,
  };
}

const server = setupServer(
  http.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', () =>
    HttpResponse.json({
      items: [
        {
          id: 'e1',
          summary: 'Sync',
          start: { dateTime: '2026-06-01T10:00:00Z' },
          end: { dateTime: '2026-06-01T11:00:00Z' },
          attendees: [{ email: 'a@b.com' }],
          htmlLink: 'https://calendar.google.com/event/abc',
        },
      ],
    }),
  ),
  http.post('https://www.googleapis.com/calendar/v3/calendars/primary/events', () =>
    HttpResponse.json({ id: 'e2', summary: 'Test Event', htmlLink: 'https://calendar.google.com/event/new' }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

describe('gcal', () => {
  it('lists events', async () => {
    const ctx = makeCtx();
    const out = await gcalListEvents.handler(
      { calendarId: 'primary', timeMin: '2026-06-01T00:00:00Z', timeMax: '2026-06-30T00:00:00Z', maxResults: 5 },
      ctx,
    );
    expect(out.events).toHaveLength(1);
    expect(out.events[0]?.attendees).toEqual(['a@b.com']);
    expect(out.events[0]?.summary).toBe('Sync');
  });

  it('create_event throws ConfirmationRequiredError without confirmed flag', async () => {
    const ctx = makeCtx();
    await expect(
      runTool(
        gcalCreateEvent,
        { calendarId: 'primary', summary: 'Test Event', start: '2026-06-01T10:00:00Z', end: '2026-06-01T11:00:00Z' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });

  it('create_event runs with confirmed: true', async () => {
    const ctx = makeCtx();
    const out = await runTool(
      gcalCreateEvent,
      { calendarId: 'primary', summary: 'Test Event', start: '2026-06-01T10:00:00Z', end: '2026-06-01T11:00:00Z' },
      ctx,
      { confirmed: true },
    );
    expect((out as { event: { id: string } }).event.id).toBe('e2');
  });

  it('network error throws IntegrationError', async () => {
    server.use(
      http.get(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        () => HttpResponse.json({ error: 'unauthorized' }, { status: 401 }),
        { once: true },
      ),
    );
    const ctx = makeCtx();
    await expect(
      gcalListEvents.handler(
        { calendarId: 'primary', timeMin: '2026-06-01T00:00:00Z', timeMax: '2026-06-30T00:00:00Z', maxResults: 5 },
        ctx,
      ),
    ).rejects.toBeInstanceOf(IntegrationError);
  });
});
