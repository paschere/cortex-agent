import { ForbiddenError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCompanyManager } from '../directory/store';
import { getFile } from '../files/store';
import { registerTool } from '../index';
import type { ViewSpec } from '../views/spec';
import { APP_FONT_LABEL, type AppFont } from './appearance-shape';
import {
  type AccessibleColor,
  type AppKind,
  type ImagePalette,
  type StyleSuggestion,
  type WebBrandHints,
  accessibleVariants,
  brandFromHtml,
  hexToRgb,
  paletteFromPixels,
  rgbToHsl,
  suggestFont,
  suggestStyle,
} from './brand-palette';
import { decodeImage, fetchPublic, sniffImage } from './brand-image';
import { listRoles, listScreens, mustGetApp, screenViews } from './store';

/**
 * APPS.SUGGEST_BRAND: LA MARCA DE UNA APP DESDE SU LOGO O LA WEB DE LA EMPRESA.
 *
 * Lee el logo (el de la app, el de la empresa o una dirección) o la portada de
 * la web, saca el color dominante y un acento, los revisa contra el contraste
 * AA (4.5:1) sobre blanco y sobre la superficie oscura, sugiere una de las tres
 * letras y el estilo según para quién es la app, y devuelve la PROPUESTA con el
 * `apply` listo. NO escribe nada: la persona aprueba y entonces el modelo llama
 * apps.update con `brand` (que sí pide confirmación, como cualquier cambio).
 */

export const MAX_LOGO_FETCH = 1_500_000;
export const MAX_PAGE_FETCH = 600_000;

/** Para quién es la app, mirando sus pantallas y roles. Puro. */
export function inferAppKind(
  specs: ViewSpec[],
  roles: Array<{ permissions: { tables: Record<string, { read: unknown; create: boolean }> } }>,
): AppKind {
  if (!specs.length) return 'mixto';
  const layouts = specs.map((s) => s.theme?.layout ?? 'dashboard');
  if (layouts.every((l) => l === 'tv')) return 'tv';
  const portal = roles.some((r) => Object.values(r.permissions.tables).some((p) => typeof p.read === 'object'));
  if (portal && specs.some((s) => s.theme?.header === 'hero')) return 'portal';
  const operator = layouts.filter((l) => l === 'operator').length;
  if (operator && operator >= specs.length / 2) return 'operario';
  const dashboardOnly = specs.every((s) => !s.blocks.some((b) => b.type === 'form'));
  if (dashboardOnly && specs.some((s) => s.blocks.some((b) => b.type === 'chart'))) return 'gerencial';
  return 'mixto';
}

export interface BrandProposal {
  origin: string;
  primary: AccessibleColor;
  accent: AccessibleColor | null;
  accentDerived: boolean;
  font: AppFont;
  fontReason: string;
  style: StyleSuggestion;
  siteName: string | null;
  warnings: string[];
  /** Lo que se le pasa a apps.update tal cual, cuando la persona aprueba. */
  apply: { brand: { primary: string; accent?: string; font: AppFont } };
}

export interface ProposalInput {
  origin: string;
  palette: ImagePalette | null;
  hints?: WebBrandHints | null;
  /** Texto de la app y la empresa para elegir la letra. */
  text: string;
  kind: AppKind;
}

/** De los colores encontrados a la propuesta con contraste revisado. Pura. */
export function buildBrandProposal(input: ProposalInput): BrandProposal | null {
  const warnings: string[] = [];
  let primaryHex = input.palette?.primary?.hex ?? null;
  let accentHex = input.palette?.accent?.hex ?? null;
  let accentDerived = input.palette?.accentDerived ?? false;
  if (!primaryHex && input.hints) {
    const css = input.hints.cssColors;
    primaryHex = input.hints.themeColor ?? css[0]?.hex ?? null;
    const base = primaryHex ? hexToRgb(primaryHex) : null;
    const baseHue = base ? rgbToHsl(base)[0] : 0;
    const other = css.find((c) => {
      const rgb = hexToRgb(c.hex);
      if (!rgb || c.hex === primaryHex) return false;
      const d = Math.abs(rgbToHsl(rgb)[0] - baseHue) % 360;
      return Math.min(d, 360 - d) >= 28;
    });
    accentHex = other?.hex ?? null;
    if (primaryHex) warnings.push('No pude leer un logo en esa dirección: los colores salen del estilo de la página.');
  }
  if (!primaryHex) return null;
  if (input.palette?.monochrome)
    warnings.push('El logo es de un solo tono (negro, gris o blanco): propongo ese tono oscuro como principal; si quieres más vida, elige tú un color.');
  const primary = accessibleVariants(primaryHex);
  if (!primary) return null;
  const accent = accentHex ? accessibleVariants(accentHex) : null;
  if (!primary.passesAsIs)
    warnings.push(
      `El color ${primary.source} no llega a contraste AA como texto sobre blanco; en pantalla se usa ${primary.light} para textos (y ${primary.dark} en modo oscuro). Los botones conservan el color de la marca.`,
    );
  const font = suggestFont(input.text);
  const style = suggestStyle(input.kind);
  return {
    origin: input.origin,
    primary,
    accent,
    accentDerived,
    font: font.font,
    fontReason: font.reason,
    style,
    siteName: input.hints?.siteName ?? null,
    warnings,
    apply: {
      brand: {
        primary: primary.source,
        ...(accent ? { accent: accent.source } : {}),
        font: font.font,
      },
    },
  };
}

