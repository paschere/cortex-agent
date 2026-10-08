import {
  type Rgb,
  brandTokens,
  contrast,
  hexToRgb,
  normalizeHex,
  rgbToHex,
} from '@/lib/branding/colors';
import type { ViewBrand } from '@/lib/branding/shape';
import type { EmailBrand } from '@/lib/email-templates/layout';
import { APP_FONT_STACK, type AppBrand, type AppFont } from '@cortex/agent-tools';

/**
 * LA MARCA DE UNA APP, RESUELTA (migración 0215). Puro y probado.
 *
 * Capas, de la más específica a la más general:
 *   1. lo que la app puso en «Apariencia» (logo, color principal, acento…);
 *   2. la marca de la empresa (company_branding, 0170);
 *   3. el índigo de Cortex.
 *
 * Cada campo se resuelve por su cuenta: una app puede tener logo propio y
 * heredar los colores de la empresa, o al revés. El contraste ya lo resuelve
 * `brandTokens` (lib/branding/colors.ts) para cualquier color; aquí sólo se
 * comprueba y se le dice a quien edita qué pasó con el suyo.
 */

export interface AppWelcome {
  title: string;
  text: string;
  imageUrl: string | null;
}

export interface AppBrandView extends ViewBrand {
  /** El nombre bajo el ícono instalado: máximo 12 caracteres. */
  shortName: string;
  font: AppFont;
  /** El ícono cuadrado (o el logo) para la cabecera y las notificaciones; null = el emoji de la app. */
  iconUrl: string | null;
  /** La app tiene identidad propia (logo o color): la cabecera lleva el nombre de la app, no el de la empresa. */
  own: boolean;
  welcome: AppWelcome | null;
}

export type AssetUrl = (kind: 'logo' | 'icon' | 'welcome', v: string, t: string) => string;

export function resolveAppBrand(
  company: ViewBrand,
  brand: AppBrand | undefined,
  app: { name: string },
  assetUrl: AssetUrl,
): AppBrandView {
  const b = brand ?? {};
  const files = b.files ?? {};
  const primary = normalizeHex(b.primary) ?? company.primary;
  const secondary = normalizeHex(b.accent) ?? company.secondary;
  const ownLogo = files.logo ? assetUrl('logo', files.logo.v, files.logo.t) : null;
  const own = Boolean(ownLogo || normalizeHex(b.primary));
  const welcomeTitle = b.welcome?.title?.trim() ?? '';
  const welcomeText = b.welcome?.text?.trim() ?? '';
  const welcomeImage = files.welcome ? assetUrl('welcome', files.welcome.v, files.welcome.t) : null;
  const iconUrl = files.icon
    ? assetUrl('icon', files.icon.v, files.icon.t)
    : (ownLogo ?? company.logoUrl);
  return {
    name: own ? app.name : company.name,
    logoUrl: ownLogo ?? company.logoUrl,
    primary,
    secondary,
    shortName: (b.shortName?.trim() || app.name.trim()).slice(0, 12),
    font: b.font ?? 'system',
    iconUrl,
    own,
    welcome:
      welcomeTitle || welcomeText || welcomeImage
        ? { title: welcomeTitle, text: welcomeText, imageUrl: welcomeImage }
        : null,
  };
}

/** La pila de fuentes para el envoltorio de la app (variable CSS `font-family`). */
export function fontStack(font: AppFont | undefined): string {
  return APP_FONT_STACK[font ?? 'system'];
}

// ---------------------------------------------------------------------------
// Contraste AA, en claro y en oscuro
// ---------------------------------------------------------------------------

const AA = 4.5;
const LIGHT_SURFACE: Rgb = [255, 255, 255];
const DARK_SURFACE: Rgb = [29, 28, 25];

export interface ColorReport {
  valid: boolean;
  hex: string | null;
  /** Contraste del color tal cual contra la superficie clara y la oscura. */
  rawLight: number;
  rawDark: number;
  /** Contraste del texto de acento que de verdad se pinta (ya ajustado). */
  light: number;
  dark: number;
  /** Contraste del texto del botón relleno. */
  button: number;
  /** Con qué color se pinta en claro / oscuro / el botón (distinto del elegido = se ajustó). */
  usedLight: string | null;
  usedDark: string | null;
  usedButton: string | null;
  /** Pasa AA en claro, en oscuro y en el botón, ya con el ajuste automático. */
  passes: boolean;
  /** El color elegido, sin ajustar, ya pasa solo. */
  passesRaw: boolean;
}

/** Qué hace el sistema con un color de marca para que se lea: ratios y colores finales. */
export function colorReport(input: string | null | undefined): ColorReport {
  const hex = normalizeHex(input);
  const raw = hex ? hexToRgb(hex) : null;
  const tokens = hex ? brandTokens(hex) : null;
  if (!hex || !raw || !tokens)
    return {
      valid: false,
      hex: null,
      rawLight: 0,
      rawDark: 0,
      light: 0,
      dark: 0,
      button: 0,
      usedLight: null,
      usedDark: null,
      usedButton: null,
      passes: false,
      passesRaw: false,
    };
  const rawLight = contrast(raw, LIGHT_SURFACE);
  const rawDark = contrast(raw, DARK_SURFACE);
  const light = contrast(tokens.light.primary, LIGHT_SURFACE);
  const dark = contrast(tokens.dark.primary, DARK_SURFACE);
  const button = contrast(tokens.button, tokens.buttonInk);
  return {
    valid: true,
    hex,
    rawLight,
    rawDark,
    light,
    dark,
    button,
    usedLight: rgbToHex(tokens.light.primary),
    usedDark: rgbToHex(tokens.dark.primary),
    usedButton: rgbToHex(tokens.button),
    passes: light >= AA && dark >= AA && button >= AA,
    passesRaw: rawLight >= AA && rawDark >= AA,
  };
}

/** Los colores que la empresa ya tiene, para ofrecerlos como punto de partida. */
export function companyColorChoices(company: Pick<ViewBrand, 'primary' | 'secondary'>): string[] {
  return [company.primary, company.secondary].filter((c): c is string => Boolean(c));
}

/**
 * La marca de una app para sus correos (código e invitación), o undefined si
 * la app no tiene identidad propia (entonces el correo lleva el encabezado de
 * Cortex como siempre). El color del nombre es el de texto de acento ya
 * ajustado a AA sobre blanco; el botón, el de relleno con su tinta.
 */
export function emailBrand(
  view: Pick<AppBrandView, 'own' | 'name' | 'primary' | 'iconUrl'>,
  origin: string,
): EmailBrand | undefined {
  if (!view.own) return undefined;
  const tokens = view.primary ? brandTokens(view.primary) : null;
  if (!tokens) return undefined;
  const absolute = view.iconUrl && origin ? `${origin}${view.iconUrl}` : '';
  return {
    name: view.name,
    color: rgbToHex(tokens.light.primary),
    logoUrl: absolute || undefined,
    buttonColor: rgbToHex(tokens.button),
    buttonInk: rgbToHex(tokens.buttonInk),
  };
}
