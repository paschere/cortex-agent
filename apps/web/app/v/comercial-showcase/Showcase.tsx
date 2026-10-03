'use client';

import { SurveyForm } from '@/app/encuesta/[token]/SurveyForm';
import { CrmScreen, type CrmScreenProps } from '@/components/crm/CrmScreen';
import type { ActionResult, TimelineEntryView } from '@/lib/crm/shape';
import { useEffect } from 'react';

/**
 * El embudo comercial con datos inventados. Las acciones son de mentira:
 * contestan en pantalla sin tocar ninguna base.
 */

const fake = async (note: string, link?: string): Promise<ActionResult> => {
  await new Promise((r) => setTimeout(r, 300));
  return { ok: true, note: `(escaparate) ${note}`, ...(link ? { link } : {}) };
};

export function ComercialFixture({
  dark,
  screen,
  timeline,
  pantalla,
}: {
  pantalla: 'lista' | 'encuesta';
  dark: boolean;
  screen: Omit<CrmScreenProps, 'handlers' | 'tabHref'>;
  timeline: TimelineEntryView[];
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  if (pantalla === 'encuesta')
    return (
      <div className="cortex-workspace min-h-screen bg-canvas px-4 py-10">
        <SurveyForm
          token="escaparate"
          companyName="Insumos Industriales del Centro"
          contactName="Jorge Pardo"
          answered={null}
          onSubmit={async () => {
            await new Promise((r) => setTimeout(r, 300));
            return null;
          }}
        />
      </div>
    );
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <CrmScreen
        {...screen}
        tabHref={(t) => `?tab=${t}${dark ? '&modo=oscuro' : ''}`}
        handlers={{
          onEdit: async () => {},
          timeline: async () => ({ items: timeline, missing: [] }),
          logActivity: () => fake('Anotado.'),
          completeTask: () => fake('Hecha.'),
          sendSurvey: (i) =>
            fake(
              i.linkOnly ? 'Enlace listo.' : 'Encuesta enviada.',
              'http://localhost:3100/encuesta/escaparate-escaparate-escaparate-01',
            ),
        }}
      />
    </div>
  );
}
