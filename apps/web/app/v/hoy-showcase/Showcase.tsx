'use client';

import { HoyDashboard } from '@/components/hoy/HoyDashboard';
import type { HoyView } from '@/lib/hoy/view';

/** «Hoy» con datos inventados; decidir contesta igual pero no guarda nada. */
export function HoyFixture({ view, dark }: { view: HoyView; dark: boolean }) {
  return (
    <div className={dark ? 'dark' : undefined} data-theme={dark ? 'dark' : 'light'}>
      <div className="min-h-screen bg-canvas px-4 py-6 text-ink sm:px-8">
        <HoyDashboard
          view={view}
          decide={async () => ({ ok: true, note: 'Hecho (de mentira: nada se guardó).' })}
          snooze={async () => ({ ok: true, note: 'Pospuesto (de mentira: nada se guardó).' })}
        />
      </div>
    </div>
  );
}
