'use client';

import { WelcomeTour } from '@/components/tour/WelcomeTour';
import { samplePulseView } from '@/components/tour/sample-data';
import { type ViewSummary, ViewsLibrary } from '@/components/views/gallery/ViewsLibrary';
import type { ViewBrand } from '@/lib/branding/shape';
import { useEffect, useMemo } from 'react';
import { BrandHeader } from '../../(app)/dashboard/_components/BrandHeader';
import { PinnedViewsList } from '../../(app)/dashboard/_components/PinnedViewsList';
import { showcaseView } from '../views-showcase/fixture';

const LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f766e"/><path d="M8 46 26 20l9 12 6-8 15 22z" fill="#f59e0b"/><path d="M22 54c6-6 14-8 22-8" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/></svg>',
)}`;

const BRANDS: Record<string, ViewBrand | null> = {
  andina: { name: 'Transportes Andinos', logoUrl: LOGO, primary: '#0f766e', secondary: '#f59e0b' },
  amarilla: { name: 'Taxis Amarillos', logoUrl: null, primary: '#facc15', secondary: '#1e3a8a' },
  ninguna: null,
};

const SHARE = {
  version: 1,
  visibility: 'workspace' as const,
  pinned: true,
  publicUrl: null,
  expiresAt: null,
  opens: 0,
  canManage: true,
  canDelete: true,
  shareBlocked: null,
};

function summary(
  id: string,
  name: string,
  blocks: ViewSummary['blocks'],
  accent: string,
  pinned: boolean,
): ViewSummary {
  return {
    id,
    slug: id,
    name,
    description: 'Vista de ejemplo para el escaparate.',
    blocks,
    accent,
    kinds: ['Cifra', 'Gráfico', 'Tabla'],
    pinned,
    visibility: 'workspace',
    expired: false,
    mine: true,
    updatedAt: '2026-10-01T18:00:00.000Z',
    createdAt: '2026-09-01T18:00:00.000Z',
    edited: 'hace 1 día',
    editor: 'ti',
    share: { ...SHARE, id, name, pinned },
  };
}

export function TourFixture({
  brand: brandKey,
  step,
  dark,
  library,
}: {
  brand: string;
  step: number | null;
  dark: boolean;
  library: boolean;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  const brand = brandKey in BRANDS ? (BRANDS[brandKey] ?? null) : (BRANDS.andina ?? null);

  const pinned = useMemo(() => {
    const pulse = samplePulseView();
    const ops = showcaseView();
    const opsBlocks = ops.blocks.filter((b) => b.type !== 'form' && b.type !== 'text');
    return [
      {
        view: { id: 'pulso', slug: 'pulso_empresa', name: 'Pulso de la empresa' },
        computed: { ...pulse, blocks: pulse.blocks.slice(0, 6) },
        hidden: Math.max(pulse.blocks.length - 6, 0),
      },
      {
        view: { id: 'operacion', slug: 'operacion', name: 'Así va la operación' },
        computed: { ...ops, filtersBar: [], alerts: [], blocks: opsBlocks.slice(0, 4) },
        hidden: Math.max(opsBlocks.length - 4, 0),
      },
    ];
  }, []);

  const summaries = useMemo(() => {
    const shape = (v: { blocks: Array<{ type: string; width: string }> }) =>
      v.blocks.map((b) => ({ type: b.type, width: b.width }));
    return [
      summary('pulso', 'Pulso de la empresa', shape(samplePulseView()), 'primary', true),
      summary('operacion', 'Así va la operación', shape(showcaseView()), 'primary', false),
      summary(
        'cartera',
        'Cartera por cliente',
        shape(samplePulseView()).slice(1, 6),
        'rose',
        false,
      ),
    ];
  }, []);

  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-8 md:py-7">
        {library ? (
          <ViewsLibrary views={summaries} suggestions={[]} brand={brand} />
        ) : (
          <>
            <section className="mb-5 pt-1">
              {brand && <BrandHeader brand={brand} />}
              <p className="tabular text-sm font-semibold capitalize text-ink-faint">
                jueves, 2 de octubre
              </p>
              <h1 className="mt-1 text-2xl font-extrabold leading-tight tracking-tight text-ink sm:text-3xl">
                Hola, Laura. ¿Qué resolvemos hoy?
              </h1>
              <p className="mt-1.5 text-sm text-ink-faint">Nada te espera por ahora.</p>
            </section>
            <WelcomeTour
              userId="fixture"
              brand={brand}
              defaultOpen={step !== null}
              startAt={step ?? 0}
              ignoreMemory
            />
            <PinnedViewsList entries={pinned} brand={brand} />
          </>
        )}
      </main>
    </div>
  );
}
