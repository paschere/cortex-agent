import { z } from 'zod';
import { APP_ICON_NAMES } from '../apps/icon-names';

/**
 * EL DISEÑO DE CADA BLOQUE, SIN NADA DE SERVIDOR.
 *
 * `design` es opcional en TODOS los bloques y no tiene valor por defecto: un
 * spec guardado antes de que existiera se lee igual y se ve igual. No hay CSS
 * libre: sólo opciones con nombre, que cada renderer (components/views/blocks)
 * sabe dibujar con los tokens del sistema de diseño.
 *
 * Vive aparte de spec.ts porque el navegador (el lienzo, el editor) también lo
 * lee: importar spec.ts o el barril del paquete metía código de servidor en el
 * bundle de cliente y tumbó Vercel antes. Aquí sólo zod y constantes.
 */

/** La superficie del bloque: lo que hay DETRÁS de su contenido. */
export const SURFACES = ['plain', 'card', 'tinted', 'outline', 'elevated', 'hero'] as const;
export type Surface = (typeof SURFACES)[number];
export const SURFACE_LABEL: Record<Surface, string> = {
  plain: 'Sin marco',
  card: 'Tarjeta',
  tinted: 'Teñida',
  outline: 'Contorno',
  elevated: 'Elevada',
  hero: 'Destacada',
};

/** El ancho en la rejilla de seis columnas. `auto` respeta `width` del bloque. */
export const SIZES = ['auto', 'third', 'half', 'two-thirds', 'full'] as const;
export type BlockSize = (typeof SIZES)[number];
export const SIZE_LABEL: Record<BlockSize, string> = {
  auto: 'Auto',
  third: '1/3',
  half: '1/2',
  'two-thirds': '2/3',
  full: 'Todo',
};

export const HEIGHTS = ['auto', 'compact', 'tall'] as const;
export type BlockHeight = (typeof HEIGHTS)[number];
export const HEIGHT_LABEL: Record<BlockHeight, string> = {
  auto: 'Automática',
  compact: 'Baja',
  tall: 'Alta',
};

export const DESIGN_TONES = ['primary', 'emerald', 'amber', 'sky', 'rose'] as const;
export type DesignTone = (typeof DESIGN_TONES)[number];
export const TONE_LABEL: Record<DesignTone, string> = {
  primary: 'Marca',
  emerald: 'Verde',
  amber: 'Ámbar',
  sky: 'Cielo',
  rose: 'Rosa',
};

/** Jerarquía tipográfica del título y de las cifras. */
export const EMPHASES = ['normal', 'quiet', 'strong'] as const;
export type Emphasis = (typeof EMPHASES)[number];
export const EMPHASIS_LABEL: Record<Emphasis, string> = {
  normal: 'Normal',
  quiet: 'Discreto',
  strong: 'Fuerte',
};

export const TITLE_MODES = ['shown', 'hidden'] as const;
export type TitleMode = (typeof TITLE_MODES)[number];

/**
 * Las variantes de cada tipo de bloque. Sin `variant` se pinta el dibujo de
 * siempre de cada tipo (que no tiene por qué ser la primera de la lista). Los tipos que no aparecen aquí no
 * tienen variantes (formulario, mapa, voz, zonas, media): `variant` ahí se
 * rechaza con un mensaje, en vez de ignorarse en silencio.
 */
export const BLOCK_VARIANTS = {
  text: ['plain', 'callout', 'quote'],
  metric: ['number', 'number-sparkline', 'ring', 'compare', 'split'],
  table: ['lined', 'zebra', 'minimal'],
  sheet: ['grid', 'airy'],
  chart: ['bar', 'line', 'area', 'donut'],
  board: ['columns', 'compact'],
  gallery: ['grid', 'masonry'],
  calendar: ['month', 'agenda'],
  detail: ['sections', 'timeline-first'],
  cards: ['compact', 'rich', 'image', 'row'],
  progress: ['bar', 'steps', 'ring'],
  links: ['buttons', 'cards', 'tiles'],
} as const satisfies Record<string, readonly string[]>;

export type VariantBlockType = keyof typeof BLOCK_VARIANTS;

/** Cómo se llama cada variante en el editor (miniatura + rótulo). */
export const VARIANT_LABEL: Record<string, string> = {
  plain: 'Simple',
  callout: 'Destacado',
  quote: 'Cita',
  number: 'Cifra',
  'number-sparkline': 'Cifra y línea',
  ring: 'Anillo',
  compare: 'Comparar',
  split: 'Dos cifras',
  lined: 'Con líneas',
  zebra: 'Cebra',
  minimal: 'Mínima',
  bar: 'Barras',
  line: 'Línea',
  area: 'Área',
  donut: 'Dona',
  columns: 'Columnas',
  compact: 'Compacto',
  grid: 'Rejilla',
  airy: 'Holgada',
  masonry: 'Mosaico',
  month: 'Mes',
  agenda: 'Agenda',
  sections: 'Secciones',
  'timeline-first': 'Historia primero',
  rich: 'Rica',
  image: 'Con foto',
  row: 'Lista',
  steps: 'Pasos',
  buttons: 'Botones',
  cards: 'Tarjetas',
  tiles: 'Mosaicos',
};

export function variantsOf(type: string): readonly string[] {
  return (BLOCK_VARIANTS as Record<string, readonly string[]>)[type] ?? [];
}

const ICONS = APP_ICON_NAMES as readonly string[];

function listed(values: readonly string[]): string {
  return values.map((v) => `«${v}»`).join(', ');
}

