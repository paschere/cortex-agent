import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { VIEW_TIMEZONE, computeView, todayIn } from '../views/compute';
import { type ViewSpec, filterSchema, viewSpecSchema } from '../views/spec';
import { loadViewSources } from '../views/store';
import { type ResolvedRole, rowAccessFor, rowScopeFor } from './permissions';
import type { AppAccess } from './store';

/**
 * APARIENCIA E INICIO DE UNA APLICACIÓN (migración 0215).
 *
 * Dos documentos JSON en `custom_apps`:
 *
 *   - `brand`: la marca PROPIA de la app, encima de la de la empresa (que
 *     sigue siendo el valor por defecto): color principal y de acento, nombre
 *     corto, tipografía, pantalla de bienvenida y las imágenes subidas (logo,
 *     ícono cuadrado, imagen de bienvenida) por su versión. Una app sin
 *     `brand` se ve exactamente como antes.
 *   - `home`: la pantalla «Inicio» con tarjetas por rol. NO es una vista
 *     guardada: es una pantalla sintética (slug `inicio`) cuyas cifras se
 *     calculan con el mismo motor de las vistas (`computeView`) y el mismo
 *     scope de filas del rol de quien mira (`rowScopeFor`). Una tarjeta sobre
 *     una tabla que el rol no puede leer ni aparece: ni el nombre ni la cifra.
 *
 * Este archivo es lo PURO (esquemas, textos, resolución de tarjetas por rol,
 * armado del spec) más `computeHome`, que sólo lee.
 */

// ---------------------------------------------------------------------------
// Marca de la app
// ---------------------------------------------------------------------------

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

export function parseBrand(raw: unknown): AppBrand {
  const parsed = appBrandSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** Aplica un cambio parcial: `null` borra el campo, ausente lo deja como está. Los archivos no se tocan. */
export function mergeBrand(current: AppBrand, patch: AppBrandPatch): AppBrand {
  const next: AppBrand = { ...current };
  for (const key of ['primary', 'accent', 'shortName', 'font', 'welcome'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null || (typeof value === 'string' && !value.trim())) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Inicio con tarjetas
// ---------------------------------------------------------------------------

export const HOME_SLUG = 'inicio';
export const MAX_HOME_CARDS = 8;
export const CARD_TONES = ['primary', 'emerald', 'amber', 'sky', 'rose'] as const;
export type CardTone = (typeof CARD_TONES)[number];

const cardBase = {
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  /** Claves de los roles que la ven. Vacío = todos. */
  roles: z.array(z.string().trim().max(48)).max(8).default([]),
  tone: z.enum(CARD_TONES).default('primary'),
};

const countSource = {
  source: z.string().trim().min(1).max(80),
  filters: z.array(filterSchema).max(6).default([]),
  /** A qué pantalla lleva tocar la tarjeta (slug). */
  screen: z.string().trim().max(48).optional(),
  /** Para abrir la lista ya filtrada: el id del filtro de la barra de esa pantalla y su valor. */
  openFilterId: z.string().trim().max(40).optional(),
  openFilterValue: z.string().trim().max(120).optional(),
};

/** «Hoy llegan {n} vuelos»: una cifra con texto, sobre una tabla con filtros. */
export const counterCardSchema = z.object({
  ...cardBase,
  ...countSource,
  kind: z.literal('counter'),
  text: z.string().trim().min(1).max(120),
  /** Texto cuando la cifra es cero («Aún no hay vuelos hoy»). */
  zeroText: z.string().trim().max(120).optional(),
});

/** «{n} guías duplicadas por corregir»: lo pendiente, con las primeras filas y un enlace a la lista. */
export const pendingCardSchema = z.object({
  ...cardBase,
  ...countSource,
  kind: z.literal('pending'),
  tone: z.enum(CARD_TONES).default('amber'),
  text: z.string().trim().min(1).max(120),
  /** Texto cuando no queda nada pendiente («Todo al día»). */
  zeroText: z.string().trim().max(120).optional(),
});

/** Acceso directo a una pantalla («Registrar atención»). */
export const shortcutCardSchema = z.object({
  ...cardBase,
  kind: z.literal('shortcut'),
  label: z.string().trim().min(1).max(40),
  hint: z.string().trim().max(80).optional(),
  screen: z.string().trim().min(1).max(48),
  icon: z.string().trim().max(40).optional(),
});

export const homeCardSchema = z.discriminatedUnion('kind', [
  counterCardSchema,
  pendingCardSchema,
  shortcutCardSchema,
]);
export type HomeCard = z.infer<typeof homeCardSchema>;

export const appHomeSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** El saludo con el nombre y la fecha. */
    greeting: z.boolean().default(true),
    cards: z.array(homeCardSchema).max(MAX_HOME_CARDS).default([]),
  })
  .superRefine((home, ctx) => {
    const seen = new Set<string>();
    for (const [i, card] of home.cards.entries()) {
      if (seen.has(card.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `El id de tarjeta «${card.id}» está repetido.`,
          path: ['cards', i, 'id'],
        });
      seen.add(card.id);
    }
  });
export type AppHome = z.infer<typeof appHomeSchema>;

export function parseHome(raw: unknown): AppHome | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = appHomeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** ¿Esta app tiene Inicio encendido (y al menos algo que mostrar o un saludo)? */
export function homeEnabled(home: AppHome | null | undefined): home is AppHome {
  return Boolean(home?.enabled);
}

const NUMBER = new Intl.NumberFormat('es-CO');

/** «Hoy llegan {n} vuelos» + 3 → «Hoy llegan 3 vuelos». */
export function fillCardText(text: string, n: number): string {
  return text.replaceAll('{n}', NUMBER.format(n));
}

/** El texto que se muestra: el de cero si la cifra es cero y hay uno. */
export function cardText(
  card: Pick<HomeCard & { kind: 'counter' | 'pending' }, 'text' | 'zeroText'>,
  n: number,
): string {
  return fillCardText(n === 0 && card.zeroText ? card.zeroText : card.text, n);
}

/** `{hoy}`, `{ayer}` y `{manana}` en el valor de un filtro → la fecha de Bogotá. */
export function resolveFilterTokens<F extends { value?: string | number }>(
  filters: F[],
  now: Date,
): F[] {
  const today = todayIn(now);
  const shift = (days: number) =>
    todayIn(new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000));
  const tokens: Record<string, string> = {
    '{hoy}': today,
    '{ayer}': shift(-1),
    '{manana}': shift(1),
  };
  return filters.map((f) =>
    typeof f.value === 'string' && f.value in tokens ? { ...f, value: tokens[f.value] } : f,
  );
}

