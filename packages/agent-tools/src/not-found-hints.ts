import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * «NO EXISTE COMO TABLA» NO SIGNIFICA «NO EXISTE».
 *
 * Tabla, vista, aplicación y fuente de la plataforma (`cortex.ventas`) son
 * cuatro cosas distintas que la gente —y el modelo— nombra igual. El
 * 2026-10-19 el modelo llamó `trackers.query` sobre «pagos» y «ventas» (son
 * fuentes de la plataforma) y `apps.get` sobre «indicadores_financieros» (es
 * una vista), recibió un NOT_FOUND seco y siguió probando a ciegas. Ahora el
 * error dice qué SÍ existe con ese nombre y cómo se lee.
 */

export type NamedKind = 'tabla' | 'vista' | 'aplicación';

/** Pura: las fuentes de la plataforma cuyo id o nombre se parece a `name`. */
export function platformSourceMatches(
  name: string,
  sources: Iterable<{ id: string; name: string }>,
): Array<{ id: string; name: string }> {
  const q = norm(name).replace(/^cortex[._]/, '');
  if (q.length < 3) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const s of sources) {
    const id = norm(s.id).replace(/^cortex[._]/, '');
    if (id === q || id.includes(q) || q.includes(id) || norm(s.name).includes(q))
      out.push({ id: s.id, name: s.name });
  }
  return out.slice(0, 4);
}

function norm(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._]+/g, '_');
}

/** Pura: arma la frase a partir de lo que se encontró. Vacía si no hay nada. */
export function renderNameHints(
  asked: NamedKind,
  found: {
    platform: Array<{ id: string; name: string }>;
    tables: Array<{ slug: string; name: string }>;
    views: Array<{ slug: string; name: string }>;
    apps: Array<{ slug: string; name: string }>;
  },
): string {
  const parts: string[] = [];
  if (asked !== 'tabla' && found.tables.length)
    parts.push(
      `Como TABLA sí existe: ${found.tables.map((t) => `«${t.slug}»`).join(', ')} (se lee con trackers_query y se escribe con trackers_upsert / trackers_upsert_many).`,
    );
  if (asked !== 'vista' && found.views.length)
    parts.push(
      `Como VISTA sí existe: ${found.views.map((v) => `«${v.slug}»`).join(', ')} (se abre con views_get; sus datos salen de las tablas que muestra, no se leen con trackers_query).`,
    );
  if (asked !== 'aplicación' && found.apps.length)
    parts.push(
      `Como APLICACIÓN sí existe: ${found.apps.map((a) => `«${a.slug}»`).join(', ')} (se abre con apps_get).`,
    );
  if (found.platform.length)
    parts.push(
      `Es una FUENTE de la plataforma, no una tabla: ${found.platform.map((p) => `«${p.id}» (${p.name})`).join(', ')}. No se lee con trackers_query: se muestra como fuente de un bloque de vista (views_create / views_update con tracker: "${found.platform[0]?.id}") o con la herramienta de su módulo (ventas, pagos, cartera, contabilidad…).`,
    );
  return parts.join(' ');
}

function likeTerm(name: string): string {
  return name
    .replace(/[%_,()*\\]/g, ' ')
    .trim()
    .slice(0, 40);
}

async function safeRows(
  run: () => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<Array<{ slug: string; name: string }>> {
  try {
    const { data, error } = await run();
    if (error || !Array.isArray(data)) return [];
    return data as Array<{ slug: string; name: string }>;
  } catch {
    return [];
  }
}

/**
 * Qué existe con ese nombre en este espacio (tabla, vista, app, fuente de la
 * plataforma). Nunca lanza: sin pistas devuelve ''.
 */
export async function whatExistsNamed(
  db: SupabaseClient,
  name: string,
  asked: NamedKind,
): Promise<string> {
  const term = likeTerm(name);
  if (term.length < 3) return '';
  const pattern = `%${term}%`;
  const look = (table: string) =>
    safeRows(() =>
      db.from(table).select('slug,name').or(`slug.ilike.${pattern},name.ilike.${pattern}`).limit(3),
    );
  const [tables, views, apps] = await Promise.all([
    asked === 'tabla' ? Promise.resolve([]) : look('trackers'),
    asked === 'vista' ? Promise.resolve([]) : look('custom_views'),
    asked === 'aplicación'
      ? Promise.resolve([])
      : safeRows(() =>
          db
            .from('custom_apps')
            .select('slug,name')
            .is('archived_at', null)
            .or(`slug.ilike.${pattern},name.ilike.${pattern}`)
            .limit(3),
        ),
  ]);
  // Import perezoso: views/sources arrastra medio catálogo y este módulo lo
  // importan las herramientas de tablas, apps y vistas.
  let platform: Array<{ id: string; name: string }> = [];
  try {
    const { PLATFORM_SOURCES } = await import('./views/sources');
    platform = platformSourceMatches(name, PLATFORM_SOURCES.values());
  } catch {
    /* sin pistas de fuentes */
  }
  return renderNameHints(asked, { platform, tables, views, apps });
}

/** Une el mensaje base con las pistas (si las hay). */
export async function notFoundWithHints(
  db: SupabaseClient,
  base: string,
  name: string,
  asked: NamedKind,
): Promise<string> {
  const hint = await whatExistsNamed(db, name, asked);
  return hint ? `${base} ${hint}` : base;
}
