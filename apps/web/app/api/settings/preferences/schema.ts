import { z } from 'zod';

/**
 * This module is imported by a CLIENT component, so it must stay free of
 * server-only dependencies: importing `@zipdev/agent-tools` here dragged the
 * whole tool registry — and with it `node:crypto`, `node:dns` and pdf-parse's
 * `fs` access — into the browser bundle and broke the build. The check below
 * mirrors `parseChatWebhookUrl` in packages/agent-tools/src/chat/webhook.ts;
 * the authoritative validation still runs there, server-side, before anything
 * is posted to Google.
 */
const GOOGLE_CHAT_WEBHOOK_HOST = 'chat.googleapis.com';

/** Shape check only: same rules as the server-side parser, no I/O. */
export function isGoogleChatWebhookUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.hostname.toLowerCase() !== GOOGLE_CHAT_WEBHOOK_HOST) return false;
  if (!/^\/v1\/spaces\/[A-Za-z0-9_-]+\/messages$/.test(parsed.pathname)) return false;
  return Boolean(parsed.searchParams.get('key') && parsed.searchParams.get('token'));
}

/**
 * Shared contract for the personal settings page and its API route, so the
 * form and the server agree on what is valid without duplicating rules.
 */

/** Short, curated list — the zones Zipdev actually works across. */
export const TIMEZONES = [
  { value: 'America/Bogota', label: 'Bogotá (COT)' },
  { value: 'America/Mexico_City', label: 'Mexico City (CST)' },
  { value: 'America/Lima', label: 'Lima (PET)' },
  { value: 'America/Buenos_Aires', label: 'Buenos Aires (ART)' },
  { value: 'America/Santiago', label: 'Santiago (CLT)' },
  { value: 'America/New_York', label: 'New York (ET)' },
  { value: 'America/Chicago', label: 'Chicago (CT)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (PT)' },
  { value: 'Europe/Madrid', label: 'Madrid (CET)' },
  { value: 'UTC', label: 'UTC' },
] as const;

const TIMEZONE_VALUES = TIMEZONES.map((t) => t.value) as [string, ...string[]];

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const PreferencesBody = z
  .object({
    inboxDigestEnabled: z.boolean(),
    inboxDigestTime: z.string().regex(HHMM, 'Use a 24-hour time like 07:30'),
    timezone: z.enum(TIMEZONE_VALUES),
    deliverEmail: z.boolean(),
    deliverChat: z.boolean(),
    // Empty string clears the stored webhook.
    chatWebhookUrl: z.string().trim().max(1000).default(''),
    digestFocus: z.string().trim().max(600).default(''),
  })
  .partial()
  .refine((b) => !b.chatWebhookUrl || isGoogleChatWebhookUrl(b.chatWebhookUrl), {
    message:
      'That is not a Google Chat webhook. It must be an https://chat.googleapis.com/v1/spaces/…/messages URL copied from the space.',
    path: ['chatWebhookUrl'],
  })
  .refine((b) => !(b.deliverChat === true && b.chatWebhookUrl === ''), {
    message: 'Add the webhook URL before turning on Google Chat delivery.',
    path: ['chatWebhookUrl'],
  });

export type PreferencesInput = z.infer<typeof PreferencesBody>;

/** What GET returns and the form renders. */
export interface PreferencesView {
  inboxDigestEnabled: boolean;
  inboxDigestTime: string;
  timezone: string;
  deliverEmail: boolean;
  deliverChat: boolean;
  chatWebhookUrl: string;
  digestFocus: string;
  /** The address the email digest would go to — shown, never edited here. */
  email: string;
}
