import { createHash } from 'node:crypto';
import { z } from 'zod';
const eventId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
/** Bearer token is returned once to the owner; never put it in a URL/log. */
export function validateFeedSignal(headers: Headers, now = Date.now()) {
  const token = headers.get('x-cortex-hook-token') ?? '';
  const event = eventId.safeParse(headers.get('x-cortex-event-id'));
  const stamp = Number(headers.get('x-cortex-timestamp'));
  if (
    !/^[a-zA-Z0-9_-]{43}$/.test(token) ||
    !event.success ||
    !Number.isSafeInteger(stamp) ||
    Math.abs(now - stamp * 1000) > 300000
  )
    return null;
  return { tokenHash: createHash('sha256').update(token).digest('hex'), eventId: event.data };
}
