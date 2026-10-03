'use client';

import { ThemeToggle } from '@/components/nav/ThemeToggle';
import { PageHeader } from '@/components/ui/page-header';
import { toHubEntries } from '@/lib/settings/hub';
import { type SettingsStateKey, visibleSettings } from '@/lib/settings/registry';
import type { SettingsState } from '@/lib/settings/state-text';
import type { ModuleKey } from '@cortex/agent-tools/src/modules/catalog';
import { Settings } from 'lucide-react';
import { useEffect } from 'react';
import { SettingsForm } from '../../(app)/settings/SettingsForm';
import { MailboxLearning } from '../../(app)/settings/_components/MailboxLearning';
import { SettingsHub } from '../../(app)/settings/_components/SettingsHub';
import {
  LegalLinks,
  ProfileFacts,
  VersionInfo,
} from '../../(app)/settings/_components/SettingsInlines';

const STATES: Partial<Record<SettingsStateKey, SettingsState>> = {
  perfil: { text: 'Camila Rojas · Administración del espacio', tone: 'neutral' },
  notificaciones: { text: 'Resumen a las 07:00 · avisos del correo prendidos', tone: 'emerald' },
  memoria: { text: '3 por revisar', tone: 'amber' },
  correo: { text: 'Google conectado · aprendiendo', tone: 'emerald' },
  modulos: { text: '9 módulos prendidos', tone: 'primary' },
  personas: { text: '12 personas', tone: 'neutral' },
  mandatos: { text: '2 permisos activos', tone: 'primary' },
  plan: { text: 'Plan Equipo · prueba: 9 días', tone: 'primary' },
  conexiones: { text: '4 conexiones activas', tone: 'emerald' },
  piloto: { text: 'Prendido · 07:00', tone: 'emerald' },
  tokens: { text: '1 llave activa', tone: 'primary' },
  empresa: { text: 'Ferretería La Esquina', tone: 'neutral' },
  version: { text: 'Versión de desarrollo', tone: 'neutral' },
};

export function AjustesFixture({
  dark,
  admin,
  teamManager,
  modulesOn,
  query,
  open,
}: {
  dark: boolean;
  admin: boolean;
  teamManager: boolean;
  modulesOn: ModuleKey[];
  query: string;
  open: string | null;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  useEffect(() => {
    if (open) window.location.hash = open;
  }, [open]);

  const visible = visibleSettings({ admin, teamManager, modulesOn: new Set(modulesOn) });
  const entries = toHubEntries(visible.entries, STATES, (h) => h);

  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-7">
        <PageHeader
          title="Ajustes"
          subtitle="Todo lo que se puede configurar en Cortex, en un solo lugar: lo tuyo, lo de la empresa, lo que Cortex hace solo y de dónde saca la información."
          icon={<Settings className="h-5 w-5" />}
        />
        <SettingsHub
          entries={entries}
          hiddenByModule={visible.hiddenByModule}
          hiddenByRole={visible.hiddenByRole}
          modulesHref="/v/modulos-showcase"
          initialQuery={query}
          inline={{
            perfil: (
              <ProfileFacts
                name="Camila Rojas"
                email="camila@laesquina.co"
                workspace="Ferretería La Esquina"
                role={admin ? 'org_admin' : 'member'}
              />
            ),
            apariencia: <ThemeToggle />,
            notificaciones: (
              <SettingsForm
                initial={{
                  inboxDigestEnabled: true,
                  inboxDigestTime: '07:00',
                  timezone: 'America/Bogota',
                  deliverEmail: true,
                  deliverChat: false,
                  chatWebhookUrl: '',
                  deliverChatDm: false,
                  digestFocus: '',
                  mailAlertsEnabled: true,
                  mailAlertsMaxPerDay: 5,
                  mailAlertsFrom: '08:00',
                  mailAlertsTo: '18:00',
                  weeklyReportEnabled: true,
                  email: 'camila@laesquina.co',
                }}
                chatDm={{ configured: false, linked: false, displayName: null }}
              />
            ),
            correo: <MailboxLearning googleConnected state={null} />,
            legales: <LegalLinks />,
            version: <VersionInfo sha={null} env="Desarrollo" />,
          }}
        />
      </main>
    </div>
  );
}
