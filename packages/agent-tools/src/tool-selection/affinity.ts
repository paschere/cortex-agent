import { type SelectableTool, toolFamily } from './rank';

/**
 * EL PAQUETE DE «TRABAJO SOBRE TABLAS, APPS Y VISTAS».
 *
 * Una app es pantallas sobre tablas, y una vista es lo mismo en pequeño: el
 * trabajo real sobre una de ellas toca las tres a la vez (crear la tabla,
 * llenarla, cambiar la pantalla, publicar). Pero la selección semántica
 * puntúa cada FAMILIA contra la frase del turno, y una frase como «sigue» o
 * «Aprobé y ya se ejecutó» no se parece a ninguna. El 2026-10-19, editando
 * una app (conversación 0f090141), el turno ofrecía `apps.*` y NADA de
 * `trackers.*`: el modelo dijo «no tengo herramienta para buscar filas» (hizo
 * web_search habiendo trackers.query) y «no tengo herramienta para escribir
 * filas» (trackers.upsert existía).
 *
 * La regla: si el turno ya trae —por ranking, por intención o porque la
 * conversación ya las usó (lo «pegajoso»)— cualquier herramienta de estas tres
 * familias, trae también el paquete mínimo para LEER y ESCRIBIR las tres. Es un
 * puñado de declaraciones (no las ~50 de las tres familias enteras) y, como
 * viajan por el mecanismo pegajoso, quedan fijas en el prefijo del caché.
 */
export const TABLE_WORK_FAMILIES: readonly string[] = ['trackers', 'apps', 'views'];

export const TABLE_WORK_CORE_IDS: readonly string[] = [
  'trackers.list',
  'trackers.query',
  'trackers.define',
  'trackers.upsert',
  'trackers.upsert_many',
  'trackers.remove',
  'trackers.set_flow',
  'apps.list',
  'apps.get',
  'apps.create',
  'apps.update',
  'apps.apply_draft',
  'apps.publish',
  'views.list',
  'views.get',
  'views.create',
  'views.update',
];

/**
 * Pura. Devuelve las herramientas del paquete que faltan en `selected` y que
 * están entre las permitidas (`all`), o [] si el turno no trabaja sobre
 * tablas/apps/vistas. `contextFamilies` son las familias que la conversación
 * ya usó (ids pegajosos).
 */
export function tableWorkAdditions<T extends SelectableTool>(
  selected: readonly T[],
  all: readonly T[],
  contextFamilies: readonly string[] = [],
): T[] {
  const present = new Set<string>(contextFamilies);
  for (const t of selected) present.add(toolFamily(t));
  if (!TABLE_WORK_FAMILIES.some((f) => present.has(f))) return [];
  const have = new Set(selected.map((t) => t.id));
  const core = new Set(TABLE_WORK_CORE_IDS);
  return all.filter((t) => core.has(t.id) && !have.has(t.id));
}
