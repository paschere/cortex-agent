import type { ChatDmStatus, PreferencesView } from '@/app/api/settings/preferences/schema';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { isChatOutboundConfigured } from '@/lib/google-chat';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { PREFERENCE_COLUMNS, listMemories, rowToPreferences } from '@cortex/agent-tools';
import { Brain, ChevronRight, MessagesSquare, Settings as SettingsIcon } from 'lucide-react';
import Link from 'next/link';
import { SettingsForm } from './SettingsForm';

export const dynamic = 'force-dynamic';

/**
 * /settings — the person's own controls, not an admin screen. The only row it
 * ever reads or writes is the one keyed to their session.
 */
export default async function SettingsPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  // Preferences, the Chat link, the memory counts and the setup interview are
  // independent reads; none blocks the others.
  const [{ data }, link, memories, setup] = await Promise.all([
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
    // How many things the setup interview has actually created. Same posture as
    // the memory read: a failure here costs this row its number, never the page.
    db
      .from('guided_setup_items')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'created')
      .then((r) => r.count ?? 0)
      .then(
        (n) => n,
        () => null,
      ),
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

      {/* The setup interview lives here, next to the memory list, for the reason
          that row states: this is where people look for "what this product holds
          and does on my behalf".
          It is reachable from /onboarding too, but only once a source is
          connected and a first question has been asked — sensible for a first
          run, and useless as the permanent address. Telling Cortex how the
          company works is not a first-week task: it is something somebody
          remembers on a Tuesday in March, and then they go looking in Settings. */}
      <Panel className="mt-5">
        <Link
          href="/onboarding/entrevista"
          className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
              <MessagesSquare className="h-4 w-4" />
            </span>
            <div>
              <div className="text-[13px] font-semibold text-ink">
                Cuéntale cómo trabaja tu empresa
              </div>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">
                {setup === null || setup === 0 ? (
                  'Le explicas tus procesos, te hace unas preguntas, y te propone qué vigilar y qué hacer solo. Nada se crea sin que lo apruebes.'
                ) : (
                  <>
                    Ya dejó <span className="tabular text-ink">{setup}</span>{' '}
                    {setup === 1 ? 'cosa andando' : 'cosas andando'}. Cuéntale algo más y te
                    propone lo siguiente.
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
