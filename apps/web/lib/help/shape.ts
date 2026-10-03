import { buildRail, primaryNav } from '../nav-shape';

/**
 * LA AYUDA, VISTA DESDE EL NAVEGADOR.
 *
 * El panel «?» y el formulario de soporte son componentes de cliente, y el
 * barril de `@cortex/agent-tools` no entra en el bundle de cliente (arrastra
 * `node:dns`). Así que aquí va sólo la forma de lo que viaja del servidor al
 * panel y dos ayudas puras; la búsqueda y los artículos se quedan en el
 * servidor (app/(app)/ayuda/actions.ts).
 */

export interface PanelArticle {
  slug: string;
  title: string;
  summary: string;
  /** La pantalla de la que habla. */
  route: string;
  /** El pedazo que casó con la búsqueda, si hubo búsqueda. */
  excerpt?: string;
}

export interface HelpPanelData {
  /** «Por pagar», «Datos y conexiones»: el nombre de la pantalla abierta. */
  screen: string | null;
  articles: PanelArticle[];
  /** Si el canal de soporte está prendido (SUPPORT_CHANNEL). */
  supportEnabled: boolean;
}

/** El nombre de la pantalla, con la misma regla que la barra de arriba. */
export function screenLabel(path: string): string | null {
  if (path === '/ayuda' || path.startsWith('/ayuda/')) return 'Ayuda';
  const rail = buildRail([], true);
  const items = [
    ...primaryNav({ admin: true, founder: true }),
    ...rail.pinned,
    ...rail.waiting,
    ...rail.rest.flatMap((s) => s.items),
    ...rail.company.items,
    ...rail.footer,
  ];
  const current = items
    .filter((i) => path === i.href || path.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return current?.label ?? null;
}

/** El chat con la pregunta escrita, lista para enviar. */
export function askCortexHref(question: string): string {
  return `/chat?prompt=${encodeURIComponent(question.trim().slice(0, 600))}`;
}

/** La pregunta por defecto para «Pregúntale a Cortex» desde una pantalla. */
export function defaultQuestion(screen: string | null): string {
  return screen ? `¿Cómo uso ${screen} en Cortex?` : '¿Cómo uso Cortex?';
}
