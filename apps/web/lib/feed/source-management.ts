import { z } from 'zod';
import type { SourceHealth } from './health';

export const feedSourceActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('refresh'), id: z.string().uuid() }),
  z.object({ action: z.literal('disable'), id: z.string().uuid() }),
  z.object({ action: z.literal('reconnect'), id: z.string().uuid() }),
  z.object({
    action: z.literal('freshness'),
    id: z.string().uuid(),
    minutes: z.number().int().min(5).max(43200),
  }),
  z.object({ action: z.literal('webhook'), id: z.string().uuid(), enabled: z.boolean() }),
  z.object({
    action: z.literal('version'),
    id: z.string().uuid(),
    attachmentId: z.string().uuid(),
  }),
]);

export type FeedSourceSummary = {
  id: string;
  kind: 'file' | 'text' | 'url' | 'google_sheet' | 'api' | 'combined';
  name: string;
  latestAttachmentId: string | null;
  status: 'ready' | 'refreshing' | 'ok' | 'error' | 'disabled';
  lastCheckedAt: string | null;
  error: string | null;
  enabled: boolean;
  freshnessMinutes: number;
  webhookEnabled: boolean;
  lastWebhookAt: string | null;
  health?: SourceHealth;
};

export function publicFeedSource(row: Record<string, unknown>): FeedSourceSummary {
  return {
    id: String(row.id),
    kind: row.kind as FeedSourceSummary['kind'],
    name: String(row.name),
    latestAttachmentId:
      typeof row.latest_attachment_id === 'string' ? row.latest_attachment_id : null,
    status: row.status as FeedSourceSummary['status'],
    lastCheckedAt: typeof row.last_checked_at === 'string' ? row.last_checked_at : null,
    error: typeof row.error === 'string' ? row.error : null,
    enabled: row.enabled === true,
    freshnessMinutes: typeof row.freshness_minutes === 'number' ? row.freshness_minutes : 1440,
    webhookEnabled: row.webhook_enabled === true,
    lastWebhookAt: typeof row.last_webhook_at === 'string' ? row.last_webhook_at : null,
  };
}
