'use client';

import { BudgetScreen } from '@/components/budget/BudgetScreen';
import type { BudgetScreenProps } from '@/components/budget/types';
import { useEffect } from 'react';

const wait = () => new Promise((r) => setTimeout(r, 400));
const fake = async () => {
  await wait();
  return { ok: true as const, note: 'Guardado (de mentira).' };
};

export function BudgetFixture({
  dark,
  ...props
}: Omit<BudgetScreenProps, 'actions'> & { dark: boolean }) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8 md:py-7">
        <BudgetScreen
          {...props}
          actions={{ create: fake, setCells: fake, removeCategory: fake, setStatus: fake }}
        />
      </main>
    </div>
  );
}
