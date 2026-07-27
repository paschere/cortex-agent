import type { PreferencesView } from '@/app/api/settings/preferences/schema';
import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { PREFERENCE_COLUMNS, rowToPreferences } from '@zipdev/agent-tools';
import { Settings as SettingsIcon } from 'lucide-react';
import { SettingsForm } from './SettingsForm';

export const dynamic = 'force-dynamic';

/**
 * /settings — the person's own controls, not an admin screen. The only row it
 * ever reads or writes is the one keyed to their session.
 */
export default async function SettingsPage() {
  const user = await requireSession();
  const db = getSupabaseServiceClient();

  const { data } = await db
    .from('user_preferences')
    .select(PREFERENCE_COLUMNS)
    .eq('user_id', user.id)
    .maybeSingle();

  const p = rowToPreferences(user.id, (data as Record<string, unknown> | null) ?? null);
  const initial: PreferencesView = {
    inboxDigestEnabled: p.enabled,
    inboxDigestTime: p.time,
    timezone: p.timezone,
    deliverEmail: p.deliverEmail,
    deliverChat: p.deliverChat,
    chatWebhookUrl: p.chatWebhookUrl ?? '',
    digestFocus: p.digestFocus ?? '',
    email: user.email,
  };

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Your own preferences — what Zippy is allowed to do for you, and how it reaches you"
        icon={<SettingsIcon className="h-5 w-5" />}
      />
      <SettingsForm initial={initial} />
    </>
  );
}
