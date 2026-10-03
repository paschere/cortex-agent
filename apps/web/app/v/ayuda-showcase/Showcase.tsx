'use client';

import { HelpButton, type HelpLoaders } from '@/components/help/HelpPanel';
import { PageHeader } from '@/components/ui/page-header';
import type { PanelArticle } from '@/lib/help/shape';
import { HandCoins } from 'lucide-react';
import { useMemo } from 'react';

/**
 * El panel «?» abierto sobre una pantalla de mentira, con cargadores que no
 * van al servidor: la ayuda de la ruta ya viene calculada y la búsqueda filtra
 * por título sin tildes (la búsqueda de verdad corre en el servidor).
 */
export function HelpPanelShowcase({
  screen,
  articles,
  searchable,
  sampleHits,
}: {
  screen: string | null;
  articles: PanelArticle[];
  searchable: PanelArticle[];
  sampleHits: PanelArticle[];
}) {
  const loaders = useMemo<HelpLoaders>(
    () => ({
      panel: async () => ({ screen, articles, supportEnabled: true }),
      search: async (query) => {
        const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
        if (fold(query) === 'aprobar factura') return sampleHits;
        return searchable.filter((a) => fold(`${a.title} ${a.summary}`).includes(fold(query)));
      },
    }),
    [screen, articles, searchable, sampleHits],
  );
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <header className="flex h-16 items-center gap-3 border-b border-border bg-surface px-4 md:px-8">
        <span className="font-bold text-ink">{screen ?? 'Cortex'}</span>
        <div className="ml-auto">
          <HelpButton defaultOpen loaders={loaders} />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 md:px-8">
        <PageHeader
          title={screen ?? 'Pantalla'}
          subtitle="Facturas de proveedores, revisión, aprobación y programa de pagos."
          icon={<HandCoins className="h-5 w-5" />}
        />
      </main>
    </div>
  );
}
