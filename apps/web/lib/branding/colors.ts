/**
 * EL COLOR DE LA MARCA, VUELTO TOKENS QUE SE PUEDEN LEER.
 *
 * Una empresa elige su color tal cual: un amarillo de taxi, un verde menta, un
 * azul casi negro. Pintarlo directo en botones y textos funciona con la mitad
 * de las marcas y deja ilegible la otra mitad (texto blanco sobre amarillo,
 * texto menta sobre blanco). Aquí el color se convierte en los mismos cuatro
 * tokens que ya usa todo el sistema (`--primary`, `--primary-strong`,
 * `--primary-soft`, `--primary-ink`), en claro y en oscuro, cada uno empujado
 * hacia negro o hacia blanco SÓLO lo necesario para pasar el contraste WCAG:
 *
 *   primary  ≥ 4.5:1 contra la superficie  (texto y enlaces de acento)
 *   strong   ≥ 7:1   contra la superficie  (hover, títulos sobre acento)
 *   ink      ≥ 7:1   contra el fondo suave (texto sobre `bg-primary-soft`)
 *   fill     ≥ 1.4:1 contra la superficie  (barras, líneas, franjas: dibujo)
 *
 * Y el botón: el color de la marca TAL CUAL, con el texto (blanco o tinta) que
 * mejor contraste. Si ninguno llega a 4.5:1, el fondo se oscurece hasta que el
 * blanco sí llegue. Una marca que ya pasa no se toca.
 *
 * Módulo puro (sin DOM, sin servidor): lo usan el lienzo, la pantalla de la
 * marca y las pruebas.
 */

export type Rgb = readonly [number, number, number];

export const HEX_RE = /^#[0-9a-f]{6}$/;

/** El índigo de Cortex: lo que se ve cuando no hay marca o el color no sirve. */
export const CORTEX_PRIMARY = '#4338ca';

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const INK: Rgb = [23, 23, 31];
/** `--surface` claro y oscuro de globals.css. */
const LIGHT_SURFACE: Rgb = [255, 255, 255];
const DARK_SURFACE: Rgb = [29, 28, 25];

/** «#AbC» o «abcdef» → «#aabbcc». Null si no es un color. */
export function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  let v = input.trim().toLowerCase();
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return HEX_RE.test(v) ? v : null;
}

export function hexToRgb(hex: string): Rgb | null {
  const v = normalizeHex(hex);
  if (!v) return null;
  return [
    Number.parseInt(v.slice(1, 3), 16),
    Number.parseInt(v.slice(3, 5), 16),
    Number.parseInt(v.slice(5, 7), 16),
  ];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Luminancia relativa WCAG 2.x. */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contraste WCAG entre dos colores, de 1 a 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `t` = 0 es `a`; 1 es `b`. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map((c) =>
    Math.round(c),
  ) as unknown as Rgb;
}

/**
 * El color más parecido a `color` que llega a `min` contra `bg`, moviéndolo
 * hacia negro (fondos claros) o hacia blanco (fondos oscuros) a pasos cortos.
 */
export function ensureContrast(color: Rgb, bg: Rgb, min: number): Rgb {
  if (contrast(color, bg) >= min) return color;
  const toward = luminance(bg) > 0.5 ? BLACK : WHITE;
  for (let t = 0.04; t <= 1; t += 0.04) {
    const next = mix(color, toward, t);
    if (contrast(next, bg) >= min) return next;
  }
  return toward;
}

/** El tono (0–360°) de un color, o null si es casi gris. */
export function hueOf(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.08) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** Distancia entre dos tonos en el círculo (0–180). */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Blanco o tinta: lo que mejor se lee encima de `bg`. */
export function readableOn(bg: Rgb): Rgb {
  return contrast(WHITE, bg) >= contrast(INK, bg) ? WHITE : INK;
}

/** «r g b», el formato de los tokens de globals.css (`rgb(var(--x) / a)`). */
export function channels([r, g, b]: Rgb): string {
  return `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`;
}

export interface ThemeTokens {
  primary: Rgb;
  strong: Rgb;
  soft: Rgb;
  ink: Rgb;
  fill: Rgb;
  fill2: Rgb;
}

export interface BrandTokens {
  light: ThemeTokens;
  dark: ThemeTokens;
  button: Rgb;
  buttonHover: Rgb;
  buttonInk: Rgb;
}

/**
 * El dibujo usa la marca casi tal cual: un amarillo de taxi oscurecido hasta
 * 3:1 queda verde oliva y deja de ser la marca. Se puede porque en una vista
 * ninguna barra ni línea va sola — cada una lleva su cifra en texto al lado,
 * y ése sí cumple el contraste. Sólo un color casi blanco se oscurece, para
 * que la barra no desaparezca.
 */
