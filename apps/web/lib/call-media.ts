import { mintBlobToken } from '@/lib/blob-token';
import {
  type CallEvent,
  LIVE_CALLS_BUCKET,
  normalizeTimeline,
} from '@cortex/agent-tools';

export interface VisibleEvent extends CallEvent {
  url: string | null;
}

export function decorateTimeline(raw: unknown, ttlMs = 6 * 60 * 60 * 1000): VisibleEvent[] {
  const expiresAt = Date.now() + ttlMs;
  return normalizeTimeline(raw).map((event) => {
    if (!event.path) return { ...event, url: null };
    try {
      const token = mintBlobToken({
        bucket: LIVE_CALLS_BUCKET,
        path: event.path,
        expiresAt,
      });
      return { ...event, url: `/api/files/blob/${token}` };
    } catch {
      return { ...event, url: null };
    }
  });
}

export function recordingUrl(
  path: string | null | undefined,
  ttlMs = 6 * 60 * 60 * 1000,
): string | null {
  if (!path) return null;
  try {
    const token = mintBlobToken({
      bucket: LIVE_CALLS_BUCKET,
      path,
      expiresAt: Date.now() + ttlMs,
    });
    return `/api/files/blob/${token}`;
  } catch {
    return null;
  }
}
