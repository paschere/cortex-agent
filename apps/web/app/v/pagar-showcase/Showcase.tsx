'use client';

import { PayablesScreen } from '@/components/payables/PayablesScreen';
import { PageHeader } from '@/components/ui/page-header';
import type { PayablesScreenData } from '@/lib/payables/view';
import { HandCoins } from 'lucide-react';
import { useEffect } from 'react';

/** «Por pagar» con datos inventados. Las acciones contestan en pantalla sin tocar ninguna base. */

const fake = async (note: string) => {
  await new Promise((r) => setTimeout(r, 300));
  return { ok: true as const, note: `(escaparate) ${note}` };
};

export function PagarFixture({
  dark,
  tab,
  data,
}: {
  dark: boolean;
  tab: 'bandeja' | 'programa' | 'proveedores';
  data: PayablesScreenData;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
        <PageHeader
          title="Por pagar"
          subtitle="Las facturas de tus proveedores, de que llegan a que se pagan: Cortex las revisa, tú apruebas, la caja sugiere el día. Cortex nunca paga."
          icon={<HandCoins className="h-5 w-5" aria-hidden />}
        />
        <PayablesScreen
          tab={tab}
          data={data}
          actions={{
            approve: () => fake('Aprobadas.'),
            reject: () => fake('Rechazadas.'),
            reopen: () => fake('Reabiertas.'),
            schedule: () => fake('Programadas contra la caja.'),
            suggest: async (ids) => ({
              ok: true,
              suggestions: ids.map((id) => ({
                id,
                date: '2026-10-19',
                lateDays: 3,
                belowMinimum: false,
                reason:
                  'Vence el 16 oct, pero pagarla esa semana dejaba la caja debajo del mínimo; la corro al 19 oct (3 días tarde).',
              })),
            }),
            markPaid: () => fake('Pagada.'),
            recheck: () => fake('Revisada otra vez.'),
            record: () => fake('Anotada.'),
            saveSupplier: () => fake('Guardado.'),
            checkMail: () => fake('Revisé el correo.'),
          }}
        />
      </div>
    </div>
  );
}
