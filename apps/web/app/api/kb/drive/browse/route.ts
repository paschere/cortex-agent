import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type ToolContext, createIntegrationsClient } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { DRIVE_READONLY, type DriveContext, type DriveFile, driveListChildren } from '../_lib';

/** Max attempts (1 initial + retries) when Drive returns 403/429. */
const MAX_ATTEMPTS = 4;
/** Base backoff in ms; doubled each attempt with full jitter on top. */
const BASE_BACKOFF_MS = 250;

/** Pull the HTTP status out of a `driveGet` IntegrationError ("Drive 429 ..."). */
function driveStatus(err: unknown): number | null {
  if (err instanceof Error) {
    const m = /Drive (\d{3})\b/.exec(err.message);
    if (m) return Number(m[1]);
  }
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * List one page of a Drive folder's children, retrying on 403/429 with
 * exponential backoff plus full jitter. Other errors (and exhausted retries)
 * propagate to the caller.
 */
async function listWithBackoff(
  ctx: DriveContext,
  parentId: string,
  opts: { q?: string; pageToken?: string },
): Promise<{ files: DriveFile[]; nextPageToken: string | null }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await driveListChildren(ctx, parentId, opts);
    } catch (err) {
      const status = driveStatus(err);
      if ((status !== 403 && status !== 429) || attempt >= MAX_ATTEMPTS - 1) throw err;
      const backoff = BASE_BACKOFF_MS * 2 ** attempt;
      const delay = backoff + Math.floor(Math.random() * backoff);
      logger.warn({ status, attempt, delay }, 'Drive rate-limited; backing off');
      await sleep(delay);
    }
  }
}

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const db = getOrgScopedClient(session.organization.id);
  const integrations = createIntegrationsClient(db, session.id, logger);

  if (!(await integrations.hasScopes('google', [DRIVE_READONLY]))) {
    return NextResponse.json({ connected: false });
  }

  const url = new URL(req.url);
  const parentId = url.searchParams.get('parentId') || 'root';
  const q = url.searchParams.get('q') ?? undefined;
  const pageToken = url.searchParams.get('pageToken') ?? undefined;

  const ctx: DriveContext = { integrations } as ToolContext;

  const { files, nextPageToken } = await listWithBackoff(ctx, parentId, { q, pageToken });

  return NextResponse.json({ connected: true, files, nextPageToken });
}
