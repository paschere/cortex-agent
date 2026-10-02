'use client';

import { AutopilotStrip } from '@/app/(app)/dashboard/_components/AutopilotStrip';
import { AutopilotHome } from '@/components/autopilot/AutopilotHome';
import { RunDetail } from '@/components/autopilot/RunDetail';
import type { AutopilotActions } from '@/components/autopilot/types';
import { useEffect } from 'react';
import type { ShowcaseData } from './data';

const wait = () => new Promise((r) => setTimeout(r, 450));

export function PilotoFixture({
  dark,
  pantalla,
  data,
}: {
  dark: boolean;
  pantalla: 'inicio' | 'corrida' | 'tarjeta' | 'ensayo';
  data: ShowcaseData;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  /** Acciones de mentira: contestan como el servidor, sin guardar nada. */
  const actions: AutopilotActions = {
    async save(input) {
      await wait();
      if (input.enabled === true) return { ok: true, note: 'Encendido (de mentira).' };
      if (input.enabled === false) return { ok: true, note: 'Apagado (de mentira).' };
      return { ok: true, note: 'Guardado (de mentira).' };
    },
    async dryRun() {
      await wait();
      return { ok: true, plan: data.plan };
    },
    async decide(input) {
      await wait();
      return {
        ok: true,
        note: input.decision === 'approve' ? 'Hecho (de mentira).' : 'Descartado (de mentira).',
      };
    },
  };
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1100px] px-4 py-6 md:px-8 md:py-7">
        {pantalla === 'tarjeta' && (
          <div className="space-y-2">
            <AutopilotStrip
              enabled
              ran
              running={false}
              done={data.today?.counts.done ?? 4}
              waiting={data.waiting}
              href="#"
              runHour={7}
            />
            <AutopilotStrip
              enabled
              ran={false}
              running={false}
              done={0}
              waiting={1}
              href="#"
              runHour={7}
            />
          </div>
        )}
        {pantalla === 'corrida' && data.today && (
          <RunDetail run={data.today} actions={actions} canDecide />
        )}
        {(pantalla === 'inicio' || pantalla === 'ensayo') && (
          <AutopilotHome
            settings={data.settings}
            today={data.today}
            todayLabel="martes 6 de octubre"
            history={data.history}
            waiting={data.waiting}
            actions={actions}
            canEdit
            initialPlan={pantalla === 'ensayo' ? data.plan : null}
          />
        )}
      </main>
    </div>
  );
}
