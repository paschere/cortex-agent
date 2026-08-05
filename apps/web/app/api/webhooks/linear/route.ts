import { claimDelivery, supabaseDeliveryLedger } from '@/lib/dev-tasks/claim';
import { type DevTaskIntakeEvent, EVENT_TASK_INTAKE } from '@/lib/dev-tasks/contract';
import { inngest } from '@/lib/inngest';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import {
  type LinearWebhookBody,
  evaluateTrigger,
  linearEventKey,
  parseRepoDirective,
  parseRepoLabel,
  triggerConfigFromEnv,
} from './trigger';
import { verifyLinearRequest } from './verify';

/**
 * Linear → Cortex: how an issue becomes a queued unit of development work.
 *
 * Linear POSTs every issue change here. This endpoint decides, in a few
 * milliseconds, whether the change is "a human handed Cortex this ticket" — and
 * if so, claims the delivery and hands it to the queue. It does NOT resolve
 * repositories, create task rows, comment on Linear, or clone anything: all of
 * that happens in `dev-task-intake` (apps/web/inngest/functions), because a
 * webhook that does real work is a webhook that times out and gets retried,
 * which is precisely how you end up with two agents on one branch.
 *
 * The order of operations is load-bearing:
 *
 *   1. VERIFY the HMAC signature over the raw bytes. Nothing unsigned is
 *      parsed. (./verify.ts)
 *   2. REJECT REPLAYS using the signed `webhookTimestamp`.
 *   3. FILTER. Almost every delivery is noise and is answered 200 with no
 *      trace — writing a row for each would bury the ledger. (./trigger.ts)
 *   4. CLAIM. Insert into `dev_task_events`, whose unique constraint is what
 *      makes a Linear retry a no-op. (@/lib/dev-tasks/claim)
 *   5. ENQUEUE and return 202. If the enqueue fails the claim is released, so
 *      Linear's retry can succeed rather than being swallowed as a duplicate.
 *
 * Configuration lives in env (see docs/operations/cortex-dev-tasks.md):
 * LINEAR_WEBHOOK_SECRET, LINEAR_TRIGGER_MODE, LINEAR_CORTEX_USER_ID,
 * LINEAR_CORTEX_USER_EMAIL, LINEAR_TRIGGER_LABEL.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Linear's description field is unbounded; the queue payload should not be. */
const MAX_DESCRIPTION_CHARS = 20_000;

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}\n… (truncated)` : value;
}

/** A `Repo:` line beats a `repo:` label; see @/lib/dev-tasks/repository. */
function repoHintOf(
  data: NonNullable<LinearWebhookBody['data']>,
): { key: string; from: 'description' | 'label' } | null {
  const fromDescription = parseRepoDirective(data.description);
  if (fromDescription) return { key: fromDescription, from: 'description' };
  const fromLabel = parseRepoLabel(data);
  return fromLabel ? { key: fromLabel, from: 'label' } : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // The RAW text, not req.json(): the signature covers these exact bytes.
  const raw = await req.text();

  const verified = verifyLinearRequest({
    rawBody: raw,
    signature: req.headers.get('linear-signature'),
  });
  if (!verified.ok) {
    // The reason goes in the message, not a context object — the platform log
    // drain only carries `msg`. It names no secret: it is our own verdict.
    logger.warn(`linear-webhook: rejected a delivery — ${verified.reason}`);
    const status = verified.reason === 'invalid-json' ? 400 : 401;
    return NextResponse.json({ error: verified.reason }, { status });
  }

  const body = verified.body as LinearWebhookBody;
  const config = triggerConfigFromEnv();
  const decision = evaluateTrigger(body, config);
  if (!decision.accepted) {
    // 200, not 4xx: this is a delivery we were right to receive and right to
    // do nothing with. A non-2xx would make Linear retry it forever.
    return NextResponse.json({ ignored: decision.reason }, { status: 200 });
  }

  const data = body.data ?? {};
  const issueId = data.id as string;

  // Unscoped by design: `dev_task_events` (migration 0064 § 12) is written here
  // with organization_id left null on purpose. A Linear delivery carries no
  // session and no workspace — the issue's repository is what determines whose
  // work this is, and that match (and the resulting scoped dev_tasks row) only
  // happens downstream in inngest/functions/dev-task-intake.ts, which rejects
  // and asks rather than guessing when no repository matches.
  const ledger = supabaseDeliveryLedger(getSupabaseServiceClient());
  let deliveryId: string;
  try {
    const claim = await claimDelivery(ledger, {
      source: 'linear',
      eventKey: linearEventKey(raw),
      externalId: issueId,
      action: body.action ?? null,
    });
    if (!claim.claimed) {
      logger.info(`linear-webhook: duplicate delivery for issue ${data.identifier ?? issueId}`);
      return NextResponse.json({ duplicate: true }, { status: 200 });
    }
    deliveryId = claim.deliveryId;
  } catch (err) {
    logger.error('linear-webhook: could not claim the delivery', {
      error: (err as Error).message,
    });
    // 500 so Linear retries — we do not know whether anything happened.
    return NextResponse.json({ error: 'claim failed' }, { status: 500 });
  }

  // The actor (who assigned/labelled) is the person waiting on this; the
  // creator is the fallback when Linear omits the actor.
  const requesterSource = body.actor ?? data.creator ?? null;

  const payload: DevTaskIntakeEvent = {
    deliveryId,
    source: 'linear',
    action: body.action ?? 'update',
    via: decision.via,
    issue: {
      id: issueId,
      identifier: data.identifier ?? issueId,
      title: data.title?.trim() || '(untitled issue)',
      description: truncate(data.description, MAX_DESCRIPTION_CHARS),
      url: data.url ?? body.url ?? null,
      teamKey: data.team?.key ?? null,
      projectId: data.projectId ?? data.project?.id ?? null,
    },
    requester: {
      name: requesterSource?.name ?? null,
      email: requesterSource?.email ?? null,
      externalId: requesterSource?.id ?? data.creatorId ?? null,
    },
    repoHint: repoHintOf(data),
  };

  try {
    await inngest.send({ name: EVENT_TASK_INTAKE, data: payload });
  } catch (err) {
    // Give the claim back, otherwise Linear's retry looks like a duplicate and
    // the issue is silently never picked up.
    await ledger.release(deliveryId).catch(() => undefined);
    logger.error('linear-webhook: could not enqueue the intake', {
      error: (err as Error).message,
    });
    return NextResponse.json({ error: 'enqueue failed' }, { status: 500 });
  }

  logger.info(
    `linear-webhook: queued ${payload.issue.identifier} for intake (via ${decision.via})`,
  );
  return NextResponse.json({ accepted: true, issue: payload.issue.identifier }, { status: 202 });
}

/** Linear only ever POSTs. A GET is a human poking the URL. */
export function GET(): NextResponse {
  return NextResponse.json(
    { error: 'This endpoint only accepts signed Linear webhooks (POST).' },
    { status: 405 },
  );
}
