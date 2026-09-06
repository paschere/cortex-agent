import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { MailMessage } from './threads';
export const mailPolicySchema = z.object({
  labels: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/))
    .max(30)
    .default([]),
  senders: z.array(z.string().email().max(254)).max(30).default([]),
  alerts: z.boolean().default(false),
  replies: z.boolean().default(false),
  learning: z.boolean().default(false),
});
export type MailPolicy = z.infer<typeof mailPolicySchema>;
export const defaultMailPolicy = mailPolicySchema.parse({});
export async function readMailPolicy(db: SupabaseClient, userId: string): Promise<MailPolicy> {
  const r = await db.from('mail_policies').select('data').eq('user_id', userId).maybeSingle();
  if (r.error) throw new Error('No se pudieron comprobar las preferencias de correo.');
  return r.data ? mailPolicySchema.parse(r.data.data) : defaultMailPolicy;
}
/** Scope applies to background processing. Direct, user-requested Gmail consultation stays live. */
export function allowedMailMessages(messages: MailMessage[], policy: MailPolicy) {
  return messages.filter(
    (m) =>
      !m.labelIds.some((l) =>
        ['SPAM', 'TRASH', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL'].includes(l),
      ) &&
      (!policy.labels.length || policy.labels.some((l) => m.labelIds.includes(l))) &&
      (!policy.senders.length ||
        policy.senders.some((s) => s.toLowerCase() === m.fromEmail?.toLowerCase())),
  );
}
export async function saveMailPolicy(db: SupabaseClient, userId: string, input: unknown) {
  const data = mailPolicySchema.parse(input);
  const r = await db
    .from('mail_policies')
    .upsert(
      { user_id: userId, data, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
  if (r.error) throw new Error('No se pudieron guardar las preferencias.');
  return data;
}
