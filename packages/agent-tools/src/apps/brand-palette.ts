import { APP_FONTS, type AppFont } from './appearance-shape';

/**
 * MARCA DESDE EL LOGO O LA WEB: LO PURO.
 *
 * Aquí no hay red, base ni archivos: sólo matemática de color y texto.
 *   - `paletteFromPixels`: de los píxeles RGBA de un logo saca el color
 *     dominante y un acento (ignora blanco, negro, grises y transparencia).
 *   - `accessibleVariants`: un color de marca → su versión para fondo claro y la
 *     de fondo oscuro, cada una empujada hacia negro o blanco SÓLO lo necesario
 *     para pasar contraste AA (4.5:1) de texto.
 *   - `brandFromHtml`: de la portada de una web saca color del tema, colores
 *     que más se repiten en su CSS y las imágenes que pueden ser el logo.
 *   - `suggestFont`: una de las tres fuentes según de qué trata la app.
 *
 * El contraste es el WCAG 2.x de siempre (el mismo de apps/web/lib/branding),
 * contra el blanco de la pantalla clara y contra la superficie oscura de la app.
 */

export type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
/** `--surface` oscuro de globals.css (el mismo que usa lib/branding/colors.ts). */
const DARK_SURFACE: Rgb = [29, 28, 25];
export const AA_TEXT = 4.5;

