import { z } from 'zod';

/**
 * LA FORMA DE LA MARCA DE UNA APP, SIN NADA DE SERVIDOR.
 *
 * Separado de appearance.ts porque la pestaña «Apariencia» corre en el
 * navegador: importar appearance.ts (que lee vistas y la base) o el barril
 * del paquete metía fs/crypto/async_hooks en el bundle y tumbó el build de
 * Vercel (2026-10-08). Aquí sólo zod y constantes.
 */

/** Tres tipografías del sistema: la que ya usa Cortex, una con serifa y una redondeada. */
export const APP_FONTS = ['system', 'serif', 'rounded'] as const;
export type AppFont = (typeof APP_FONTS)[number];

export const APP_FONT_LABEL: Record<AppFont, string> = {
  system: 'Moderna (la de siempre)',
  serif: 'Editorial (con serifa)',
  rounded: 'Redondeada y amable',
};

/** Qué pila de fuentes del sistema lleva cada opción (sin descargar nada). */
export const APP_FONT_STACK: Record<AppFont, string> = {
  system: 'var(--font-sans), ui-sans-serif, system-ui, sans-serif',
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif",
  rounded:
    "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Quicksand, Nunito, system-ui, sans-serif",
};

export const IMAGE_KINDS = ['logo', 'icon', 'welcome'] as const;
export type AppImageKind = (typeof IMAGE_KINDS)[number];
export const IMAGE_TYPES = ['png', 'jpg', 'webp'] as const;
export type AppImageType = (typeof IMAGE_TYPES)[number];

const hexColor = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Usa un color como #1F6FEB.');

const imageRef = z.object({
  /** Huella del contenido: va en la URL y en la ruta del archivo. */
  v: z.string().regex(/^[0-9a-f]{8,32}$/),
  t: z.enum(IMAGE_TYPES),
});
export type AppImageRef = z.infer<typeof imageRef>;

export const appWelcomeSchema = z.object({
  title: z.string().trim().max(80).optional(),
  text: z.string().trim().max(400).optional(),
});

export const appBrandSchema = z.object({
  primary: hexColor.optional(),
  accent: hexColor.optional(),
  shortName: z.string().trim().max(12).optional(),
  font: z.enum(APP_FONTS).optional(),
  welcome: appWelcomeSchema.optional(),
  files: z
    .object({
      logo: imageRef.optional(),
      icon: imageRef.optional(),
      welcome: imageRef.optional(),
    })
    .optional(),
});
export type AppBrand = z.infer<typeof appBrandSchema>;

/** Lo que el chat puede cambiar de la marca: todo menos los archivos subidos. */
export const appBrandPatchSchema = z.object({
  primary: hexColor.nullable().optional(),
  accent: hexColor.nullable().optional(),
  shortName: z.string().trim().max(12).nullable().optional(),
  font: z.enum(APP_FONTS).nullable().optional(),
  welcome: appWelcomeSchema.nullable().optional(),
});
export type AppBrandPatch = z.infer<typeof appBrandPatchSchema>;
