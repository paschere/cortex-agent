'use client';

import { HoyDashboard } from '@/components/hoy/HoyDashboard';
import type { HoyView } from '@/lib/hoy/view';
import { useEffect } from 'react';

/**
 * «Hoy» con datos inventados; decidir contesta igual pero no guarda nada. El
 * tema oscuro lo pone `data-theme` en <html> y sólo se aplica dentro de
 * `.cortex-workspace` (ver globals.css): sin esa clase el modo oscuro no se ve.
 */
export function HoyFixture({ view, dark }: { view: HoyView; dark: boolean }) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return (
    <div className="cortex-workspace min-h-screen bg-canvas px-4 py-6 text-ink sm:px-8">
      <HoyDashboard
        view={view}
        decide={async () => ({ ok: true, note: 'Hecho (de mentira: nada se guardó).' })}
        snooze={async () => ({ ok: true, note: 'Pospuesto (de mentira: nada se guardó).' })}
      />
    </div>
  );
}
