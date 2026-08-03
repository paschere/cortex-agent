import { ValidationError } from '@cortex/core';
import { parseExpression } from 'cron-parser';

/**
 * Compute the next occurrence of a cron expression after `from` (defaults to
 * now) in the given IANA timezone. Throws ValidationError on a bad expression
 * or timezone so schedule.create can reject invalid jobs at creation time.
 */
export function computeNextRun(cron: string, timezone: string, from?: Date): Date {
  try {
    const interval = parseExpression(cron, { tz: timezone, currentDate: from ?? new Date() });
    return interval.next().toDate();
  } catch (err) {
    throw new ValidationError(
      `Invalid cron expression "${cron}" (tz ${timezone}): ${(err as Error).message}`,
    );
  }
}

/** Validate without computing — used for input validation. */
export function isValidCron(cron: string, timezone: string): boolean {
  try {
    parseExpression(cron, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}
