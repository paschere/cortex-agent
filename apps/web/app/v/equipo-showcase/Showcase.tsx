'use client';

import { MeasureSettings } from '@/components/team/MeasureSettings';
import { MyWeek } from '@/components/team/MyWeek';
import { PersonDetail } from '@/components/team/PersonDetail';
import { TeamOverview } from '@/components/team/TeamOverview';
import type { TeamActions, TrackerOption } from '@/components/team/types';
import { PageHeader } from '@/components/ui/page-header';
import type { PersonScreen, TeamScreen } from '@/lib/team/screen';
import { CONNECT_WORK_PROMPT, chatPath } from '@/lib/team/shape';
import { Ruler } from 'lucide-react';
import { useEffect } from 'react';

/** Acciones de mentira: contestan como el servidor, sin guardar nada. */
const wait = () => new Promise((r) => setTimeout(r, 450));
const ACTIONS: TeamActions = {
  async reassign(input) {
    await wait();
    const n = input.moves.reduce((s, m) => s + m.itemIds.length, 0);
    return { ok: true, note: `Listo: pasé ${n} ítems (de mentira). Les avisé en la campana.` };
  },
  async markDone() {
    await wait();
    return { ok: true, note: 'Hecho (de mentira).' };
  },
  async saveAway(input) {
    await wait();
    return {
      ok: true,
      note: input.add.length
        ? `Anotado: ${input.add.length} días fuera (de mentira). No cuentan en contra.`
        : 'Quitado (de mentira).',
    };
  },
  async suggestMapping(input) {
    await wait();
    if (input.tracker === 'cobros')
      return {
        ok: true,
        mapping: {
          assigneeField: 'cobrador',
          statusField: null,
          doneValues: [],
          cancelledValues: [],
          dueField: 'vence',
          quantityField: 'valor',
          unit: 'COP',
          titleField: 'cliente',
        },
        candidates: [
          {
            key: 'cobrador',
            label: 'Cobrador',
            reason: '9 de 10 filas nombran a alguien del equipo.',
          },
        ],
        notes: '',
      };
    return {
      ok: true,
      mapping: {
        assigneeField: input.tracker === 'despachos' ? 'responsable' : 'atiende',
        statusField: 'estado',
        doneValues: input.tracker === 'despachos' ? ['Entregado'] : ['Resuelta'],
        cancelledValues: [],
        dueField: input.tracker === 'despachos' ? 'entrega' : 'limite',
        quantityField: input.tracker === 'despachos' ? 'guias' : null,
        unit: input.tracker === 'despachos' ? 'guías' : null,
        titleField: null,
      },
      candidates: [
        {
          key: input.tracker === 'despachos' ? 'responsable' : 'atiende',
          label: input.tracker === 'despachos' ? 'Responsable' : 'Quién atiende',
          reason: '24 de 25 filas nombran a alguien del equipo.',
        },
      ],
      notes: '',
    };
  },
  async configure(input) {
    await wait();
    return {
      ok: true,
      note: input.mapTracker
        ? 'Conectada. Cargué 86 ítems de trabajo (de mentira).'
        : 'Guardado (de mentira).',
    };
  },
};

export function EquipoFixture({
  dark,
  pantalla,
  team,
  person,
  trackers,
}: {
  dark: boolean;
  pantalla: 'equipo' | 'persona' | 'semana' | 'medir';
  team: TeamScreen | null;
  person: PersonScreen | null;
  trackers: TrackerOption[];
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-8 md:py-7">
        {pantalla === 'equipo' && team && (
          <TeamOverview
            screen={team}
            actions={ACTIONS}
            connectHref={chatPath(CONNECT_WORK_PROMPT)}
          />
        )}
        {pantalla === 'persona' && person && <PersonDetail screen={person} actions={ACTIONS} />}
        {pantalla === 'semana' && person && (
          <MyWeek screen={person} actions={ACTIONS} askHref="/chat" teamHref={null} />
        )}
        {pantalla === 'medir' && (
          <>
            <PageHeader
              title="Qué se mide"
              subtitle="De dónde sale el trabajo del equipo, qué tipos cuentan y quién ve qué."
              icon={<Ruler className="h-5 w-5" />}
            />
            <MeasureSettings
              trackers={trackers}
              workTypes={['caso', 'cobro', 'despacho', 'solicitud']}
              measuredTypes={null}
              visibility="self"
              actions={ACTIONS}
            />
          </>
        )}
      </main>
    </div>
  );
}
