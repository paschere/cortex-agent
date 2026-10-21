'use client';

import { CarteraScreen } from '@/components/cartera/CarteraScreen';
import { PageHeader } from '@/components/ui/page-header';
import type { CarteraModel } from '@cortex/agent-tools/src/payments/cartera';
import { Banknote, Sparkles } from 'lucide-react';
import { useEffect } from 'react';

/** Cartera con datos inventados. Emparejar contesta en pantalla sin tocar ninguna base. */
export function CarteraShowcase({
  dark,
  plazo,
  model,
}: {
  dark: boolean;
  plazo: number | null;
  model: CarteraModel;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  const modo = dark ? '&modo=oscuro' : '';
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <div className="mx-auto max-w-[1320px] space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <PageHeader
          title="Cartera y pagos"
          subtitle="Quién te debe, cuánto está vencido y qué se espera cobrar. Los saldos son los de tu programa contable."
          icon={<Banknote className="h-5 w-5" aria-hidden />}
          actions={
            <span className="inline-flex min-h-11 items-center gap-2 rounded-pill bg-primary px-5 text-sm font-bold text-white">
              <Sparkles className="h-4 w-4" aria-hidden />
              Pregúntale a Cortex sobre la cartera
            </span>
          }
        />
        <CarteraScreen
          model={model}
          plazo={plazo}
          plazoHref={(d) => `/v/cartera-showcase?${d ? `plazo=${d}` : ''}${modo}`}
          askHref="/chat"
          actions={{
            match: async () => {
              await new Promise((r) => setTimeout(r, 300));
              return { ok: true, note: '(escaparate) Atado a la factura bajo tu nombre.' };
            },
          }}
        />
      </div>
    </div>
  );
}
