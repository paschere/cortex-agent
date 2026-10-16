import {
  type BlockDesign,
  type Emphasis,
  type Surface,
  hasDesign,
  variantsOf,
} from '@cortex/agent-tools/src/views/design-shape';

/**
 * EL DISEÑO DE UN BLOQUE, YA RESUELTO PARA PINTAR. Funciones puras: las usan el
 * lienzo, el editor y las pruebas, y no tocan React ni el DOM.
 */

export type { BlockDesign };

/** El color del texto de la superficie destacada según la tinta del botón de la marca. */
export type HeroInk = 'light' | 'dark';

/** «255 255 255» (canales de un color) → ¿es una tinta clara? */
export function heroInkFor(channels: string | undefined | null): HeroInk {
  if (!channels) return 'light';
  const [r = 255, g = 255, b = 255] = channels
    .trim()
    .split(/\s+/)
    .map((n) => Number(n));
  // Luminancia perceptual aproximada: suficiente para elegir entre dos grupos.
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? 'light' : 'dark';
}

export interface DesignAttrs {
  className: string;
  data: Record<string, string>;
}

/**
 * Las clases y los atributos `data-*` que el lienzo pone en el envoltorio de un
 * bloque. La superficie, el tono, la altura y el énfasis los dibuja views.css a
 * partir de estos atributos; la variante la lee cada bloque del contexto.
 */
export function designAttrs(
  type: string,
  design: BlockDesign | null | undefined,
  heroInk: HeroInk = 'light',
): DesignAttrs {
  const data: Record<string, string> = {};
  if (hasDesign(design)) {
    if (design.surface) data['data-surface'] = design.surface;
    if (design.tone) data['data-tone'] = design.tone;
    if (design.height && design.height !== 'auto') data['data-height'] = design.height;
    if (design.emphasis && design.emphasis !== 'normal') data['data-emphasis'] = design.emphasis;
    if (design.title === 'hidden') data['data-title'] = 'hidden';
    if (design.surface === 'hero') data['data-hero-ink'] = heroInk;
  }
  if (design?.variant && variantsOf(type).includes(design.variant))
    data['data-variant'] = design.variant;
  return { className: 'view-surf', data };
}

/** Cuánto crece o se encoge la cifra de una métrica según el énfasis. */
export const EMPHASIS_SCALE: Record<Emphasis, number> = { quiet: 0.8, normal: 1, strong: 1.2 };

/** La superficie efectiva de un bloque (sin `design`: la tarjeta de siempre). */
export function surfaceOf(design: BlockDesign | null | undefined): Surface {
  return design?.surface ?? 'card';
}