export function proposalMarkdown(p: BrandProposal): string {
  const row = (name: string, c: AccessibleColor) =>
    `- **${name}**: ${c.source} (texto sobre blanco ${c.light}, contraste ${c.lightContrast}:1; modo oscuro ${c.dark}, ${c.darkContrast}:1)`;
  return [
    `**Marca propuesta** (${p.origin}${p.siteName ? `, de «${p.siteName}»` : ''}) — nada se ha guardado.`,
    row('Color principal', p.primary),
    p.accent
      ? row(`Acento${p.accentDerived ? ' (derivado del principal: el logo sólo tiene un color)' : ''}`, p.accent)
      : '- **Acento**: ninguno claro; se queda el que ya tiene.',
    `- **Letra**: ${APP_FONT_LABEL[p.font]} — ${p.fontReason}.`,
    `- **Estilo para las pantallas**: ${p.style.reason} (${JSON.stringify(p.style.theme)}).`,
    ...p.warnings.map((w) => `- Ojo: ${w}`),
    '',
    'Si te gusta, la aplico con apps.update (te pedirá confirmar); si prefieres otro color, dímelo y lo ajusto.',
  ].join('\n');
}

const colorSchema = z.object({
  source: z.string(),
  light: z.string(),
  lightContrast: z.number(),
  dark: z.string(),
  darkContrast: z.number(),
  passesAsIs: z.boolean(),
});

async function readLogoBytes(
  db: SupabaseClient,
  app: Awaited<ReturnType<typeof mustGetApp>> | null,
  source: 'app' | 'company',
): Promise<Uint8Array | null> {
  if (source === 'app') {
    const ref = app?.brand.files?.logo;
    if (!app?.organization_id || !ref) return null;
    const file = await getFile(db, 'branding', `${app.organization_id}/apps/${app.id}/logo-${ref.v}.${ref.t}`).catch(
      () => null,
    );
    return file?.content ?? null;
  }
  const { data, error } = await db.from('company_branding').select('logo_path').maybeSingle();
  const path = error ? null : (data as { logo_path: string | null } | null)?.logo_path;
  if (!path) return null;
  const file = await getFile(db, 'branding', path).catch(() => null);
  return file?.content ?? null;
}