const FILL_MIN = 1.4;

function themeTokens(brand: Rgb, second: Rgb, surface: Rgb, softMix: number): ThemeTokens {
  const soft = mix(surface, brand, softMix);
  return {
    primary: ensureContrast(brand, surface, 4.5),
    strong: ensureContrast(brand, surface, 7),
    soft,
    ink: ensureContrast(brand, soft, 7),
    fill: ensureContrast(brand, surface, FILL_MIN),
    fill2: ensureContrast(second, surface, FILL_MIN),
  };
}

/** Los tokens de una marca, o null si el color no es un color. */
export function brandTokens(primaryHex: string, secondaryHex?: string | null): BrandTokens | null {
  const brand = hexToRgb(primaryHex);
  if (!brand) return null;
  const second = (secondaryHex && hexToRgb(secondaryHex)) || mix(brand, WHITE, 0.45);
  const on = readableOn(brand);
  const button = contrast(on, brand) >= 4.5 ? brand : ensureContrast(brand, WHITE, 4.5);
  const buttonInk = contrast(on, brand) >= 4.5 ? on : WHITE;
  return {
    light: themeTokens(brand, second, LIGHT_SURFACE, 0.1),
    dark: themeTokens(brand, second, DARK_SURFACE, 0.22),
    button,
    buttonHover: mix(button, buttonInk === WHITE ? BLACK : WHITE, 0.12),
    buttonInk,
  };
}

/**
 * Las variables que lleva el elemento que envuelve una vista con marca
 * (`.cortex-brand`); `components/views/views.css` decide cuáles valen en claro
 * y cuáles en oscuro. Vacío si no hay marca: se ve Cortex.
 */
export function brandCssVars(
  primaryHex: string | null | undefined,
  secondaryHex?: string | null,
): Record<string, string> {
  const t = primaryHex ? brandTokens(primaryHex, secondaryHex) : null;
  if (!t) return {};
  const vars: Record<string, string> = {
    '--brand-button': channels(t.button),
    '--brand-button-hover': channels(t.buttonHover),
    '--brand-button-ink': channels(t.buttonInk),
  };
  for (const [prefix, set] of [
    ['bl', t.light],
    ['bd', t.dark],
  ] as const) {
    vars[`--${prefix}-primary`] = channels(set.primary);
    vars[`--${prefix}-primary-strong`] = channels(set.strong);
    vars[`--${prefix}-primary-soft`] = channels(set.soft);
    vars[`--${prefix}-primary-ink`] = channels(set.ink);
    vars[`--${prefix}-fill`] = channels(set.fill);
    vars[`--${prefix}-fill-2`] = channels(set.fill2);
  }
  return vars;
}

/**
 * LOS COLORES QUE MANDAN EN UN LOGO, para proponerlos como color de la marca.
 *
 * Recibe los píxeles RGBA de un logo ya reducido (el navegador lo dibuja en un
 * canvas pequeño) y devuelve hasta `max` colores distintos, del que más pesa al
 * que menos. Lo transparente no cuenta; el blanco, el negro y los grises casi
 * no cuentan (son el fondo y el texto del logo, no la marca), salvo que el logo
 * no tenga otra cosa.
 */
export function dominantColors(pixels: ArrayLike<number>, max = 3): string[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number; w: number }>();
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const a = pixels[i + 3] ?? 0;
    if (a < 128) continue;
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    const sat = hi === 0 ? 0 : (hi - lo) / hi;
    const light = (hi + lo) / 510;
    // Los neutros pesan poco: un logo negro sobre blanco aún propone su negro.
    const weight = sat < 0.15 || light > 0.94 || light < 0.06 ? 0.08 : 0.4 + sat;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cell = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0, w: 0 };
    cell.n += 1;
    cell.r += r;
    cell.g += g;
    cell.b += b;
    cell.w += weight;
    buckets.set(key, cell);
  }
  const ranked = [...buckets.values()]
    .sort((a, b) => b.w - a.w)
    .map((c) => [c.r / c.n, c.g / c.n, c.b / c.n] as Rgb);
  const picked: Rgb[] = [];
  for (const color of ranked) {
    if (picked.length >= max) break;
    // Dos tonos casi iguales no son dos propuestas.
    if (picked.some((p) => Math.hypot(p[0] - color[0], p[1] - color[1], p[2] - color[2]) < 60))
      continue;
    picked.push(color);
  }
  return picked.map(rgbToHex);
}
