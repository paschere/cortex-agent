import type { ChatDmStatus, PreferencesView } from '@/app/api/settings/preferences/schema';
import { ThemeToggle } from '@/components/nav/ThemeToggle';
import { PageHeader } from '@/components/ui/page-header';
import { isChatOutboundConfigured } from '@/lib/google-chat';
import { companyModules } from '@/lib/modules/server';
import { requireSession } from '@/lib/session';
import { toHubEntries } from '@/lib/settings/hub';
import { type SettingsStateKey, visibleSettings } from '@/lib/settings/registry';
import {
  type SettingsState,
  mailState,
  memoryState,
  notificationsState,
  profileState,
  versionState,
} from '@/lib/settings/state-text';
import { loadSettingsStates } from '@/lib/settings/states';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { managesTeam } from '@/lib/team/read';
import { workspaceHref } from '@/lib/workspace-context';
import {
  PREFERENCE_COLUMNS,
  getSyncState,
  listMemories,
  rowToPreferences,
} from '@cortex/agent-tools';
import { Settings as SettingsIcon } from 'lucide-react';
import { SettingsForm } from './SettingsForm';
import { MailboxLearning, type MailboxState } from './_components/MailboxLearning';
import { SettingsHub } from './_components/SettingsHub';
import { LegalLinks, ProfileFacts, ROLE_LABEL, VersionInfo } from './_components/SettingsInlines';

/** El commit que está corriendo, si el entorno lo dice (Railway o Vercel). */
const buildSha = process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null;
const buildEnv = process.env.NODE_ENV === 'production' ? 'Producción' : 'Desarrollo';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Ajustes · Cortex' };

