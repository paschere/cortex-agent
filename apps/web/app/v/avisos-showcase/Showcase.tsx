'use client';

import { PageHeader } from '@/components/ui/page-header';
import type { NotificationPreferences } from '@/lib/notifications/preferences-shape';
import { Bell } from 'lucide-react';
import { AvisosForm } from '../../(app)/settings/avisos/AvisosForm';

export function AvisosFixture({
  initial,
  dark,
}: { initial: NotificationPreferences; dark: boolean }) {
  return (
    <div className={dark ? 'dark' : undefined} data-theme={dark ? 'dark' : 'light'}>
      <div className="min-h-screen bg-canvas px-4 py-6 text-ink sm:px-8">
        <PageHeader
          title="Avisos"
          subtitle="Elige qué te avisa Cortex, por dónde y a qué horas. Lo que apagues deja de llegarte; lo demás sigue como siempre."
          icon={<Bell className="h-5 w-5" />}
        />
        <AvisosForm
          initial={initial}
          save={async () => ({ ok: true, note: 'Listo (de mentira: nada se guardó).' })}
        />
      </div>
    </div>
  );
}
