'use client';

import { brandCssVars } from '@/lib/branding/colors';
import type { ViewBrand } from '@/lib/branding/shape';
import { clsx } from 'clsx';
import { createContext, useContext, useMemo, useState } from 'react';

/**
 * LA MARCA DE LA EMPRESA DENTRO DE UNA VISTA (migración 0170).
 *
 * Quien monta la vista (la página de adentro, el enlace público, el estudio)
 * la pone en contexto con `ViewBrandProvider`; el lienzo la lee y envuelve los
 * bloques en `.cortex-brand` con las variables de lib/branding/colors.ts. Los
 * bloques no saben de marcas: siguen pintando `bg-primary`, `text-primary`,
 * `fill-…`, y es la hoja components/views/views.css la que hace que, dentro de
 * ese envoltorio, «primary» sea el color de la empresa con el contraste ya
 * resuelto, en claro y en oscuro.
 *
 * Sin proveedor (Inicio, la miniatura, el lienzo del editor sin marca) todo se
 * ve con el índigo de Cortex, como siempre.
 */

const BrandContext = createContext<ViewBrand | null>(null);

export function ViewBrandProvider({
  brand,
  children,
}: {
  brand: ViewBrand | null | undefined;
  children: React.ReactNode;
}) {
  return <BrandContext.Provider value={brand ?? null}>{children}</BrandContext.Provider>;
}

export function useViewBrand(): ViewBrand | null {
  return useContext(BrandContext);
}

/** Clase y variables del envoltorio con marca. Sin color, sólo la clase base. */
export function useBrandScope(): { className: string; style: React.CSSProperties | undefined } {
  const brand = useViewBrand();
  return useMemo(() => {
    const vars = brandCssVars(brand?.primary, brand?.secondary);
    const branded = Object.keys(vars).length > 0;
    return {
      className: clsx('cortex-view', branded && 'cortex-brand'),
      style: branded ? (vars as React.CSSProperties) : undefined,
    };
  }, [brand]);
}

/** Lo que va dentro del envoltorio: útil para portales (la ficha) que salen del árbol. */
export function BrandScope({
  children,
  className,
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  as?: 'div' | 'section';
}) {
  const scope = useBrandScope();
  return (
    <Tag className={clsx(scope.className, className)} style={scope.style}>
      {children}
    </Tag>
  );
}

/**
 * EL LOGO, o las iniciales de la empresa en un cuadro con el color de la marca
 * si no hay logo (o si no carga). Nunca un hueco.
 */
export function BrandMark({
  brand,
  size = 'md',
  className,
}: {
  brand: ViewBrand;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const box = size === 'lg' ? 'h-14 w-14' : size === 'sm' ? 'h-8 w-8' : 'h-11 w-11';
  if (brand.logoUrl && !failed)
    return (
      <span
        className={clsx(
          'view-logo grid shrink-0 place-items-center overflow-hidden rounded-sm border border-border bg-white p-1.5 shadow-card',
          box,
          className,
        )}
      >
        <img
          src={brand.logoUrl}
          alt={`Logo de ${brand.name}`}
          decoding="async"
          onError={() => setFailed(true)}
          className="max-h-full max-w-full object-contain"
        />
      </span>
    );
  const initials = brand.name
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => w.charAt(0).toLocaleUpperCase('es-CO'))
    .join('');
  return (
    <span
      aria-hidden
      className={clsx(
        'view-logo-initials grid shrink-0 place-items-center rounded-sm font-extrabold tracking-tight shadow-card',
        size === 'lg' ? 'text-lg' : size === 'sm' ? 'text-xs' : 'text-sm',
        box,
        className,
      )}
    >
      {initials || '·'}
    </span>
  );
}