/**
 * Las tarjetas que ESTE rol ve. Administrador: todas. Las que cuentan filas
 * de una tabla sin permiso de lectura NO aparecen (ni el nombre ni la cifra),
 * y un acceso directo a una pantalla que el rol no ve tampoco.
 */
export function cardsForRole(
  home: AppHome,
  role: ResolvedRole,
  visibleScreenSlugs: ReadonlySet<string>,
  user: Parameters<typeof rowAccessFor>[1],
): HomeCard[] {
  return home.cards.filter((card) => {
    if (!role.admin && card.roles.length > 0 && !card.roles.includes(role.key)) return false;
    if (card.kind === 'shortcut') return visibleScreenSlugs.has(card.screen);
    if (rowAccessFor(role, user, card.source).kind === 'none') return false;
    // Un enlace a una pantalla ajena no se ofrece: la tarjeta cuenta, pero no abre.
    return true;
  });
}

const HOME_VIEW_BASE = {
  version: 1,
  accent: 'primary',
  refreshSeconds: 0,
  editing: 'off',
  alerts: [],
} as const;

/** Cuántas filas de ejemplo lleva una tarjeta de pendientes. */
const PENDING_SAMPLE = 3;

/** El spec sintético que calcula todas las tarjetas de una vez: una cifra por tarjeta y 3 filas por pendiente. */
export function homeSpecFor(cards: HomeCard[], now: Date): ViewSpec | null {
  const blocks: unknown[] = [];
  for (const card of cards) {
    if (card.kind === 'shortcut') continue;
    const filters = resolveFilterTokens(card.filters, now);
    blocks.push({
      id: `n_${card.id}`,
      type: 'metric',
      title: card.id,
      tracker: card.source,
      filters,
      aggregate: 'count',
    });
    if (card.kind === 'pending')
      blocks.push({
        id: `r_${card.id}`,
        type: 'table',
        title: card.id,
        tracker: card.source,
        filters,
        limit: PENDING_SAMPLE,
        searchable: false,
        openRecord: false,
      });
  }
  if (!blocks.length) return null;
  const parsed = viewSpecSchema.safeParse({ ...HOME_VIEW_BASE, blocks });
  return parsed.success ? parsed.data : null;
}

