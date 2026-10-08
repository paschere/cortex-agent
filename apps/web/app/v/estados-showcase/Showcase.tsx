'use client';

import { StatementsScreen } from '@/components/statements/StatementsScreen';
import type { StatementsScreenProps } from '@/components/statements/types';
import { useEffect } from 'react';

const wait = () => new Promise((r) => setTimeout(r, 450));

export function StatementsFixture({
  dark,
  failRefresh,
  ...props
}: Omit<StatementsScreenProps, 'actions'> & { dark: boolean; failRefresh?: boolean }) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8 md:py-7">
        <StatementsScreen
          {...props}
          actions={{
            async refresh() {
              await wait();
              if (failRefresh)
                return {
                  ok: false as const,
                  error:
                    'No pude leer el balance general de Siigo: el reporte llegó en un formato que no esperaba (de mentira).',
                };
              return {
                ok: true,
                note: 'Traje el balance general y el estado de resultados (de mentira).',
              };
            },
            async saveClasses() {
              await wait();
              return { ok: true, note: 'Guardado (de mentira).' };
            },
          }}
        />
      </main>
    </div>
  );
}
