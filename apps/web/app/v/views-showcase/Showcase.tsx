'use client';

import { LiveViewCanvas } from '@/components/views/LiveViewCanvas';
import { ViewSkeleton } from '@/components/views/blocks/ViewChrome';
import { ViewBrandProvider } from '@/components/views/blocks/brand';
import type { ViewBrand } from '@/lib/branding/shape';
import type { ComputedView } from '@cortex/agent-tools';
import { useEffect, useMemo } from 'react';
import { BrandPanel } from '../../(app)/company/_components/BrandPanel';
import { PublicShell } from '../[token]/PublicShell';
import { SHOWCASE_SUBTITLE, SHOWCASE_TITLE, showcaseView } from './fixture';

/** Un logo inventado (una montaña y un camino), como SVG en línea: sin red. */
const LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f766e"/><path d="M8 46 26 20l9 12 6-8 15 22z" fill="#f59e0b"/><path d="M26 20l9 12-5 6z" fill="#fff" opacity=".35"/><path d="M22 54c6-6 14-8 22-8" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/></svg>',
)}`;

const BRANDS: Record<string, ViewBrand> = {
  andina: { name: 'Transportes Andinos', logoUrl: LOGO, primary: '#0f766e', secondary: '#f59e0b' },
  amarilla: { name: 'Taxis Amarillos', logoUrl: null, primary: '#facc15', secondary: '#1e3a8a' },
  ninguna: { name: 'Transportes Andinos', logoUrl: null, primary: null, secondary: null },
};

export function Showcase({
  screen = null,
  dark,
  brand,
  pages,
  empty,
  hero,
  inApp,
  panel,
  layout = null,
  look = null,
}: {
  /** Uno de los tipos de pantalla nuevos, ya calculado (`?pantalla=`). */
  screen?: { kind: string; title: string; subtitle: string; view: ComputedView } | null;
  dark: boolean;
  brand: string;
  pages: boolean;
  empty: boolean;
  hero: boolean;
  /** Como se ve adentro de la app: con el logo en la portada y sin la barra pública. */
  inApp: boolean;
  /** `marca`: la pantalla de la marca de /company; `cargando`: el esqueleto. */
  panel: string | null;
  /** `diseno=operario`: el diseño de una columna para la planta. */
  layout?: string | null;
  /** `estilo=fuerte|panel`: los estilos visuales. */
  look?: string | null;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  const view = useMemo(() => {
    const base = screen?.view ?? showcaseView({ pages, empty });
    const v = base.theme
      ? {
          ...base,
          theme: {
            ...base.theme,
            ...(layout === 'operario' ? { layout: 'operator' as const } : {}),
            ...(look === 'fuerte'
              ? { style: 'bold' as const }
              : look === 'panel'
                ? { style: 'dark-panel' as const }
                : {}),
          },
        }
      : base;
    if (!hero || !v.theme) return v;
    return {
      ...v,
      theme: {
        ...v.theme,
        header: 'hero' as const,
        cover:
          'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=1200&q=70&auto=format&fit=crop',
      },
    };
  }, [screen, pages, empty, hero, layout, look]);
  const chosen = BRANDS[brand] ?? (BRANDS.andina as ViewBrand);
  const canvas = (
    <LiveViewCanvas
      initial={view}
      target={{ kind: 'demo' }}
      dataUrl={screen ? `/v/views-showcase/data?pantalla=${screen.kind}` : null}
      heading={
        screen
          ? { title: screen.title, subtitle: screen.subtitle }
          : { title: SHOWCASE_TITLE, subtitle: SHOWCASE_SUBTITLE }
      }
      showBrand={inApp}
    />
  );
  if (panel === 'marca' || panel === 'cargando')
    return (
      <div className="cortex-workspace min-h-screen bg-canvas">
        <main className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-8 md:py-7">
          {panel === 'marca' ? (
            <BrandPanel
              initial={{ ...chosen, displayName: chosen.name }}
              canEdit
              workspaceName="Transportes Andinos S.A.S."
            />
          ) : (
            <ViewSkeleton />
          )}
        </main>
      </div>
    );
  if (inApp)
    return (
      <div className="cortex-workspace min-h-screen bg-canvas">
        <main className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-8 md:py-7">
          <ViewBrandProvider brand={chosen}>{canvas}</ViewBrandProvider>
        </main>
      </div>
    );
  return (
    // `.cortex-workspace` para que el tema oscuro de globals.css se pueda encender aquí.
    <div className="cortex-workspace">
      <PublicShell brand={chosen}>{canvas}</PublicShell>
    </div>
  );
}