export function hexToRgb(hex: string): Rgb | null {
  let v = hex.trim().toLowerCase();
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  if (!/^#[0-9a-f]{6}$/.test(v)) return null;
  return [
    Number.parseInt(v.slice(1, 3), 16),
    Number.parseInt(v.slice(3, 5), 16),
    Number.parseInt(v.slice(5, 7), 16),
  ];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Mezcla `color` hacia `toward` en pasos de 2% hasta llegar a `min` contra `surface`. */
function pushUntil(color: Rgb, toward: Rgb, surface: Rgb, min: number): Rgb {
  if (contrast(color, surface) >= min) return color;
  for (let t = 0.02; t <= 1; t += 0.02) {
    const c = mix(color, toward, t);
    if (contrast(c, surface) >= min) return c;
  }
  return toward;
}

export interface AccessibleColor {
  /** El color elegido, tal cual. */
  source: string;
  /** Para texto y botones sobre fondo claro: ≥ 4.5:1 contra el blanco. */
  light: string;
  lightContrast: number;
  /** Para el modo oscuro: ≥ 4.5:1 contra la superficie oscura. */
  dark: string;
  darkContrast: number;
  /** El color elegido ya pasa AA contra el blanco sin tocarlo. */
  passesAsIs: boolean;
}

export function accessibleVariants(hex: string): AccessibleColor | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const light = pushUntil(rgb, BLACK, WHITE, AA_TEXT);
  const dark = pushUntil(rgb, WHITE, DARK_SURFACE, AA_TEXT);
  return {
    source: rgbToHex(rgb),
    light: rgbToHex(light),
    lightContrast: round1(contrast(light, WHITE)),
    dark: rgbToHex(dark),
    darkContrast: round1(contrast(dark, DARK_SURFACE)),
    passesAsIs: contrast(rgb, WHITE) >= AA_TEXT,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Color dominante de una imagen
// ---------------------------------------------------------------------------

export function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const hueDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

export interface PaletteColor {
  hex: string;
  /** Qué tanta de la imagen (con color) ocupa, de 0 a 1. */
  share: number;
}

export interface ImagePalette {
  primary: PaletteColor | null;
  accent: PaletteColor | null;
  /** El acento se calculó girando el tono del principal: la imagen sólo tenía un color. */
  accentDerived: boolean;
  /** Ningún color vivo: el logo es blanco, negro o gris. `primary` es el tono oscuro dominante. */
  monochrome: boolean;
}

interface Bucket {
  count: number;
  r: number;
  g: number;
  b: number;
}

/**
 * `data`: RGBA, 4 bytes por píxel. Cuenta en cubos de 4 bits por canal y se
 * queda con los cubos con color vivo; el principal es el que más pesa (cantidad
 * ponderada por saturación) y el acento el siguiente de otro tono.
 */
export function paletteFromPixels(
  data: ArrayLike<number>,
  options: { maxSamples?: number } = {},
): ImagePalette {
  const pixels = Math.floor(data.length / 4);
  const step = Math.max(1, Math.floor(pixels / (options.maxSamples ?? 60_000)));
  const buckets = new Map<number, Bucket>();
  const darks = new Map<number, Bucket>();
  let colorful = 0;
  for (let i = 0; i < pixels; i += step) {
    const o = i * 4;
    const a = data[o + 3] ?? 255;
    if (a < 128) continue;
    const r = data[o] ?? 0;
    const g = data[o + 1] ?? 0;
    const b = data[o + 2] ?? 0;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    if (min > 235) continue; // blanco
    if (max < 40) {
      const d = darks.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      d.count++;
      d.r += r;
      d.g += g;
      d.b += b;
      darks.set(key, d);
      continue;
    }
    if (max - min < 28) {
      // gris: sólo cuenta como «oscuro» si lo es
      if (max < 120) {
        const d = darks.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
        d.count++;
        d.r += r;
        d.g += g;
        d.b += b;
        darks.set(key, d);
      }
      continue;
    }
    colorful++;
    const bk = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bk.count++;
    bk.r += r;
    bk.g += g;
    bk.b += b;
    buckets.set(key, bk);
  }

  const avg = (b: Bucket): Rgb => [b.r / b.count, b.g / b.count, b.b / b.count];
  if (colorful === 0) {
    const top = [...darks.values()].sort((a, b) => b.count - a.count)[0];
    return {
      primary: top ? { hex: rgbToHex(avg(top)), share: 1 } : null,
      accent: null,
      accentDerived: false,
      monochrome: true,
    };
  }

  const scored = [...buckets.values()]
    .map((b) => {
      const rgb = avg(b);
      const [h, s, l] = rgbToHsl(rgb);
      // Ni casi blanco ni casi negro pesan menos: el color de marca suele estar en el medio.
      const mid = 1 - Math.abs(l - 0.5);
      return { rgb, h, s, score: b.count * (0.4 + s) * (0.5 + mid), count: b.count };
    })
    .sort((a, b) => b.score - a.score);
  const first = scored[0];
  if (!first) return { primary: null, accent: null, accentDerived: false, monochrome: true };

  // Cubos vecinos del mismo tono se suman al principal para que un degradado no lo parta en dos.
  const sameHue = scored.filter((c) => hueDistance(c.h, first.h) < 18);
  const primaryCount = sameHue.reduce((n, c) => n + c.count, 0);
  const other = scored.find((c) => hueDistance(c.h, first.h) >= 28 && c.s > 0.25);
  const primary: PaletteColor = { hex: rgbToHex(first.rgb), share: primaryCount / colorful };
  if (other) {
    const count = scored.filter((c) => hueDistance(c.h, other.h) < 18).reduce((n, c) => n + c.count, 0);
    return {
      primary,
      accent: { hex: rgbToHex(other.rgb), share: count / colorful },
      accentDerived: false,
      monochrome: false,
    };
  }
  // Un solo tono: el acento es su análogo (giro de 35°), con la luminosidad algo más viva.
  const [h, s, l] = rgbToHsl(first.rgb);
  const derived = hslToRgb((h + 35) % 360, Math.min(1, Math.max(0.55, s)), Math.min(0.55, Math.max(0.4, l)));
  return {
    primary,
    accent: { hex: rgbToHex(derived), share: 0 },
    accentDerived: true,
    monochrome: false,
  };
}

// ---------------------------------------------------------------------------
// Fuente y estilo según la app
// ---------------------------------------------------------------------------

const SERIF = /abogad|jur[ií]dic|notar|consultor[ií]a|joyer|hotel|editorial|librer|galer[ií]a|arquitect|cont(?:able|adur)|inmobiliar|boutique|vinos?|moda/i;
const ROUNDED = /salud|cl[ií]nica|odont|veterin|mascota|ni[ñn]os|colegio|jard[ií]n|escuela|curso|educaci|gimnasio|yoga|spa|bienestar|panader|pasteler|caf[eé]|restaurante|comida|heladería|florister|evento|fiesta/i;
const SYSTEM = /log[ií]stic|planta|bodega|operaci|carga|flota|transporte|inventario|producci|taller|constru|campo|finanz|banco|software|tecnolog/i;

export interface FontSuggestion {
  font: AppFont;
  reason: string;
}

/** Una de las tres fuentes según de qué trata la app. Sin pista clara: la moderna. */
export function suggestFont(text: string): FontSuggestion {
  if (SYSTEM.test(text))
    return { font: 'system', reason: 'es una herramienta de operación: la letra moderna se lee mejor en pantallas pequeñas' };
  if (SERIF.test(text))
    return { font: 'serif', reason: 'el negocio proyecta confianza y tradición: la letra editorial con serifa le va' };
  if (ROUNDED.test(text))
    return { font: 'rounded', reason: 'es un trato cercano y amable: la letra redondeada le va' };
  return { font: 'system', reason: 'sin una pista clara, la letra moderna es la que mejor se lee' };
}

export const APP_KINDS = ['operario', 'gerencial', 'portal', 'tv', 'mixto'] as const;
export type AppKind = (typeof APP_KINDS)[number];

export interface StyleSuggestion {
  kind: AppKind;
  /** Qué poner en el `theme` de las pantallas (apps.update / apps.design). */
  theme: { header?: 'plain' | 'hero'; style?: 'clean' | 'bold' | 'dark-panel'; density?: 'comfortable' | 'compact'; layout?: 'dashboard' | 'operator' | 'tv' };
  reason: string;
}

export function suggestStyle(kind: AppKind): StyleSuggestion {
  switch (kind) {
    case 'operario':
      return { kind, theme: { layout: 'operator', style: 'bold', density: 'comfortable' }, reason: 'gente de planta: una columna, controles grandes y títulos fuertes' };
    case 'portal':
      return { kind, theme: { header: 'hero', style: 'clean', density: 'comfortable' }, reason: 'clientes: cabecera con la marca bien grande y un estilo limpio' };
    case 'tv':
      return { kind, theme: { layout: 'tv', style: 'dark-panel' }, reason: 'pared de planta: panel oscuro de alto contraste' };
    case 'gerencial':
      return { kind, theme: { header: 'plain', style: 'clean', density: 'comfortable' }, reason: 'gerencia: sobrio, las cifras mandan' };
    default:
      return { kind, theme: { style: 'clean', density: 'comfortable' }, reason: 'varios públicos: el estilo limpio sirve a todos' };
  }
}

export { APP_FONTS };

// ---------------------------------------------------------------------------
// Una web: color del tema, colores del CSS e imágenes candidatas a logo
// ---------------------------------------------------------------------------

export interface WebBrandHints {
  siteName: string | null;
  themeColor: string | null;
  /** Los colores vivos que más se repiten en el CSS de la portada. */
  cssColors: Array<{ hex: string; count: number }>;
  /** Direcciones absolutas https de imágenes, de la más probable a la menos. */
  imageCandidates: string[];
}

function absolute(href: string, base: string): string | null {
  try {
    const u = new URL(href.trim().replace(/&amp;/g, '&'), base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}

function vivid(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  return max - min >= 40 && max > 60 && min < 235;
}

/** De la portada de una web (HTML ya descargado) saca lo que sirve para la marca. Puro. */
export function brandFromHtml(html: string, pageUrl: string): WebBrandHints {
  const head = html.slice(0, 400_000);
  const metas = head.match(/<meta\b[^>]*>/gi) ?? [];
  const links = head.match(/<link\b[^>]*>/gi) ?? [];
  const imgs = head.match(/<img\b[^>]*>/gi) ?? [];

  let themeColor: string | null = null;
  let siteName: string | null = null;
  let ogImage: string | null = null;
  for (const m of metas) {
    const name = (attr(m, 'name') ?? attr(m, 'property') ?? '').toLowerCase();
    const content = attr(m, 'content');
    if (!content) continue;
    if ((name === 'theme-color' || name === 'msapplication-tilecolor') && !themeColor) {
      const rgb = hexToRgb(content);
      if (rgb) themeColor = rgbToHex(rgb);
    }
    if (name === 'og:site_name' && !siteName) siteName = content.trim().slice(0, 80);
    if (name === 'og:image' && !ogImage) ogImage = absolute(content, pageUrl);
  }
  if (!siteName) {
    const t = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(head);
    if (t?.[1]) siteName = t[1].trim().split(/\s[|\-–—·]\s/)[0]?.trim() || null;
  }

  const candidates: Array<{ url: string; score: number }> = [];
  const add = (href: string | null, score: number) => {
    const url = href ? absolute(href, pageUrl) : null;
    if (url && !/\.svg(\?|$)/i.test(url) && !/\.ico(\?|$)/i.test(url))
      candidates.push({ url, score });
  };
  for (const img of imgs) {
    const src = attr(img, 'src') ?? attr(img, 'data-src');
    const blob = `${attr(img, 'class') ?? ''} ${attr(img, 'alt') ?? ''} ${attr(img, 'id') ?? ''} ${src ?? ''}`;
    if (/logo|brand|marca/i.test(blob)) add(src, 90);
  }
  for (const l of links) {
    const rel = (attr(l, 'rel') ?? '').toLowerCase();
    const href = attr(l, 'href');
    if (rel.includes('apple-touch-icon')) add(href, 80);
    else if (rel.split(/\s+/).includes('icon')) add(href, 50);
  }
  add(ogImage, 40);
  const seen = new Set<string>();
  const imageCandidates = candidates
    .sort((a, b) => b.score - a.score)
    .filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)))
    .map((c) => c.url)
    .slice(0, 6);

  // Colores del CSS de la portada: variables con nombre de marca pesan triple.
  const counts = new Map<string, number>();
  for (const m of head.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
    const rgb = hexToRgb(m[0]);
    if (!rgb) continue;
    const hex = rgbToHex(rgb);
    if (vivid(hex)) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  for (const m of head.matchAll(/--(?:[\w-]*(?:primary|brand|accent|main|principal)[\w-]*)\s*:\s*(#[0-9a-fA-F]{3,6})\b/gi)) {
    const rgb = hexToRgb(m[1] ?? '');
    if (!rgb) continue;
    const hex = rgbToHex(rgb);
    if (vivid(hex)) counts.set(hex, (counts.get(hex) ?? 0) + 3);
  }
  const cssColors = [...counts]
    .map(([hex, count]) => ({ hex, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
  return { siteName, themeColor, cssColors, imageCandidates };
}
