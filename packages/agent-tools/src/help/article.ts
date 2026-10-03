import { MODULE_KEYS, type ModuleKey } from '../modules/catalog';

/**
 * UN ARTÍCULO DE AYUDA, LEÍDO DE SU MARKDOWN.
 *
 * Los artículos viven versionados en `apps/web/content/ayuda/*.md` y entran al
 * paquete como texto crudo por `sources.generated.ts` (lo escribe
 * `scripts/build-help-index.mjs`). Aquí se parte el frontmatter y se valida: un
 * artículo con un módulo que no existe o sin ruta no entra, y la prueba
 * `help/__tests__/frontmatter.test.ts` falla con el nombre del archivo.
 *
 * El frontmatter es un subconjunto pequeño y a propósito de YAML: `clave: valor`
 * por línea, listas en una línea entre corchetes. Sin dependencia nueva y sin
 * sorpresas de YAML (un «no» que se vuelve `false`).
 */

export const HELP_CATEGORIES = [
  'empezar',
  'conexiones',
  'informacion',
  'plata',
  'operacion',
  'equipo',
  'automatizacion',
  'canales',
  'cuenta',
] as const;

export type HelpCategory = (typeof HELP_CATEGORIES)[number];

export const HELP_CATEGORY_LABEL: Record<HelpCategory, string> = {
  empezar: 'Para empezar',
  conexiones: 'Conectar tus programas',
  informacion: 'Tu información',
  plata: 'Plata',
  operacion: 'Operación',
  equipo: 'Equipo',
  automatizacion: 'Lo que Cortex hace solo',
  canales: 'WhatsApp',
  cuenta: 'Cuenta, seguridad y plan',
};

/** `general` = siempre visible; si no, la clave del módulo que lo gobierna. */
export type HelpModule = 'general' | ModuleKey;

export interface HelpArticle {
  slug: string;
  title: string;
  summary: string;
  category: HelpCategory;
  module: HelpModule;
  /** La pantalla principal del artículo. */
  route: string;
  /** Otras pantallas donde sale en la ayuda contextual. */
  routes: string[];
  keywords: string[];
  /** AAAA-MM-DD. */
  updated: string;
  order: number;
  /** El cuerpo en Markdown, sin el frontmatter. */
  body: string;
}

export class HelpArticleError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'HelpArticleError';
  }
}

const ROUTE_RE = /^\/[a-z0-9\-/]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseList(value: string): string[] {
  const v = value.trim();
  if (!v.startsWith('[') || !v.endsWith(']')) return v ? [unquote(v)] : [];
  return v
    .slice(1, -1)
    .split(',')
    .map((item) => unquote(item))
    .filter((item) => item.length > 0);
}

/** Separa el frontmatter del cuerpo. Lanza si no hay frontmatter. */
export function splitFrontmatter(
  file: string,
  raw: string,
): { fields: Map<string, string>; body: string } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) throw new HelpArticleError(file, 'falta el frontmatter (---)');
  const end = text.indexOf('\n---', 4);
  if (end < 0) throw new HelpArticleError(file, 'el frontmatter no se cierra (---)');
  const head = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n+/, '');
  const fields = new Map<string, string>();
  for (const line of head.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) throw new HelpArticleError(file, `línea de frontmatter sin «clave:»: ${line}`);
    const key = line.slice(0, colon).trim();
    if (fields.has(key)) throw new HelpArticleError(file, `«${key}» repetido`);
    fields.set(key, line.slice(colon + 1).trim());
  }
  return { fields, body };
}

/** El slug de un archivo: `ayuda/por-pagar.md` → `por-pagar`. */
export function slugFromFile(file: string): string {
  const base = file.split('/').pop() ?? file;
  return base.replace(/\.md$/, '');
}

/** Lee y valida un artículo. Lanza `HelpArticleError` con el porqué. */
export function parseHelpArticle(file: string, raw: string): HelpArticle {
  const slug = slugFromFile(file);
  if (!SLUG_RE.test(slug)) throw new HelpArticleError(file, `nombre de archivo inválido: ${slug}`);
  const { fields, body } = splitFrontmatter(file, raw);

  const required = (key: string): string => {
    const value = unquote(fields.get(key) ?? '');
    if (!value) throw new HelpArticleError(file, `falta «${key}»`);
    return value;
  };

  const title = required('title');
  const summary = required('summary');
  const category = required('category');
  if (!(HELP_CATEGORIES as readonly string[]).includes(category)) {
    throw new HelpArticleError(file, `categoría desconocida: ${category}`);
  }
  const module = required('module');
  if (module !== 'general' && !(MODULE_KEYS as readonly string[]).includes(module)) {
    throw new HelpArticleError(file, `módulo desconocido: ${module}`);
  }
  const route = required('route');
  const routes = parseList(fields.get('routes') ?? '');
  for (const r of [route, ...routes]) {
    if (!ROUTE_RE.test(r) || (r.length > 1 && r.endsWith('/'))) {
      throw new HelpArticleError(file, `ruta inválida: ${r}`);
    }
  }
  const keywords = parseList(fields.get('keywords') ?? '').map((k) => k.toLowerCase());
  if (keywords.length === 0) throw new HelpArticleError(file, 'faltan «keywords»');
  const updated = required('updated');
  if (!DATE_RE.test(updated)) throw new HelpArticleError(file, `fecha inválida: ${updated}`);
  const orderRaw = fields.get('order');
  const order = orderRaw ? Number(orderRaw) : 99;
  if (!Number.isFinite(order)) throw new HelpArticleError(file, `order inválido: ${orderRaw}`);
  if (body.trim().length < 200) throw new HelpArticleError(file, 'el cuerpo está casi vacío');

  return {
    slug,
    title,
    summary,
    category: category as HelpCategory,
    module: module as HelpModule,
    route,
    routes: routes.filter((r) => r !== route),
    keywords,
    updated,
    order,
    body,
  };
}

/** Las pantallas donde el artículo es ayuda contextual: la principal primero. */
export function articleRoutes(article: HelpArticle): string[] {
  return [article.route, ...article.routes];
}

/** ¿Lo ve una empresa con estos módulos encendidos? `undefined` = sin filtro. */
export function isArticleVisible(
  article: HelpArticle,
  enabled: ReadonlySet<string> | undefined,
): boolean {
  if (article.module === 'general' || !enabled) return true;
  return enabled.has(article.module);
}

/** La sección `## <título>` del cuerpo, sin el encabezado, o `null`. */
export function articleSection(article: HelpArticle, heading: string): string | null {
  const lines = article.body.split('\n');
  const start = lines.findIndex(
    (line) =>
      line.startsWith('## ') && line.slice(3).trim().toLowerCase() === heading.toLowerCase(),
  );
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const text = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  return text || null;
}

/** El primer párrafo del cuerpo (la entrada antes del primer encabezado). */
export function articleLead(article: HelpArticle): string {
  const firstHeading = article.body.search(/^## /m);
  const lead = (firstHeading < 0 ? article.body : article.body.slice(0, firstHeading)).trim();
  return lead || article.summary;
}
