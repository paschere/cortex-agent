'use client';

import { ViewCanvas } from '@/components/views/ViewCanvas';
import { ViewBrandProvider } from '@/components/views/blocks/brand';
import type { ViewBrand } from '@/lib/branding/shape';
import type { ComputedView } from '@cortex/agent-tools';
import { DesignSection } from '@/components/views/editor/DesignSection';
import type { ViewBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { useEffect, useState } from 'react';

const BRANDS: Record<string, ViewBrand> = {
  andina: { name: 'Transportes Andinos', logoUrl: null, primary: '#0f766e', secondary: '#f59e0b' },
  amarilla: { name: 'Taxis Amarillos', logoUrl: null, primary: '#facc15', secondary: '#1e3a8a' },
  ninguna: { name: 'Transportes Andinos', logoUrl: null, primary: null, secondary: null },
};

export function Showcase({
  section,
  sections,
  view,
  dark,
  brand,
  layout,
}: { section: string; sections: readonly string[]; view: ComputedView; dark: boolean; brand: string; layout: string | null }) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  const [demo, setDemo] = useState<ViewBlock>({ id: 'm', type: 'metric', title: 'Ventas', tracker: 'ventas' } as unknown as ViewBlock);
  const chosen = BRANDS[brand] ?? (BRANDS.andina as ViewBrand);
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8">
        <nav aria-label="Secciones" className="mb-6 flex flex-wrap gap-1.5">
          {sections.map((s) => (
            <a
              key={s}
              href={`?seccion=${s}${dark ? '&modo=oscuro' : ''}${layout ? `&diseno=${layout}` : ''}&marca=${brand}`}
              className={clsx(
                'rounded-pill px-3 py-1 text-xs font-semibold',
                s === section ? 'bg-primary text-white' : 'bg-surface-2 text-ink-muted',
              )}
            >
              {s}
            </a>
          ))}
        </nav>
        {section === 'editor' && (
          <div className="mb-6 max-w-sm rounded-card border border-border bg-surface p-4">
            <DesignSection block={demo} onChange={setDemo} />
          </div>
        )}
        <ViewBrandProvider brand={chosen}>
          <ViewCanvas view={view} target={{ kind: 'demo' }} />
        </ViewBrandProvider>
      </main>
    </div>
  );
}
