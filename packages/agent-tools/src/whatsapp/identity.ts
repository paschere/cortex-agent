import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Who is on the other end of a WhatsApp direct message.
 *
 * THE RULE, AND IT HAS NO EXCEPTIONS: a turn never runs without a resolved
 * person. Cortex's tools read payroll, write to HubSpot, open pull requests and
 * answer out of Brain Knowledge. Running any of that for "whoever texted this
 * number" is anonymous access to the company's systems, and a phone number is
 * not an identity claim — it is a string anybody can put in a contact card. So
 * an unknown number gets a short refusal, the attempt is recorded, and nothing
 * else happens. `resolveWhatsappSender` returning null is not an error path to
 * be worked around; it is the answer.
 *
 * The mapping is deliberate and manual. There is no "match the number against
 * the phone field on the user record" convenience here, because that field is
 * self-service in most directories and would turn "type your colleague's number
 * into your profile" into privilege escalation. An admin links a number to a
 * person in Cortex, on purpose, and that link is the whole authorisation.
 *
 * Shaped after `google_chat_links` (migration 0045), which solves the same
 * problem for the same reason.
 */

export interface WhatsappSender {
  phone: string;
  userId: string;
  organizationId: string;
  displayName: string | null;
}

/**
 * A WhatsApp JID, a pasted number or a number with punctuation, reduced to the
 * digits WhatsApp itself keys on: E.164 without the leading '+'.
 *
 * Returns null rather than a best guess for anything that cannot be a phone
 * number. A best guess here would be a lookup key that matches the wrong
 * person's link row.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // "573001112233@s.whatsapp.net", "573001112233:12@s.whatsapp.net", or the
  // bare number. Anything after '@' or ':' is device and server routing.
  const head = raw.split('@')[0]?.split(':')[0] ?? '';
  const digits = head.replace(/\D/g, '');

  // E.164 allows 15 digits and no country code is shorter than one digit on a
  // subscriber number, but a 4-digit "number" is a short code or a typo, and
  // matching one to a person would be worse than refusing.
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

/** True for a group chat, which never takes the direct-message path. */
export function isGroupJid(jid: string | null | undefined): boolean {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

/**
 * The Cortex person behind a number, or null.
 *
 * Reads UNSCOPED on purpose, and this is the one place in the WhatsApp code
 * that does. The lookup is what DETERMINES the workspace — the same shape as
 * `resolveUser` in the Google Chat route, and for the same reason: you cannot
 * scope a query to the answer it is looking for. Everything downstream uses a
 * handle scoped to the workspace this returns.
 *
 * @param raw an unscoped service-role client
 */
export async function resolveWhatsappSender(
  raw: SupabaseClient,
  jidOrNumber: string,
): Promise<WhatsappSender | null> {
  const phone = normalizePhone(jidOrNumber);
  if (!phone) return null;

  const { data } = await raw
    .from('whatsapp_links')
    .select('phone_e164, user_id, organization_id, display_name')
    .eq('phone_e164', phone)
    .maybeSingle();

  const userId = data?.user_id as string | undefined;
  const organizationId = data?.organization_id as string | undefined;
  if (!userId || !organizationId) return null;

  return {
    phone,
    userId,
    organizationId,
    displayName: (data?.display_name as string | null) ?? null,
  };
}

/**
 * What an unknown number is told.
 *
 * Short, and deliberately says nothing it does not have to. It does not confirm
 * that this is a company's system, name the company, list what Cortex can do,
 * or hint that a different number would have worked — a stranger texting a
 * number they found should learn nothing from the reply. It does say enough
 * that a COLLEAGUE whose link was never set up knows what to ask for, because
 * that is who almost always sends this message.
 */
export const UNKNOWN_SENDER_REPLY =
  'Hola. Este número es un asistente de trabajo y solo responde a personas registradas. Si trabajas aquí, pídele a un administrador que vincule tu número en Cortex y vuelve a escribirme.';

/**
 * Record the attempt.
 *
 * In `security_events`, not in a table of its own: it is exactly what that
 * table is for — an access attempt that was refused — and it lands next to the
 * other refusals on the security page instead of in a corner nobody reads. The
 * number is stored because the whole point is being able to answer "who has
 * been texting this line", and it is a number that texted a company line, not a
 * number harvested from anywhere.
 */
export async function recordUnknownSender(
  db: SupabaseClient,
  opts: { phone: string; preview: string },
): Promise<void> {
  await db
    .from('security_events')
    .insert({
      tool_id: 'whatsapp.inbound',
      surface: 'whatsapp',
      risk_level: 'low',
      decision: 'block',
      reason: 'A WhatsApp number with no Cortex link sent a direct message. Nothing was run.',
      signals: {
        phone: opts.phone,
        // Capped hard: this row is evidence that somebody wrote, not a copy of
        // what they wrote. A stranger's message is not ours to file in full.
        preview: opts.preview.slice(0, 120),
      },
    })
    .then(undefined, () => undefined);
}
