'use client';

import { mobileTabs, primaryActive } from '@/lib/nav-shape';
import { recordVisit } from '@/lib/nav-usage';
import { workspaceHref } from '@/lib/workspace-context';
import type { ModuleKey } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMobileSidebar } from './MobileSidebarContext';

/**
 * LA BARRA DE ABAJO DEL TELÉFONO.
 *
 * Cuatro puertas y «Más»: Chat, Hoy, Vistas y Aplicaciones, lo que se abre con
 * el pulgar varias veces al día. «Más» abre el menú lateral (`Sidebar`, en su
 * diálogo), que trae «Te espera» con sus contadores, las secciones y el resto
 * del producto: aquí no se esconde nada que antes estuviera.
 *
 * No es `position: fixed`: es el último hijo de la columna del layout, así que
 * el contenido (y el compositor del chat) se acortan en vez de quedar tapados.
 * El relleno inferior respeta la barra de inicio del iPhone instalado.
 */

export function MobileTabBar({
  organizationId,
  modulesOff,
}: {
  organizationId?: string;
  /** Módulos que la empresa apagó (0186): sus puertas no salen. */
  modulesOff?: ModuleKey[];
}) {
  // Chat, Hoy, Vistas y Aplicaciones; «Más» abre el menú lateral completo.
  const TABS = mobileTabs(modulesOff);
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
              'group/tab flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-sm text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              active ? 'text-ink' : 'text-ink-faint hover:text-ink',
            )}
          >
            <span
              className={clsx(
                'grid h-7 w-14 place-items-center rounded-pill transition-[background-color,transform] duration-150 group-active/tab:scale-95 motion-reduce:transition-none',
                active ? 'bg-primary-soft text-primary' : 'group-hover/tab:bg-surface-2',
              )}
            >
              <Icon className="h-5 w-5" strokeWidth={1.75} />
            </span>
            {tab.label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={() => mobile.setOpen(true)}
        aria-haspopup="dialog"
        className="group/tab flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-sm text-[11px] font-semibold text-ink-faint hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <span className="grid h-7 w-14 place-items-center rounded-pill transition-[background-color,transform] duration-150 group-active/tab:scale-95 group-hover/tab:bg-surface-2 motion-reduce:transition-none">
          <Menu className="h-5 w-5" strokeWidth={1.75} />
        </span>
        Más
      </button>
    </nav>
  );
}
