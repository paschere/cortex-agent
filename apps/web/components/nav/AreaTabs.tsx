'use client';

import { areaTabsFor } from '@/lib/nav-shape';
import { recordVisit } from '@/lib/nav-usage';
import { workspaceHref } from '@/lib/workspace-context';
import type { ModuleKey } from '@cortex/agent-tools';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import { ChevronDown, Star } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useFavorites } from './favorites';

/**
 * LAS PESTAÑAS DE UN ÁREA, ARRIBA DE CADA PÁGINA QUE LE PERTENECE.
 *
 * El rail sólo lleva a la primera pantalla de Plata, Operación, Equipo… y esta
 * barra enseña las demás (la que está abierta, subrayada). Se monta una vez en
 * `app/(app)/layout.tsx`: lee la dirección, pregunta a `areaTabsFor`
 * (`lib/nav-shape.ts`, que es quien sabe a qué área pertenece cada ruta) y no
 * pinta nada si la página no es de ningún área. Los módulos apagados no dejan
 * pestañas colgando.
 *
 * En pantalla ancha caben seis: el resto se agrupa en «Más ▾» (y la abierta
 * siempre se ve). En el teléfono la fila se desliza con el dedo, con todas.
 * La estrella del final fija la página abierta en «Favoritos» del rail.
 */

const VISIBLE = 6;
const RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-0';

export function AreaTabs({
  admin,
  modulesOff,
  organizationId,
  userKey,
  pathOverride,
}: {
  admin: boolean;
  modulesOff: ModuleKey[];
  organizationId?: string;
  /** Con qué llave se guardan los favoritos de esta persona. */
  userKey: string;
  /** Sólo para la página de pruebas. */
  pathOverride?: string;
}) {
  const livePath = usePathname();
  const path = pathOverride ?? livePath;
  const favs = useFavorites(userKey, organizationId ?? 'global');
  const view = areaTabsFor(path, { admin, modulesOff });
  // Una sola pestaña no es una barra: no hay a dónde ir.
  if (!view || view.tabs.length < 2) return null;

  const { area, tabs, active } = view;
  const hrefOf = (href: string) => (organizationId ? workspaceHref(organizationId, href) : href);
  const shown = tabs.slice(0, VISIBLE);
  const overflow = tabs.slice(VISIBLE);
  const current = tabs.find((t) => t.href === active);
  if (current && !shown.includes(current) && shown.length > 0) {
    // La abierta no se esconde: ocupa el último sitio visible.
    const swapped = shown.pop();
    shown.push(current);
    if (swapped) overflow.unshift(swapped);
    overflow.splice(
      overflow.findIndex((t) => t === current),
      1,
    );
  }

  const tabClass = (on: boolean) =>
    clsx(
      'relative inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-[14px] transition-colors motion-reduce:transition-none',
      RING,
      on
        ? 'font-semibold text-ink after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary'
        : 'font-medium text-ink-muted hover:text-ink',
    );

  // «Fijar esta página»: la etiqueta es la de la pestaña, o el título del navegador cuando se
  // está dentro de un detalle (una tabla concreta). Se resuelve al pulsar, no al pintar.
  const pinNow = () => {
    const exact = current && (path === current.href || path === `${current.href}/`);
    const fromTitle =
      !exact && typeof document !== 'undefined'
        ? document.title.split(/[·|—]/)[0]?.trim()
        : undefined;
    favs.toggle({ href: path, label: fromTitle || current?.label || area.label });
  };
  const pinned = favs.has(path);

  return (
    <nav
      aria-label={`${area.label}: pantallas`}
      className="-mx-4 mb-5 flex items-center border-b border-border px-4 md:-mx-8 md:mb-6 md:px-8 print:hidden"
    >
      <span className="title-display mr-3 hidden shrink-0 !text-[20px] !leading-none text-ink xl:block xl:!text-[20px]">
        {area.label}
      </span>
      {/* Teléfono: todas, con deslizamiento. */}
      <div className="scroll-slim -mx-1 flex min-w-0 flex-1 overflow-x-auto md:hidden">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={hrefOf(t.href)}
            aria-current={t.href === active ? 'page' : undefined}
            onClick={() => recordVisit(t.href)}
            className={tabClass(t.href === active)}
          >
            {t.label}
          </Link>
        ))}
      </div>
      {/* Escritorio: seis y «Más ▾». */}
      <div className="hidden min-w-0 flex-1 items-center md:flex">
        {shown.map((t) => (
          <Link
            key={t.href}
            href={hrefOf(t.href)}
            aria-current={t.href === active ? 'page' : undefined}
            onClick={() => recordVisit(t.href)}
            className={tabClass(t.href === active)}
          >
            {t.label}
          </Link>
        ))}
        {overflow.length > 0 && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className={clsx(tabClass(false), 'data-[state=open]:text-ink')}
                aria-label={`Más pantallas de ${area.label}`}
              >
                Más
                <ChevronDown aria-hidden className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="start"
                sideOffset={4}
                className="z-[80] min-w-52 rounded-[16px] bg-surface p-2 shadow-pop"
              >
                {overflow.map((t) => (
                  <DropdownMenu.Item key={t.href} asChild>
                    <Link
                      href={hrefOf(t.href)}
                      onClick={() => recordVisit(t.href)}
                      className="flex h-9 cursor-pointer items-center rounded-[10px] px-2.5 text-[14px] text-ink-muted outline-none data-[highlighted]:bg-canvas data-[highlighted]:text-ink"
                    >
                      {t.label}
                    </Link>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>
      <button
        type="button"
        aria-pressed={pinned}
        aria-label={pinned ? 'Quitar esta página de favoritos' : 'Fijar esta página en favoritos'}
        title={pinned ? 'Quitar de favoritos' : 'Fijar en favoritos'}
        onClick={pinNow}
        className={clsx(
          'ml-2 grid h-8 w-8 shrink-0 place-items-center rounded-[8px] text-ink-faint transition-colors hover:bg-canvas hover:text-ink motion-reduce:transition-none',
          RING,
        )}
      >
        <Star
          className={clsx('h-4 w-4', pinned && 'fill-star text-star')}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>
    </nav>
  );
}
