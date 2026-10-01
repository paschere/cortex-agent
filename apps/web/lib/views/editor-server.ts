import 'server-only';
import {
  type CatalogTracker,
  type ViewSource,
  blockSchema,
  checkSpecAgainst,
  computeView,
  getView,
  loadViewSources,
  trackerFieldsSchema,
  trackerSlugSchema,
  trackersOf,
  viewCatalog,
  viewSpecSchema,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  type EditorCatalog,
  type PreviewResult,
  problemsFromCheck,
  problemsFromZod,
} from './editor-spec';

/**
 * EL LIENZO, DEL LADO DEL SERVIDOR.
 *
 * Dos lecturas y ninguna escritura:
 *
 *   - `editorCatalog`: las fuentes que se pueden elegir en los menús. Es
 *     `viewCatalog` —el mismo que ve el diseñador— recortado a lo que un menú
 *     necesita: nombre, familia, si es de sólo lectura y sus campos. Sin filas
 *     de muestra: el lienzo no las usa y el Feed de quien edita no tiene por
 *     qué viajar entero a cada apertura.
 *   - `previewSpec`: el spec del lienzo, comprobado con el MISMO
 *     `viewSpecSchema` + `checkSpecAgainst` que el guardado, y calculado con el
 *     mismo `loadViewSources` + `computeView` que la página. Los problemas
 *     vuelven atados al bloque que los tiene; si la forma no pasa, no hay
 *     cálculo (el lienzo sigue mostrando el último bueno).
 *
 * Todo con el handle del espacio y el id de quien edita (`viewerId`): las
 * tablas del Feed son sólo suyas, igual que en el diseñador. La vista previa
 * nunca es escribible: editar celdas en un borrador escribiría filas de verdad.
 */

export async function editorCatalog(
  db: SupabaseClient,
  viewerId: string,
  viewId?: string | null,
): Promise<EditorCatalog> {
  const saved = viewId ? await getView(db, viewId) : null;
  const entries = await viewCatalog(db, {
    viewerId,
    keep: saved ? trackersOf(saved.spec) : [],
  });
  return {
    sources: entries.map((t) => ({
      slug: t.slug,
      name: t.name,
      description: t.description.slice(0, 240),
      kind: t.kind,
      sensitivity: t.sensitivity,
      readOnly: t.kind !== 'tracker',
      ...(t.opaque ? { opaque: true } : {}),
      fields: t.fields,
      // Las filas que tiene (las tablas del espacio y del Feed). La columna
      // «Datos» del estudio lo muestra; null en las fuentes de la plataforma,
      // que no se cuentan. No es parte de `EditorSource`: viaja de más.
      rowCount: t.rowCount,
    })),
    blockTypes: blockSchema.options.map((o) => o.shape.type.value as string),
  };
}

const newTrackerSchema = z.object({
  slug: trackerSlugSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  fields: trackerFieldsSchema,
});

export const previewInput = z.object({
  spec: z.unknown(),
  viewId: z.string().uuid().optional(),
  /** Las tablas que un borrador de Cortex propuso y todavía no existen. */
  newTrackers: z.array(newTrackerSchema).max(3).default([]),
});

export async function previewSpec(
  db: SupabaseClient,
  viewerId: string,
  input: z.infer<typeof previewInput>,
): Promise<PreviewResult> {
  const parsed = viewSpecSchema.safeParse(input.spec);
  if (!parsed.success)
    return { ok: true, view: null, problems: problemsFromZod(parsed.error.issues, input.spec) };
  const spec = parsed.data;

  const saved = input.viewId ? await getView(db, input.viewId) : null;
  const catalog: CatalogTracker[] = await viewCatalog(db, {
    viewerId,
    keep: saved ? trackersOf(saved.spec) : [],
    // Para comprobar basta lo que el spec nombra: no se lista el Feed entero.
    feedRefs: trackersOf(spec),
  });
  const known = new Set(catalog.map((t) => t.slug));
  for (const t of input.newTrackers) if (!known.has(t.slug)) catalog.push(t);
  const problems = problemsFromCheck(checkSpecAgainst(spec, catalog));

  const sources = await loadViewSources(db, spec, { viewerId });
  for (const t of input.newTrackers)
    if (!sources.has(t.slug))
      sources.set(t.slug, { tracker: t, rows: [], truncated: false } satisfies ViewSource);
  return { ok: true, view: computeView(spec, sources, new Date(), { writable: false }), problems };
}
