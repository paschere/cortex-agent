import type { ChatDmStatus, PreferencesView } from '@/app/api/settings/preferences/schema';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { isChatOutboundConfigured } from '@/lib/google-chat';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { PREFERENCE_COLUMNS, listMemories, rowToPreferences } from '@cortex/agent-tools';
import { Brain, ChevronRight, Settings as SettingsIcon } from 'lucide-react';
import Link from 'next/link';
import { SettingsForm } from './SettingsForm';

export const dynamic = 'force-dynamic';

/**
 * /settings — the person's own controls, not an admin screen. The only row it
 * ever reads or writes is the one keyed to their session.
 */
export default async function SettingsPage() {
  const user = await requireSession();
  const db = getSupabaseServiceClient();

  // Preferences, the Chat link and the memory counts are independent reads;
  // none blocks the others.
  const [{ data }, link, memories] = await Promise.all([
    db.from('user_preferences').select(PREFERENCE_COLUMNS).eq('user_id', user.id).maybeSingle(),
    // The DM thread is discovered, not created: this row only exists once the
    // person has messaged the Cortex app in Google Chat. Reading it here is what
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
    // Never throws the page: a memory read that fails should cost the link's
    // counts, not the settings form.
    listMemories(db, user.id).catch(() => []),
  ]);

  const activeMemories = memories.filter((m) => m.status === 'active').length;
  const pendingMemories = memories.filter((m) => m.status === 'suggested').length;

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
        title="Configuración"
        subtitle="Tus preferencias: qué puede hacer Cortex por ti y por dónde te escribe"
        icon={<SettingsIcon className="h-5 w-5" />}
      />
      <SettingsForm initial={initial} chatDm={chatDm} />

      {/* Its own page, linked from here: the list is acted on rather than filled
          in, and it has to be findable from the one place people look for
          "things this product holds about me". */}
      <Panel className="mt-5">
        <Link
          href="/settings/memory"
          className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
              <Brain className="h-4 w-4" />
            </span>
            <div>
              <div className="text-[13px] font-semibold text-ink">
                Lo que Cortex recuerda de ti
              </div>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">
                {activeMemories === 0 ? (
                  'Todavía nada. Cortex va anotando cosas a medida que trabajan juntos.'
                ) : (
                  <>
                    <span className="tabular text-ink">{activeMemories}</span>{' '}
                    {activeMemories === 1 ? 'cosa que lleva' : 'cosas que lleva'} a cada
                    conversación.
                  </>
                )}
                {pendingMemories > 0 && (
                  <>
                    {' '}
                    <span className="tabular text-ink">{pendingMemories}</span>{' '}
                    {pendingMemories === 1 ? 'espera' : 'esperan'} a que las guardes o las
                    descartes.
                  </>
                )}
              </p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" />
        </Link>
      </Panel>
    </>
  );
}
