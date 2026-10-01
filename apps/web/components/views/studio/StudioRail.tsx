'use client';

import { clsx } from 'clsx';
import {
  Database,
  Files,
  Layers,
  type LucideIcon,
  PanelLeftClose,
  Plus,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useEffect, useRef } from 'react';

/**
 * LA COLUMNA IZQUIERDA DEL ESTUDIO, Y SU VERSIÓN DE TELÉFONO.
 *
 * Escritorio: una tira de iconos (Agregar, Datos, Capas y, si la vista tiene
 * páginas, Páginas) con el panel de la pestaña al lado. Tocar la pestaña
 * abierta pliega el panel; el lienzo gana ese ancho.
 *
 * Teléfono: no caben tres columnas. El lienzo ocupa la pantalla, abajo hay una
 * barra de pestañas fija (las mismas, más «Ajustes», que abre el inspector) y
 * cada pestaña sube como hoja desde abajo, con un velo que la cierra.
 */

export type RailTab = 'add' | 'data' | 'layers' | 'pages';

export const RAIL_TABS: Array<{ id: RailTab; label: string; icon: LucideIcon; hint: string }> = [
  { id: 'add', label: 'Agregar', icon: Plus, hint: 'Piezas para arrastrar al lienzo' },
  { id: 'data', label: 'Datos', icon: Database, hint: 'Tus tablas y sus campos' },
  { id: 'layers', label: 'Capas', icon: Layers, hint: 'Los bloques en orden' },
  { id: 'pages', label: 'Páginas', icon: Files, hint: 'Las páginas de la vista' },
];

export function StudioRail({
  tab,
  tabs,
  onTab,
  children,
}: {
  tab: RailTab | null;
  tabs: RailTab[];
  onTab: (tab: RailTab | null) => void;
  children: React.ReactNode;
}) {
  const current = RAIL_TABS.find((t) => t.id === tab);
  return (
    <div className="hidden h-full shrink-0 lg:flex">
      <div
        role="tablist"
        aria-label="Herramientas"
        aria-orientation="vertical"
        className="flex w-16 flex-col items-center gap-1 border-r border-border bg-surface/60 py-3"
      >
        {RAIL_TABS.filter((t) => tabs.includes(t.id)).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="studio-rail-panel"
            title={t.hint}
            onClick={() => onTab(tab === t.id ? null : t.id)}
            className={clsx(
              'flex w-14 flex-col items-center gap-0.5 rounded-sm px-1 py-2 text-micro font-semibold transition-colors duration-150',
              tab === t.id
                ? 'bg-primary-soft text-primary'
                : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            <t.icon className="h-[18px] w-[18px]" aria-hidden />
            {t.label}
          </button>
        ))}
      </div>
      {current && (
        <div
          id="studio-rail-panel"
          role="tabpanel"
          aria-label={current.label}
          className="flex w-72 flex-col border-r border-border bg-surface/80"
        >
          <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3.5">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">{current.label}</h2>
              <p className="truncate text-micro text-ink-faint">{current.hint}</p>
            </div>
            <button
              type="button"
              onClick={() => onTab(null)}
              aria-label="Plegar el panel"
              title="Plegar el panel"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-pill text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
          <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-2">
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

/** La barra de pestañas de abajo, en el teléfono y la tableta. */
export function StudioDock({
  tabs,
  active,
  onTab,
  onSettings,
  settingsActive,
}: {
  tabs: RailTab[];
  active: RailTab | null;
  onTab: (tab: RailTab) => void;
  onSettings: () => void;
  settingsActive: boolean;
}) {
  return (
    <nav
      aria-label="Herramientas"
      className="flex shrink-0 items-stretch justify-around border-t border-border bg-surface/95 px-2 pb-[max(env(safe-area-inset-bottom),0.25rem)] pt-1 backdrop-blur-md lg:hidden"
    >
      {RAIL_TABS.filter((t) => tabs.includes(t.id)).map((t) => (
        <button
          key={t.id}
          type="button"
          aria-pressed={active === t.id}
          onClick={() => onTab(t.id)}
          className={clsx(
            'flex min-w-14 flex-1 flex-col items-center gap-0.5 rounded-sm py-1.5 text-micro font-semibold transition-colors duration-150',
            active === t.id ? 'text-primary' : 'text-ink-muted',
          )}
        >
          <t.icon className="h-5 w-5" aria-hidden />
          {t.label}
        </button>
      ))}
      <button
        type="button"
        aria-pressed={settingsActive}
        onClick={onSettings}
        className={clsx(
          'flex min-w-14 flex-1 flex-col items-center gap-0.5 rounded-sm py-1.5 text-micro font-semibold transition-colors duration-150',
          settingsActive ? 'text-primary' : 'text-ink-muted',
        )}
      >
        <SlidersHorizontal className="h-5 w-5" aria-hidden />
        Ajustes
      </button>
    </nav>
  );
}

/** Una pestaña de la columna izquierda, como hoja que sube en el teléfono. */
export function StudioSheet({
  tab,
  onClose,
  children,
}: {
  tab: RailTab | null;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const current = RAIL_TABS.find((t) => t.id === tab);
  useEffect(() => {
    if (tab) heading.current?.focus();
  }, [tab]);
  return (
    <>
      {tab && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: el velo es para el dedo; el teclado cierra con Escape o con «Cerrar».
        <div
          aria-hidden
          onClick={onClose}
          className="fixed inset-0 z-40 animate-veil bg-canvas/60 backdrop-blur-[2px] lg:hidden"
        />
      )}
      <section
        aria-label={current?.label ?? 'Herramientas'}
        className={clsx(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-card border border-border bg-surface shadow-pop transition-transform duration-200 ease-out motion-reduce:transition-none lg:hidden',
          tab ? 'translate-y-0' : 'invisible translate-y-full',
        )}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-pill bg-border-strong" aria-hidden />
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 pb-2.5 pt-2">
          <div className="min-w-0">
            <h2 ref={heading} tabIndex={-1} className="text-sm font-semibold text-ink outline-none">
              {current?.label}
            </h2>
            <p className="truncate text-micro text-ink-faint">{current?.hint}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="grid h-8 w-8 place-items-center rounded-pill text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {tab && children}
        </div>
      </section>
    </>
  );
}