export const appsSuggestBrand = registerTool({
  id: 'apps.suggest_brand',
  description: `Propose an application's BRAND from its logo or from the company's web page, WITHOUT saving anything. Sources: the app's own logo (pass \`app\`), the company logo already uploaded (fallback when the app has none), or a \`url\` (a direct image of the logo, or the company's web page: the logo is found in it, and if it cannot be read the colors of the page are used). It extracts the dominant color and an accent (ignoring white, black and grays), checks both for WCAG AA contrast (4.5:1) on white and on the dark surface, suggests one of the three fonts ("system" / "serif" / "rounded") from what the business is, and a screen style for who the app is for (operators, management, client portal, plant TV). Returns {origin, primary, accent, font, style, warnings, apply, markdown}. Show the markdown to the person; ONLY when they approve, call apps.update with \`brand\` = apply.brand (it asks for confirmation like every change). If nothing could be read, say so plainly and ask for the logo (uploaded from the editor's "Apariencia" tab) or a color; never invent colors. PNG logos always work; JPG/WebP depend on the server. Read-only (no confirmation); company owners/admins only.`,
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80).optional().describe('App id or slug: its logo, name and screens are used.'),
    url: z
      .string()
      .trim()
      .url()
      .max(500)
      .optional()
      .describe('A direct image of the logo, or the company web page.'),
    description: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe('What the business does, to pick the font (e.g. "clínica veterinaria").'),
    kind: z.enum(['operario', 'gerencial', 'portal', 'tv', 'mixto']).optional().describe('Who the app is for; inferred from the app when omitted.'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    origin: z.string(),
    primary: colorSchema.nullable(),
    accent: colorSchema.nullable(),
    accentDerived: z.boolean(),
    font: z.enum(['system', 'serif', 'rounded']).nullable(),
    style: z.unknown().nullable(),
    warnings: z.array(z.string()),
    apply: z.unknown().nullable(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    if (!(await isCompanyManager(ctx.db, ctx.userId)))
      throw new ForbiddenError('Sólo quien administra la empresa o es su dueño puede proponer la marca.');
    const app = input.app ? await mustGetApp(ctx.db, input.app) : null;

    let kind: AppKind = input.kind ?? 'mixto';
    if (app && !input.kind) {
      const screens = await listScreens(ctx.db, app.id);
      const views = await screenViews(ctx.db, screens);
      const specs = screens.flatMap((s) => {
        const v = views.get(s.view_id);
        return v ? [v.spec] : [];
      });
      const roles = await listRoles(ctx.db, app.id);
      kind = inferAppKind(specs, roles);
    }
    const text = [input.description, app?.name, app?.description].filter(Boolean).join(' ');

    const none = (why: string) => ({
      ok: false,
      origin: why,
      primary: null,
      accent: null,
      accentDerived: false,
      font: null,
      style: null,
      warnings: [] as string[],
      apply: null,
      markdown: why,
    });

    let origin = '';
    let palette: ImagePalette | null = null;
    let hints: WebBrandHints | null = null;
    const paletteOf = async (bytes: Uint8Array): Promise<ImagePalette | null> => {
      const img = await decodeImage(bytes);
      return img ? paletteFromPixels(img.data) : null;
    };

    if (input.url) {
      let fetched: Awaited<ReturnType<typeof fetchPublic>>;
      try {
        fetched = await fetchPublic(input.url, {
          maxBytes: MAX_PAGE_FETCH,
          accept: 'text/html,image/*;q=0.9',
          signal: ctx.signal,
        });
      } catch (err) {
        throw new ValidationError(
          `No pude abrir esa dirección (${err instanceof Error ? err.message : 'error'}). Prueba con la dirección directa del logo o sube el logo desde la pestaña «Apariencia».`,
        );
      }
      if (sniffImage(fetched.bytes)) {
        origin = 'el logo de esa dirección';
        palette = await paletteOf(fetched.bytes);
        if (!palette)
          return none(
            'Pude descargar la imagen pero este servidor no sabe leer su formato (sirven PNG siempre; JPG y WebP según el servidor). Sube el logo en PNG o dime un color.',
          );
      } else {
        hints = brandFromHtml(new TextDecoder().decode(fetched.bytes), fetched.url);
        origin = `la página ${new URL(fetched.url).hostname}`;
        for (const candidate of hints.imageCandidates.slice(0, 3)) {
          try {
            const img = await fetchPublic(candidate, { maxBytes: MAX_LOGO_FETCH, accept: 'image/*', signal: ctx.signal });
            palette = await paletteOf(img.bytes);
            if (palette?.primary) {
              origin = `el logo de la página ${new URL(fetched.url).hostname}`;
              break;
            }
            palette = null;
          } catch {
            // Un candidato que no baja no frena a los demás.
          }
        }
      }
    } else {
      const first = app ? await readLogoBytes(ctx.db, app, 'app') : null;
      const bytes = first ?? (await readLogoBytes(ctx.db, app, 'company'));
      if (!bytes)
        return none(
          'No hay un logo guardado (ni de la app ni de la empresa). Súbelo desde la pestaña «Apariencia» del editor, o dame la dirección de tu página web o del logo.',
        );
      origin = first ? 'el logo de la app' : 'el logo de la empresa';
      palette = await paletteOf(bytes);
      if (!palette)
        return none(
          'Encontré el logo pero este servidor no sabe leer su formato. Sube una versión PNG o dime el color de tu marca.',
        );
    }

    const proposal = buildBrandProposal({ origin, palette, hints, text, kind });
    if (!proposal)
      return none(
        'No encontré colores de marca en eso (parece blanco, negro o gris). Dime el color de tu marca o sube un logo con color.',
      );
    return {
      ok: true,
      origin: proposal.origin,
      primary: proposal.primary,
      accent: proposal.accent,
      accentDerived: proposal.accentDerived,
      font: proposal.font,
      style: { ...proposal.style, fontReason: proposal.fontReason },
      warnings: proposal.warnings,
      apply: proposal.apply,
      markdown: proposalMarkdown(proposal),
    };
  },
});
