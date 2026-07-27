import type { ChatDmStatus, PreferencesView } from '@/app/api/settings/preferences/schema';
import { PageHeader } from '@/components/ui/page-header';
import { isChatOutboundConfigured } from '@/lib/google-chat';
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

  // Preferences and the Chat link are independent reads; neither blocks the other.
  const [{ data }, link] = await Promise.all([
    db.from('user_preferences').select(PREFERENCE_COLUMNS).eq('user_id', user.id).maybeSingle(),
    // The DM thread is discovered, not created: this row only exists once the
    // person has messaged the Zippy app in Google Chat. Reading it here is what
    // turns the DM toggle from a checkbox that might silently do nothing into
    // one that says, on the page, whether it will work.
    db
      .from('google_chat_links')
      .select('display_name, dm_space')
      .eq('user_id', user.id)
      .not('dm_space', 'is', null)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const p = rowToPreferences(user.id, (data as Record<string, unknown> | null) ?? null);
  const initial: PreferencesView = {
    inboxDigestEnabled: p.enabled,
    inboxDigestTime: p.time,
    timezone: p.timezone,
    deliverEmail: p.deliverEmail,
    deliverChat: p.deliverChat,
    chatWebhookUrl: p.chatWebhookUrl ?? '',
    deliverChatDm: p.deliverChatDm,
    digestFocus: p.digestFocus ?? '',
    email: user.email,
  };

  const chatDm: ChatDmStatus = {
    configured: isChatOutboundConfigured(),
    linked: Boolean(link.data?.dm_space),
    displayName: (link.data?.display_name as string | null | undefined) ?? null,
  };

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Your own preferences — what Zippy is allowed to do for you, and how it reaches you"
        icon={<SettingsIcon className="h-5 w-5" />}
      />
      <SettingsForm initial={initial} chatDm={chatDm} />
    </>
  );
}
