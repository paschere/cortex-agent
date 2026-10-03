'use client';

import { CloseScreen } from '@/components/close/CloseScreen';
import type { CloseScreenData } from '@/components/close/types';
import type { WritebackPreview } from '@cortex/agent-tools';
import { useEffect } from 'react';

const wait = () => new Promise((r) => setTimeout(r, 400));
const fake = async () => {
  await wait();
  return { ok: true as const, note: 'Hecho (de mentira).' };
};

const PREVIEW: WritebackPreview = {
  kind: 'compra',
  provider: 'siigo',
  label: 'Factura FEPA-451 de Papelería El Cóndor',
  date: '2026-09-12',
  amount: 1_190_000,
  currency: 'COP',
  counterparty: 'Papelería El Cóndor',
  entries: [
    {
      account: '51959501',
      accountName: 'Diversos',
      accountSource: 'categoria',
      costCenter: '235',
      description: 'Compra Papelería El Cóndor FEPA-451',
      debit: 1_000_000,
      credit: 0,
    },
    {
      account: '240810',
      accountName: 'IVA descontable',
      accountSource: 'defecto',
      costCenter: null,
      description: 'IVA FEPA-451',
      debit: 190_000,
      credit: 0,
    },
    {
      account: '236525',
      accountName: 'Retención en la fuente – servicios',
      accountSource: 'defecto',
      costCenter: null,
      description: 'Retefuente FEPA-451',
      debit: 0,
      credit: 25_000,
    },
    {
      account: '220505',
      accountName: 'Proveedores nacionales',
      accountSource: 'defecto',
      costCenter: null,
      description: 'Por pagar FEPA-451',
      debit: 0,
      credit: 1_165_000,
    },
  ],
  problems: [],
  warnings: [
    '3 cuentas usan el defecto de Cortex (240810, 236525, 220505): confírmalas con tu plan de cuentas en /cierre → Cuentas.',
  ],
};

export function CloseFixture({
  dark,
  tab,
  data,
}: { dark: boolean; tab: 'mes' | 'registrar' | 'cuentas' | 'historial'; data: CloseScreenData }) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8 md:py-7">
        <CloseScreen
          tab={tab}
          data={data}
          actions={{
            markTask: fake,
            assignTask: fake,
            closePeriod: fake,
            reopenPeriod: fake,
            openOverride: fake,
            preview: async () => {
              await wait();
              return { ok: true as const, preview: PREVIEW };
            },
            register: async (items) => {
              await wait();
              return {
                ok: true as const,
                note: 'Registrado (de mentira).',
                results: items.map((i) => ({
                  sourceId: i.sourceId,
                  ok: true,
                  message: 'Registrada en Siigo → FC-2-22',
                })),
              };
            },
            discard: fake,
            restore: fake,
            saveMapping: fake,
            resetMapping: fake,
          }}
        />
      </main>
    </div>
  );
}
