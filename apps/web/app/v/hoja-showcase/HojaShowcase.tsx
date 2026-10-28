'use client';

import { LiveViewCanvas } from '@/components/views/LiveViewCanvas';
import { ViewBrandProvider } from '@/components/views/blocks/brand';
import { FormDataSourceProvider, type RelationOption } from '@/components/views/blocks/form-data-source';
import type { ViewBrand } from '@/lib/branding/shape';
import type { ComputedView } from '@cortex/agent-tools';
import { useEffect, useMemo } from 'react';

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
  options,
  dataUrl,
}: {
  view: ComputedView;
  title: string;
  subtitle: string;
  dark: boolean;
  brand: string;
  /** Opciones de ejemplo de cada relación (por clave de campo). */
  options: Record<string, RelationOption[]>;
  dataUrl: string;
}) {
  const data = useMemo(
    () => ({
      relation: {
        search: async (field: string, q: string) => {
          const fold = (t: string) => t.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
          const needle = fold(q.trim());
          await new Promise((r) => setTimeout(r, 80));
          return (options[field] ?? []).filter((o) => !needle || fold(`${o.label} ${o.detail ?? ''}`).includes(needle));
        },
        // «+ Crear «texto»»: igual que en producción, no duplica por nombre.
        create: async (field: string, label: string) => {
          await new Promise((r) => setTimeout(r, 120));
          const list = (options[field] ??= []);
          const fold = (t: string) => t.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
          const same = list.find((o) => fold(o.label) === fold(label));
          if (same) return same;
          const made = { id: `00000000-0000-4000-8000-${String(900 + list.length).padStart(12, '0')}`, label };
          list.push(made);
          return made;
        },
      },
    }),
    [options],
  );
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
          <FormDataSourceProvider value={data}>
            <LiveViewCanvas initial={view} target={{ kind: 'demo' }} dataUrl={dataUrl} />
          </FormDataSourceProvider>
        </ViewBrandProvider>
      </main>
    </div>
  );
}
