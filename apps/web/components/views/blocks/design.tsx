'use client';

import {
  type BlockDesign,
  hasDesign,
  variantsOf,
} from '@cortex/agent-tools/src/views/design-shape';
import { type HeroInk, designAttrs, heroInkFor } from '@/lib/views/block-design';
import { brandCssVars } from '@/lib/branding/colors';
import { clsx } from 'clsx';
import { createContext, useContext, useMemo } from 'react';
import { useViewBrand } from './brand';

/**
 * EL DISEÑO DE UN BLOQUE, REPARTIDO A LO QUE HAY ADENTRO.
 *
 * `DesignScope` envuelve cada bloque (en la rejilla del lienzo, en el tablero
 * TV y en el lienzo del editor): pone los atributos `data-*` que views.css
 * traduce a superficie, tono, altura y énfasis, y deja en contexto lo que los
 * renderers necesitan leer (la variante, el ícono, si el título se oculta).
 * Nada de CSS libre: todo son opciones con nombre de design-shape.ts.
 *
 * Sin `design`, el contexto es el vacío y el bloque se ve exactamente como
 * antes (la variante por defecto es la primera de su tipo).
 */

export interface BlockDesignContext {
  type: string;
  design: BlockDesign | null;
  /** La variante PEDIDA a propósito (si es de este tipo); sin pedirla, `undefined` = el dibujo de siempre. */
  variant: string | undefined;
  /** El título del bloque, para saber qué tarjeta lleva el ícono. */
  blockTitle: string | null;
}

function explicitVariant(type: string, design: BlockDesign | undefined): string | undefined {
  return design?.variant && variantsOf(type).includes(design.variant) ? design.variant : undefined;
}

const EMPTY: BlockDesignContext = { type: '', design: null, variant: undefined, blockTitle: null };
const Ctx = createContext<BlockDesignContext>(EMPTY);

export function useBlockDesign(): BlockDesignContext {
  return useContext(Ctx);
}

/** La variante del bloque que se está pintando (`undefined` si su tipo no tiene). */
export function useVariant(): string | undefined {
  return useContext(Ctx).variant;
}

/** ¿Pidió la persona esta variante? (la primera, la de siempre, también cuenta si coincide). */
export function useIsVariant(name: string): boolean {
  return useContext(Ctx).variant === name;
}

function useHeroInk(): HeroInk {
  const brand = useViewBrand();
  return useMemo(() => {
    const vars = brandCssVars(brand?.primary, brand?.secondary) as Record<string, string>;
    return heroInkFor(vars['--brand-button-ink']);
  }, [brand]);
}

type Block = { type: string; design?: BlockDesign; title?: string | null };

export function DesignScope({
  block,
  as: Tag = 'div',
  className,
  children,
}: {
  block: Block;
  as?: 'div' | 'section';
  /** Clases del envoltorio (la rejilla del lienzo pone las suyas aquí). */
  className?: string;
  children: React.ReactNode;
}) {
  const heroInk = useHeroInk();
  const attrs = designAttrs(block.type, block.design, heroInk);
  const value = useMemo<BlockDesignContext>(
    () => ({
      type: block.type,
      design: hasDesign(block.design) ? block.design : null,
      variant: explicitVariant(block.type, block.design),
      blockTitle: block.title ?? null,
    }),
    [block.type, block.design, block.title],
  );
  return (
    <Tag className={clsx(attrs.className, className)} {...attrs.data}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </Tag>
  );
}
