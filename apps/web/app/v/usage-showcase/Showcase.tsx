'use client';

import { UsageCostSection } from '@/components/admin/UsageCostSection';
import type { UsageCostData } from '@/components/admin/UsageCostSection';
import { useEffect } from 'react';

export function UsageFixture({ data, dark }: { data: UsageCostData; dark: boolean }) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1100px] px-4 py-6 md:px-8 md:py-7">
        <UsageCostSection
          data={data}
          saveRate={async () => {
            await new Promise((r) => setTimeout(r, 400));
            return { ok: true, note: 'Tasa guardada (de mentira).' };
          }}
        />
      </main>
    </div>
  );
}