export interface ComputedHomeCard {
  id: string;
  kind: HomeCard['kind'];
  tone: CardTone;
  /** Texto ya con la cifra puesta (contador y pendiente) o la etiqueta (acceso directo). */
  text: string;
  hint: string | null;
  n: number | null;
  icon: string | null;
  /** Pantalla a la que lleva, sólo si el rol la ve. */
  screen: string | null;
  /** `id=valor` para el parámetro `f` de la pantalla de destino. */
  filter: string | null;
  /** Las primeras filas pendientes (texto de su primera columna). */
  rows: string[];
  /** La cifra es cero: la tarjeta guía en vez de celebrar. */
  empty: boolean;
}

export interface ComputedHome {
  greeting: { title: string; date: string } | null;
  cards: ComputedHomeCard[];
  computedAt: string;
}

/** «Buenos días, Ana» y «miércoles 7 de octubre», en la hora de Bogotá. */
export function greetingFor(name: string, now: Date): { title: string; date: string } {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: VIEW_TIMEZONE,
    }).format(now),
  );
  const part = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
  const first = name.trim().split(/\s+/)[0] ?? '';
  const date = new Intl.DateTimeFormat('es-CO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: VIEW_TIMEZONE,
  }).format(now);
  return { title: first ? `${part}, ${first}` : part, date };
}

/** Las pantallas del menú con «Inicio» de primera si la app lo tiene encendido. */
export function withHomeFirst<T extends { slug: string }>(
  screens: T[],
  home: AppHome | null | undefined,
  homeScreen: T,
): T[] {
  return homeEnabled(home) ? [homeScreen, ...screens] : screens;
}

/**
 * Calcula el Inicio PARA ESTE ROL. Mismo camino que `readScreen`: el scope de
 * filas entra a `loadViewSources` antes de contar, así que las cifras son sólo
 * de lo que el rol puede ver.
 */
export async function computeHome(
  db: SupabaseClient,
  access: AppAccess,
  home: AppHome,
  visibleScreenSlugs: ReadonlySet<string>,
  now: Date = new Date(),
): Promise<ComputedHome> {
  const cards = cardsForRole(home, access.role, visibleScreenSlugs, access.user);
  const spec = homeSpecFor(cards, now);
  let computed: ReturnType<typeof computeView> | null = null;
  if (spec) {
    const sources = await loadViewSources(db, spec, {
      audience: access.role.admin ? 'team' : 'public',
      viewerId: access.role.admin ? access.user.id : null,
      scope: rowScopeFor(access.role, access.user, spec),
    });
    computed = computeView(spec, sources, now, {
      writable: false,
      audience: access.role.admin ? 'team' : 'public',
      filters: {},
    });
  }
  const block = (id: string) => computed?.blocks.find((b) => b.id === id);
  const out: ComputedHomeCard[] = cards.map((card) => {
    if (card.kind === 'shortcut')
      return {
        id: card.id,
        kind: 'shortcut',
        tone: card.tone,
        text: card.label,
        hint: card.hint ?? null,
        n: null,
        icon: card.icon ?? null,
        screen: card.screen,
        filter: null,
        rows: [],
        empty: false,
      };
    const metric = block(`n_${card.id}`);
    const n = metric?.type === 'metric' ? Math.round(metric.value ?? 0) : 0;
    const table = card.kind === 'pending' ? block(`r_${card.id}`) : null;
    const rows =
      table?.type === 'table' ? table.rows.map((r) => r.cells[0] ?? '').filter(Boolean) : [];
    const target = card.screen && visibleScreenSlugs.has(card.screen) ? card.screen : null;
    return {
      id: card.id,
      kind: card.kind,
      tone: card.tone,
      text: cardText(card, n),
      hint: null,
      n,
      icon: null,
      screen: target,
      filter:
        target && card.openFilterId && card.openFilterValue
          ? `${card.openFilterId}=${card.openFilterValue}`
          : null,
      rows,
      empty: n === 0,
    };
  });
  return {
    greeting: home.greeting ? greetingFor(access.user.name, now) : null,
    cards: out,
    computedAt: now.toISOString(),
  };
}

/** Lo que la herramienta de chat y el editor muestran de una app: la apariencia en pocas líneas. */
export function appearanceSummary(brand: AppBrand, home: AppHome | null): string[] {
  const lines: string[] = [];
  if (brand.primary) lines.push(`color principal ${brand.primary}`);
  if (brand.accent) lines.push(`acento ${brand.accent}`);
  if (brand.shortName) lines.push(`nombre corto «${brand.shortName}»`);
  if (brand.font) lines.push(`letra ${APP_FONT_LABEL[brand.font]}`);
  if (brand.welcome?.title || brand.welcome?.text) lines.push('pantalla de bienvenida');
  if (brand.files?.logo) lines.push('logo propio');
  if (homeEnabled(home)) lines.push(`Inicio con ${home.cards.length} tarjetas`);
  return lines;
}
