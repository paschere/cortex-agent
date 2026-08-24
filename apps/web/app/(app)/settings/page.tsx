import type { ChatDmStatus, PreferencesView } from '@/app/api/settings/preferences/schema';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { isChatOutboundConfigured } from '@/lib/google-chat';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  PREFERENCE_COLUMNS,
  getSyncState,
  listMemories,
  rowToPreferences,
} from '@cortex/agent-tools';
import {
  Brain,
  Building2,
  ChevronRight,
  Mail,
  MessagesSquare,
  Settings as SettingsIcon,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { SettingsForm } from './SettingsForm';
import { MailboxLearning, type MailboxState } from './_components/MailboxLearning';
import { type NavSection, SettingsNav } from './_components/SettingsNav';

export const dynamic = 'force-dynamic';

/**
 * /settings — los controles de una persona sobre sí misma, no una pantalla de
 * administración. La única fila que lee o escribe es la de su propia sesión.
 *
 * ===========================================================================
 * POR QUÉ ESTA PANTALLA SE REORGANIZÓ
 * ===========================================================================
 * Era una columna de siete paneles, todos del mismo tamaño y todos sobre lo
 * mismo (el resumen diario), con dos enlaces al final a las dos cosas que la
 * gente viene a buscar de verdad: qué recuerda Cortex de ellos y cómo trabaja
 * su empresa. Para llegar a eso había que pasar por el webhook de Google Chat.
 *
 * Ahora la página está partida en secciones con un índice al lado, y las
 * secciones están ordenadas por lo que alguien viene a hacer:
 *
 *   1. TU CUENTA        quién eres para Cortex y en qué empresa. Antes no
 *                       estaba en ninguna parte, y es lo primero que uno mira
 *                       cuando entra a «configuración» de cualquier producto.
 *   2. TU CORREO        lo más grande que se decide aquí: si Cortex aprende de
 *                       tu buzón. Va segundo porque es una decisión, no un
 *                       ajuste, y porque es nuevo.
 *   3. EL RESUMEN       lo que ya estaba, intacto en su comportamiento.
 *   4. TU CEREBRO       los dos enlaces, que ahora se ven sin bajar hasta el
 *                       fondo.
 *
 * Son ANCLAS y no pestañas: la página sigue siendo una sola, se puede buscar
 * con Ctrl+F y `/settings#correo` es un enlace que funciona desde cualquier
 * sitio.
 */

const SECTIONS: NavSection[] = [
  { id: 'cuenta', label: 'Tu cuenta' },
  { id: 'correo', label: 'Tu correo' },
  { id: 'resumen', label: 'Resumen diario' },
  { id: 'cerebro', label: 'Tu cerebro' },
];

/** Cómo se llama cada papel en la empresa, en español y sin jerga de sistema. */
const ROLE_LABEL: Record<string, string> = {
  org_admin: 'Administradora o administrador del espacio',
  team_admin: 'Lidera un equipo',
  member: 'Miembro del equipo',
};

export default async function SettingsPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  // Las preferencias, el enlace de Chat, las memorias, la entrevista y el buzón
  // son lecturas independientes; ninguna bloquea a las otras.
  const [{ data }, link, memories, setup, mailbox, google] = await Promise.all([
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
    // Cuántas cosas ha creado de verdad la entrevista de arranque. Misma
    // postura que la lectura de memorias: un fallo cuesta este número, jamás la
    // página.
    db
      .from('guided_setup_items')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'created')
      .then((r) => r.count ?? 0)
      .then(
        (n) => n,
        () => null,
      ),
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
      .then((r) => Boolean(r.data))
      .then(
        (connected) => connected,
        () => false,
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
    weeklyReportEnabled: p.weeklyReportEnabled,
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
        subtitle="Tu cuenta, qué puede hacer Cortex por ti y por dónde te escribe"
        icon={<SettingsIcon className="h-5 w-5" />}
      />

      <div className="grid gap-6 lg:grid-cols-[190px_minmax(0,1fr)]">
        <SettingsNav sections={SECTIONS} />

        <div className="min-w-0 space-y-10">
          {/* ---- 1. Quién eres para Cortex --------------------------------- */}
          <section id="cuenta" className="scroll-mt-6">
            <SectionHead
              icon={<ShieldCheck className="h-4 w-4" />}
              title="Tu cuenta"
              blurb="Con qué identidad trabaja Cortex cuando hace algo por ti. Todo lo que lee y escribe pasa por estos datos."
            />
            <Panel className="p-5">
              <dl className="grid gap-4 sm:grid-cols-2">
                <Fact label="Nombre" value={user.name?.trim() || 'Sin nombre'} />
                <Fact label="Correo" value={user.email} mono />
                <Fact
                  label="Espacio de trabajo"
                  value={user.organization.name}
                  icon={<Building2 className="h-3.5 w-3.5" />}
                />
                <Fact
                  label="Tu papel aquí"
                  value={ROLE_LABEL[user.organization.role] ?? user.organization.role}
                />
              </dl>
              <p className="mt-4 border-t border-border pt-3 text-xs leading-relaxed text-ink-faint">
                El nombre y el correo salen de tu cuenta de Google y no se cambian desde aquí. Si
                perteneces a dos empresas, cada una tiene su propia configuración: ésta es la de{' '}
                <span className="font-semibold text-ink-muted">{user.organization.name}</span>.
              </p>
            </Panel>
          </section>

          {/* ---- 2. La decisión grande ------------------------------------- */}
          <section id="correo" className="scroll-mt-6">
            <SectionHead
              icon={<Mail className="h-4 w-4" />}
              title="Tu correo"
              blurb="Si Cortex aprende de tu buzón: se lo lee una vez, lo guarda donde sólo tú buscas, y desde entonces revisa cada mañana lo que llegó."
            />
            <Panel className="p-5">
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
            </Panel>
          </section>

          {/* ---- 3. Lo de siempre ------------------------------------------ */}
          <section id="resumen" className="scroll-mt-6">
            <SectionHead
              icon={<MessagesSquare className="h-4 w-4" />}
              title="Resumen diario y parte semanal"
              blurb="Qué te manda Cortex sin que se lo pidas, a qué hora y por dónde."
            />
            <SettingsForm initial={initial} chatDm={chatDm} />
          </section>

          {/* ---- 4. Lo que la gente viene a buscar -------------------------- */}
          <section id="cerebro" className="scroll-mt-6">
            <SectionHead
              icon={<Brain className="h-4 w-4" />}
              title="Tu cerebro"
              blurb="Lo que Cortex sabe de ti y de tu empresa, y que puedes revisar o quitar cuando quieras."
            />
            <div className="space-y-3">
              {/* Su propia página, enlazada desde aquí: la lista se actúa más
                  que se rellena, y tiene que encontrarse desde el único sitio
                  donde la gente busca «qué guarda este producto sobre mí». */}
              <RowLink
                href="/settings/memory"
                icon={<Brain className="h-4 w-4" />}
                title="Lo que Cortex recuerda de ti"
              >
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
              </RowLink>

              {/* La entrevista vive aquí, al lado de la lista de memorias, por
                  la razón que dice esa fila: éste es el sitio donde se busca
                  «qué guarda y qué hace este producto en mi nombre».
                  También se llega desde /onboarding, pero sólo mientras no haya
                  una fuente conectada y una primera pregunta hecha — sensato
                  para el primer día, inútil como dirección permanente. Contarle
                  a Cortex cómo trabaja la empresa no es tarea de la primera
                  semana: es algo que alguien recuerda un martes de marzo, y
                  entonces va a buscarlo a Configuración. */}
              <RowLink
                href="/onboarding/entrevista"
                icon={<MessagesSquare className="h-4 w-4" />}
                title="Cuéntale cómo trabaja tu empresa"
              >
                {setup === null || setup === 0 ? (
                  'Le explicas tus procesos, te hace unas preguntas, y te propone qué vigilar y qué hacer solo. Nada se crea sin que lo apruebes.'
                ) : (
                  <>
                    Ya dejó <span className="tabular text-ink">{setup}</span>{' '}
                    {setup === 1 ? 'cosa andando' : 'cosas andando'}. Cuéntale algo más y te propone
                    lo siguiente.
                  </>
                )}
              </RowLink>

              <RowLink
                href="/integrations"
                icon={<Building2 className="h-4 w-4" />}
                title="Lo que Cortex tiene conectado"
              >
                Google, Microsoft, WhatsApp, HubSpot y los demás sistemas de los que saca
                información — y quién conectó cada uno.
              </RowLink>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

/** El encabezado de una sección: dice de qué va antes de enseñar los controles. */
function SectionHead({
  icon,
  title,
  blurb,
}: {
  icon: React.ReactNode;
  title: string;
  blurb: string;
}) {
  return (
    <div className="mb-3 flex items-start gap-2.5">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-bold text-ink">{title}</h2>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{blurb}</p>
      </div>
    </div>
  );
}

/** Un dato de la cuenta. Etiqueta arriba, valor abajo, sin adornos. */
function Fact({
  label,
  value,
  mono,
  icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="field-label">{label}</dt>
      <dd className="mt-1 flex items-center gap-1.5 text-sm text-ink">
        {icon && <span className="shrink-0 text-ink-faint">{icon}</span>}
        <span className={mono ? 'tabular truncate' : 'truncate'}>{value}</span>
      </dd>
    </div>
  );
}

/** Una fila que lleva a otra pantalla. */
function RowLink({
  href,
  icon,
  title,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Panel>
      <Link
        href={href}
        className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-surface-2"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
            {icon}
          </span>
          <div>
            <div className="text-sm font-semibold text-ink">{title}</div>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{children}</p>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" />
      </Link>
    </Panel>
  );
}