/** Una enumeración con el mensaje en español: qué campo y qué opciones hay. */
function opt<T extends readonly [string, ...string[]]>(field: string, values: T) {
  return z.enum(values, {
    errorMap: () => ({ message: `«design.${field}» admite: ${listed(values)}.` }),
  });
}

/**
 * El esquema de `design` para un tipo de bloque. Es el mismo en todos salvo en
 * `variant`, que sólo admite las del tipo. Estricto: una clave desconocida
 * («superficie», «color») se rechaza diciendo cuáles existen, porque ignorarla
 * en silencio dejaría al modelo creyendo que pintó algo que no se pinta.
 */
export function designSchemaFor(type: string) {
  const variants = variantsOf(type);
  const variant =
    variants.length > 0
      ? opt('variant', variants as unknown as readonly [string, ...string[]])
      : z.never({
          errorMap: () => ({
            message: `Los bloques «${type}» no tienen variantes: quita «design.variant».`,
          }),
        });
  return z
    .object(
      {
        surface: opt('surface', SURFACES).optional(),
        size: opt('size', SIZES).optional(),
        height: opt('height', HEIGHTS).optional(),
        tone: opt('tone', DESIGN_TONES).optional(),
        emphasis: opt('emphasis', EMPHASES).optional(),
        title: opt('title', TITLE_MODES).optional(),
        icon: z
          .enum(APP_ICON_NAMES, {
            errorMap: () => ({
              message: '«design.icon» debe ser un ícono de la lista de Cortex (por ejemplo «BarChart3»).',
            }),
          })
          .optional(),
        variant: variant.optional(),
      },
      {
        errorMap: (issue, ctx) =>
          issue.code === 'unrecognized_keys'
            ? {
                message: `«design» no tiene ${issue.keys.map((k) => `«${k}»`).join(', ')}. Sólo: surface, size, height, tone, emphasis, title, icon, variant.`,
              }
            : { message: ctx.defaultError },
      },
    )
    .strict();
}

/** Lo que guarda cada bloque. Todo opcional: vacío o ausente = el dibujo de siempre. */
export interface BlockDesign {
  surface?: Surface;
  size?: BlockSize;
  height?: BlockHeight;
  tone?: DesignTone;
  emphasis?: Emphasis;
  title?: TitleMode;
  icon?: (typeof APP_ICON_NAMES)[number];
  variant?: string;
}

/** ¿Este `design` cambia algo? Un `{}` o `undefined` no. */
export function hasDesign(d: BlockDesign | null | undefined): d is BlockDesign {
  return !!d && Object.values(d).some((v) => v !== undefined);
}

// ---------------------------------------------------------------------------
// Resolución pura (la usan el lienzo, el editor y las pruebas)
// ---------------------------------------------------------------------------

export type Width = 'full' | 'half' | 'third';

/**
 * Las clases de columna de la rejilla de seis, para un bloque. `size` manda
 * sobre `width`; en `auto`, el ancho de siempre. Un teléfono (por debajo de
 * `md`) siempre es una columna: así se lee una vista en WhatsApp.
 */
export function gridSpanClass(width: Width, design?: BlockDesign | null): string {
  const size: BlockSize = design?.size && design.size !== 'auto' ? design.size : width;
  switch (size) {
    case 'third':
      return 'md:col-span-3 xl:col-span-2';
    case 'half':
      return 'md:col-span-3';
    case 'two-thirds':
      return 'md:col-span-4';
    default:
      return 'md:col-span-6';
  }
}

/**
 * La variante PEDIDA, si es de este tipo. Sin pedirla (o si es de otro tipo)
 * es `undefined`: el renderer pinta el dibujo de siempre de ese bloque.
 */
export function variantOf(type: string, design?: BlockDesign | null): string | undefined {
  return design?.variant && variantsOf(type).includes(design.variant) ? design.variant : undefined;
}

export function isIconName(value: string): boolean {
  return ICONS.includes(value);
}

/**
 * Un resumen en una línea, para el editor y para lo que Cortex le cuenta a la
 * persona: «Destacada · 2/3 · Anillo».
 */
export function describeDesign(d: BlockDesign | null | undefined): string {
  if (!hasDesign(d)) return 'Diseño de siempre';
  const parts: string[] = [];
  if (d.surface) parts.push(SURFACE_LABEL[d.surface]);
  if (d.size && d.size !== 'auto') parts.push(SIZE_LABEL[d.size]);
  if (d.height && d.height !== 'auto') parts.push(`altura ${HEIGHT_LABEL[d.height].toLowerCase()}`);
  if (d.variant) parts.push(VARIANT_LABEL[d.variant] ?? d.variant);
  if (d.tone) parts.push(TONE_LABEL[d.tone]);
  if (d.emphasis && d.emphasis !== 'normal') parts.push(`énfasis ${EMPHASIS_LABEL[d.emphasis].toLowerCase()}`);
  if (d.title === 'hidden') parts.push('sin título');
  return parts.join(' · ') || 'Diseño de siempre';
}

/** Texto para el esquema que ve el modelo (views.* y apps.design). */
export const DESIGN_FIELD_DOC =
  'design (opcional, sin CSS): surface plain|card|tinted|outline|elevated|hero; size auto|third|half|two-thirds|full; ' +
  'height auto|compact|tall; tone primary|emerald|amber|sky|rose; emphasis normal|quiet|strong; title shown|hidden; ' +
  'icon (ícono de la lista); variant según el bloque: ' +
  Object.entries(BLOCK_VARIANTS)
    .map(([t, v]) => `${t}: ${v.join('|')}`)
    .join('; ') +
  '.';
