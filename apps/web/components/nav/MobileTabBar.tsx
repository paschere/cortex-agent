'use client';

import { primaryActive, primaryNav } from '@/lib/nav-shape';
import { recordVisit } from '@/lib/nav-usage';
import { workspaceHref } from '@/lib/workspace-context';
import { clsx } from 'clsx';
import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMobileSidebar } from './MobileSidebarContext';

/**
 * LA BARRA DE ABAJO DEL TELÉFONO.
 *
 * Cuatro puertas y «Más». Las cuatro son las del diseño móvil — Inicio, Chat,
 * Procesos y Vistas —, lo que se abre con el pulgar varias veces al día. «Más»
 * abre el menú lateral de siempre (`Sidebar`, en su diálogo), que trae Datos,
 * Equipo, «Te espera» con sus contadores y el resto del producto: aquí no se
 * esconde nada que antes estuviera.
 *
 * No es `position: fixed`: es el último hijo de la columna del layout, así que
 * el contenido (y el compositor del chat) se acortan en vez de quedar tapados.
 * El relleno inferior respeta la barra de inicio del iPhone instalado.
 */

// Las cuatro primeras puertas de `primaryNav`, que no dependen del rol.
const TABS = primaryNav({ admin: false, founder: false }).slice(0, 4);

export function MobileTabBar({ organizationId }: { organizationId?: string }) {
  const path = usePathname();
  const mobile = useMobileSidebar();
  return (
    <nav
      aria-label="Navegación rápida"
      className="grid shrink-0 grid-cols-5 border-t border-border bg-surface px-1 pt-1.5 print:hidden md:hidden"
      style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}
    >
      {TABS.map((tab) => {
        const active = primaryActive(path, tab);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={organizationId ? workspaceHref(organizationId, tab.href) : tab.href}
            aria-current={active ? 'page' : undefined}
            onClick={() => recordVisit(tab.href)}
            className={clsx(
              'flex min-h-12 flex-col items-center justify-center gap-1 rounded-sm text-micro font-bold',
              active ? 'text-primary' : 'text-ink-faint hover:text-ink',
            )}
          >
            <span
              className={clsx(
                'grid h-7 w-12 place-items-center rounded-pill transition-colors',
                active && 'bg-primary-soft',
              )}
            >
              <Icon className="h-[22px] w-[22px]" strokeWidth={2} />
            </span>
            {tab.label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={() => mobile.setOpen(true)}
        aria-haspopup="dialog"
        className="flex min-h-12 flex-col items-center justify-center gap-1 rounded-sm text-micro font-bold text-ink-faint hover:text-ink"
      >
        <span className="grid h-7 w-12 place-items-center rounded-pill">
          <Menu className="h-[22px] w-[22px]" strokeWidth={2} />
        </span>
        Más
      </button>
    </nav>
  );
}
