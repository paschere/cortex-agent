'use client';

import { ViewCanvas } from '@/components/views/ViewCanvas';
import { ViewBrandProvider } from '@/components/views/blocks/brand';
import type { ViewBrand } from '@/lib/branding/shape';
import type { ComputedView } from '@cortex/agent-tools';
import { useEffect } from 'react';

const BRANDS: Record<string, ViewBrand> = {
  andina: { name: 'Groundflex', logoUrl: null, primary: '#0f766e', secondary: '#f59e0b' },
  ninguna: { name: 'Groundflex', logoUrl: null, primary: null, secondary: null },
};

export function HojaShowcase({
  view,
  title,
  subtitle,
  dark,
  brand,
}: { view: ComputedView; title: string; subtitle: string; dark: boolean; brand: string }) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  const chosen = BRANDS[brand] ?? (BRANDS.andina as ViewBrand);
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-8">
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        <p className="mb-5 mt-1 text-sm text-ink-muted">{subtitle}</p>
        <ViewBrandProvider brand={chosen}>
          <ViewCanvas view={view} target={{ kind: 'demo' }} />
        </ViewBrandProvider>
      </main>
    </div>
  );
}
