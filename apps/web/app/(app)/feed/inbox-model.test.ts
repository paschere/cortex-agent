import type { FeedEntry } from '@/lib/feed/shared';
import { describe, expect, it } from 'vitest';
import {
  NO_FILTERS,
  TABLE_PROMPT,
  classifyPaste,
  countByStatus,
  feedOrigin,
  feedStatus,
  feedType,
  filterEntries,
  formatBytes,
  withPrompt,
} from './inbox-model';

const NOW = new Date('2026-10-02T15:00:00Z');
const ctx = { tableSourceIds: new Set(['s-table']) };

function e(id: string, patch: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id,
    filename: `${id}.pdf`,
    feed_kind: 'file',
    source_url: null,
    created_at: '2026-10-02T14:00:00Z',
    purge_at: '2026-10-09T14:00:00Z',
    byte_size: 2048,
    conversation_id: null,
    promoted_document_id: null,
    feed_truncated: false,
    feed_source_id: null,
    ...patch,
  };
}

describe('inbox model', () => {
  it('derives the status from what already exists, table first', () => {
    expect(feedStatus(e('a'), ctx)).toBe('review');
    expect(feedStatus(e('a', { conversation_id: 'c' }), ctx)).toBe('read');
    expect(feedStatus(e('a', { conversation_id: 'c', promoted_document_id: 'd' }), ctx)).toBe(
      'brain',
    );
    expect(feedStatus(e('a', { promoted_document_id: 'd', feed_source_id: 's-table' }), ctx)).toBe(
      'table',
    );
  });

  it('names the type and the way it arrived', () => {
    const sheet = e('s', {
      feed_kind: 'url',
      source_url: 'https://docs.google.com/spreadsheets/d/x',
    });
    expect([feedType(sheet), feedOrigin(sheet)]).toEqual(['gsheet', 'gsheet']);
    expect(feedType(e('x', { filename: 'ventas.xlsx' }))).toBe('sheet');
    expect(feedType(e('x', { feed_kind: 'api' }))).toBe('api');
  });

  it('shows only the latest capture of a source unless history is asked for', () => {
    const list = [
      e('old', { feed_source_id: 's1', created_at: '2026-09-30T10:00:00Z' }),
      e('new', { feed_source_id: 's1' }),
      e('other'),
    ];
    expect(filterEntries(list, NO_FILTERS, ctx, NOW).map((x) => x.id)).toEqual(['new', 'other']);
    expect(filterEntries(list, { ...NO_FILTERS, history: true }, ctx, NOW)).toHaveLength(3);
    expect(
      filterEntries(list, { ...NO_FILTERS, date: 'today', history: true }, ctx, NOW).map(
        (x) => x.id,
      ),
    ).toEqual(['new', 'other']);
    expect(countByStatus(list, ctx).review).toBe(2);
  });

  it('swaps the prompt of a consult link for the table one', () => {
    const href = withPrompt('/chat/abc?prompt=x&workspace=w', TABLE_PROMPT);
    expect(href.startsWith('/chat/abc?')).toBe(true);
    expect(new URL(href, 'https://x').searchParams.get('prompt')).toBe(TABLE_PROMPT);
    expect(new URL(href, 'https://x').searchParams.get('workspace')).toBe('w');
  });

  it('treats a pasted link as a link and anything else as text', () => {
    expect(classifyPaste(' https://a.co/x ')).toEqual({ kind: 'url', url: 'https://a.co/x' });
    expect(classifyPaste('hola mundo')).toEqual({ kind: 'text', text: 'hola mundo' });
    expect(classifyPaste('  ')).toBeNull();
    expect(formatBytes(1_500_000)).toBe('1,4 MB');
  });
});
