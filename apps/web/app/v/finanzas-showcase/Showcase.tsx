'use client';

import { FinanceDashboard } from '@/components/finance/FinanceDashboard';
import type { FinanceActions } from '@/components/finance/types';
import type { FinanceDashboard as Data } from '@/lib/finance/dashboard-shape';
import { useEffect } from 'react';

/** Acciones de mentira: contestan como el servidor, sin guardar nada. */
const wait = () => new Promise((r) => setTimeout(r, 400));
const ACTIONS: FinanceActions = {
  async updateBalance(input) {
    await wait();
    return { ok: true, note: `Actualicé el saldo de «${input.account}» (de mentira).` };
  },
  async saveScenario(input) {
    await wait();
    return { ok: true, note: `Guardé «${input.label}» (de mentira).`, id: 'esc-nexa' };
  },
  async deleteScenario() {
    await wait();
    return { ok: true, note: 'Borré el escenario (de mentira).' };
  },
  async declareRecurring(input) {
    await wait();
    return { ok: true, note: `Agregué «${input.label}» (de mentira).` };
  },
  async decideRecurring(input) {
    await wait();
    return {
      ok: true,
      note:
        input.status === 'confirmed' ? 'Confirmado (de mentira).' : 'Ya no es fijo (de mentira).',
    };
  },
  async saveMinimumCash(input) {
    await wait();
    return {
      ok: true,
      note: input.amount
        ? `Guardé ${input.amount} como caja mínima de la empresa (de mentira).`
        : 'Quité la caja mínima de la empresa (de mentira).',
    };
  },
};

export function FinanzasFixture({ dark, data, self }: { dark: boolean; data: Data; self: string }) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-8 md:py-7">
        <FinanceDashboard
          data={data}
          actions={ACTIONS}
          links={{
            self,
            chat: '/chat',
            payments: '/payments',
            bankImport: '/payments#extractos',
            accounting: '/integrations#programas-contables',
          }}
          documents={
            <details className="rounded-card border border-border bg-surface px-6 py-4 shadow-card">
              <summary className="cursor-pointer text-lg font-extrabold text-ink">
                Documentos por clasificar
              </summary>
              <p className="mt-2 text-sm text-ink-muted">
                En la página real aquí va la clasificación de documentos de siempre.
              </p>
            </details>
          }
        />
      </main>
    </div>
  );
}
