'use client';

import { mobileTabs, primaryActive } from '@/lib/nav-shape';
import { recordVisit } from '@/lib/nav-usage';
import { workspaceHref } from '@/lib/workspace-context';
import type { ModuleKey } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Menu, Star } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMobileSidebar } from './MobileSidebarContext';

/**
 * LA BARRA DE ABAJO DEL TELÉFONO («cuaderno»).
 *
 * Hoy (con su estrella amarilla), Chat, Aplicaciones y Vistas: lo que se abre con
 * el pulgar varias veces al día. «Más» abre el menú lateral (`Sidebar`, en su
 * diálogo), que trae las secciones y el resto del producto: aquí no se esconde
 * nada que antes estuviera. La pestaña activa va en tinta y en negrita, sin
 * píldora; el resto en gris cálido.
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
  const TABS = mobileTabs(modulesOff);
  const path = usePathname();
  const mobile = useMobileSidebar();
  const ring = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
  return (
    <nav
      aria-label="Navegación rápida"
      className="grid shrink-0 grid-cols-5 bg-canvas px-1.5 pt-2 print:hidden md:hidden"
      style={{ paddingBottom: 'max(10px, env(safe-area-inset-bottom))' }}
    >
      {TABS.map((tab) => {
        const active = primaryActive(path, tab);
        const Icon = tab.icon;
        const star = tab.href === '/piloto';
        return (
          <Link
            key={tab.href}
            href={organizationId ? workspaceHref(organizationId, tab.href) : tab.href}
            aria-current={active ? 'page' : undefined}
            onClick={() => recordVisit(tab.href)}
            className={clsx(
              'group/tab flex min-h-12 flex-col items-center justify-center gap-1 rounded-sm text-[11px] transition-colors motion-reduce:transition-none',
              ring,
              active ? 'font-bold text-ink' : 'font-medium text-ink-faint hover:text-ink',
            )}
          >
            {star ? (
              <Star
                className="h-5 w-5 fill-star text-star transition-transform group-active/tab:scale-90 motion-reduce:transition-none"
                strokeWidth={1.25}
                aria-hidden
              />
            ) : (
              <Icon
                className={clsx(
                  'h-5 w-5 transition-transform group-active/tab:scale-90 motion-reduce:transition-none',
                  active && 'text-primary',
                )}
                strokeWidth={active ? 2 : 1.75}
              />
            )}
            {tab.label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={() => mobile.setOpen(true)}
        aria-haspopup="dialog"
        className={clsx(
          'group/tab flex min-h-12 flex-col items-center justify-center gap-1 rounded-sm text-[11px] font-medium text-ink-faint hover:text-ink',
          ring,
        )}
      >
        <Menu
          className="h-5 w-5 transition-transform group-active/tab:scale-90 motion-reduce:transition-none"
          strokeWidth={1.75}
        />
        Más
      </button>
    </nav>
  );
}