/**
 * /settings — EL RECIBIDOR DE AJUSTES: todo lo que se puede configurar en
 * Cortex, en un solo lugar y ordenado por lo que alguien viene a hacer.
 *
 * ===========================================================================
 * POR QUÉ ES UN RECIBIDOR Y NO UNA PANTALLA MÁS
 * ===========================================================================
 * Los ajustes vivían en veinte pantallas (Datos de la empresa, Sin preguntar,
 * Plan, Conectar Claude, la voz, la privacidad, el piloto…) y la única forma de
 * dar con uno era saber dónde estaba. Esta página no los reemplaza: los reúne.
 * Cada uno aparece con su título, una línea que lo explica, su estado cuando
 * es barato saberlo («Plan Equipo · prueba: 9 días») y, según el caso, su
 * control a la mano (apariencia, avisos, correo) o un «Abrir» a su pantalla.
 *
 * La lista sale de `lib/settings/registry.ts`, puro y probado. Aquí sólo se
 * decide qué ve ESTA persona (su rol y los módulos que la empresa prendió) y se
 * leen los datos cortos. Lo que se esconde por módulo apagado se cuenta al
 * pie con el enlace a Módulos; lo que se esconde por rol, también se dice.
 *
 * Nada de lo que se guarda cambió: el formulario de avisos, el del correo, la
 * voz, la memoria y la privacidad son los mismos de siempre, y los enlaces
 * viejos (`/settings#correo`, `#resumen`, `#cerebro`, `/settings/voice`…) siguen
 * llevando al mismo control.
 */

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  // Las preferencias, el enlace de Chat, las memorias, la entrevista y el buzón
  // son lecturas independientes; ninguna bloquea a las otras.
  const [modulesOn, { data, error: prefsError }, link, memories, mailbox, google] =
    await Promise.all([
      companyModules(user.organization.id),
      db.from('user_preferences').select(PREFERENCE_COLUMNS).eq('user_id', user.id).maybeSingle(),
      // El hilo de mensaje directo se descubre, no se crea: esta fila sólo existe
      // cuando la persona ya le escribió a Cortex en Google Chat. Leerla aquí es
      // lo que convierte el interruptor del DM de una casilla que puede no hacer
      // nada en una que dice, en la página, si va a funcionar.
      db
        .from('google_chat_links')
        .select('display_name, dm_space')
        .eq('user_id', user.id)
        .not('dm_space', 'is', null)
        .order('last_seen_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      // Nunca tumba la página: una lectura de memorias que falle debe costar sus
      // números, no el formulario.
      listMemories(db, user.id).catch(() => []),
      // El buzón que Cortex está aprendiendo, si hay alguno. Es de esta persona:
      // `gmail_sync_state` tiene una fila por usuario y esto nombra la suya.
      getSyncState(db, user.id).catch(() => null),
      // Si su cuenta de Google está conectada. Sin eso, el panel del buzón dice
      // qué falta en vez de ofrecer un botón que no puede funcionar.
      db
        .from('integrations')
        .select('provider')
        .eq('user_id', user.id)
        .eq('provider', 'google')
        .maybeSingle()
        .then((r) => !r.error && Boolean(r.data))
        .then(
          (connected) => connected,
          () => false,
        ),
    ]);

  const viewer = {
    admin: user.role === 'org_admin',
    teamManager: managesTeam(user),
    modulesOn,
  };
  const visible = visibleSettings(viewer);

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
    mailAlertsEnabled: p.mailAlertsEnabled,
    mailAlertsMaxPerDay: p.mailAlertsMaxPerDay,
    mailAlertsFrom: p.mailAlertsFrom,
    mailAlertsTo: p.mailAlertsTo,
    weeklyReportEnabled: p.weeklyReportEnabled,
    email: user.email,
  };

  const chatDm: ChatDmStatus = {
    configured: isChatOutboundConfigured(),
    linked: !link.error && Boolean(link.data?.dm_space),
    displayName:
      (!link.error ? (link.data?.display_name as string | null | undefined) : null) ?? null,
  };

  // Los datos cortos: los que ya se leyeron para los formularios, más los que
  // cuestan una lectura y sólo se piden si la entrada se va a ver.
  const wanted = new Set(visible.entries.flatMap((e) => (e.state ? [e.state] : [])));
  const loaded = await loadSettingsStates({
    db,
    userId: user.id,
    wanted,
    modulesOnCount: modulesOn.size,
  });
  const states: Partial<Record<SettingsStateKey, SettingsState>> = {
    ...loaded,
    perfil: profileState(user.name, ROLE_LABEL[user.organization.role] ?? user.organization.role),
    ...(prefsError
      ? {}
      : {
          notificaciones: notificationsState({
            digestEnabled: p.enabled,
            digestTime: p.time,
            mailAlertsEnabled: p.mailAlertsEnabled,
          }),
        }),
    memoria: memoryState(activeMemories, pendingMemories),
    correo: mailState(google, mailbox),
    empresa: { text: user.organization.name, tone: 'neutral' },
    version: versionState(buildSha),
  };

  const entries = toHubEntries(visible.entries, states, (href) =>
    workspaceHref(user.organization.id, href),
  );

  return (
    <>
      <PageHeader
        title="Ajustes"
        subtitle="Todo lo que se puede configurar en Cortex, en un solo lugar: lo tuyo, lo de la empresa, lo que Cortex hace solo y de dónde saca la información."
        icon={<SettingsIcon className="h-5 w-5" />}
      />
      <SettingsHub
        entries={entries}
        hiddenByModule={visible.hiddenByModule}
        hiddenByRole={visible.hiddenByRole}
        modulesHref={workspaceHref(user.organization.id, '/settings/modulos')}
        initialQuery={(q ?? '').slice(0, 80)}
        inline={{
          perfil: (
            <ProfileFacts
              name={user.name}
              email={user.email}
              workspace={user.organization.name}
              role={user.organization.role}
            />
          ),
          apariencia: <ThemeToggle />,
          // Si la lectura falló, NO se pinta el formulario con los valores por
          // defecto: guardar encima sería pisar lo que la persona sí tenía.
          notificaciones: prefsError ? (
            <p className="text-sm text-rose">
              No pudimos leer tus preferencias de avisos. Recarga la página; si sigue igual,
              escríbenos desde Ayuda.
            </p>
          ) : (
            <SettingsForm initial={initial} chatDm={chatDm} />
          ),
          correo: (
            <MailboxLearning
              googleConnected={google}
              state={
                mailbox
                  ? ({
                      emailAddress: mailbox.emailAddress,
                      backfillWindow: mailbox.backfillWindow,
                      backfillThreads: mailbox.backfillThreads,
                      backfillDoneAt: mailbox.backfillDoneAt,
                      lastSyncedAt: mailbox.lastSyncedAt,
                      lastError: mailbox.lastError,
                      paused: mailbox.paused,
                    } satisfies MailboxState)
                  : null
              }
            />
          ),
          legales: <LegalLinks />,
          version: <VersionInfo sha={buildSha} env={buildEnv} />,
        }}
      />
    </>
  );
}
