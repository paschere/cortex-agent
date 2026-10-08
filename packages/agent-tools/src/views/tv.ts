/**
 * EL TABLERO TV: LA ROTACIÓN, SIN REACT Y SIN RED.
 *
 * `spec.theme.layout: 'tv'` convierte la vista en una pantalla de planta: una
 * sección a la vez, a pantalla completa, que cambia sola cada `rotateSeconds`.
 * Las secciones son las páginas de la vista; una vista sin páginas rota de a
 * un bloque (lo que se puede mirar de lejos: no hay formularios ni asistente de
 * voz en una pantalla en la que nadie toca nada).
 *
 * Todo esto es aritmética sobre el reloj, a propósito: la sección que toca en
 * este instante sale de `elapsedMs`, sin estado que se desfase. Dos pantallas
 * abiertas a la vez muestran la misma sección, y una que despierta de dormir
 * no «se pone al día» pasando por todas.
 *
 * Importa SÓLO tipos (el navegador carga este archivo sin el barril del
 * paquete, que arrastra módulos de servidor).
 */

import type { ComputedBlock } from './compute';

export interface TvSlide {
  id: string;
  title: string;
  blockIds: string[];
}

/** Lo que no se mira en una pantalla de pared. */
const NOT_FOR_WALL = new Set<ComputedBlock['type']>(['form', 'voice', 'links']);

export function tvSlides(
  blocks: ComputedBlock[],
  pages: Array<{ id: string; title: string; blockIds: string[] }> = [],
): TvSlide[] {
  const visible = blocks.filter((b) => !NOT_FOR_WALL.has(b.type) && b.type !== 'detail');
  const ids = new Set(visible.map((b) => b.id));
  if (pages.length > 1) {
    const slides = pages
      .map((p) => ({
        id: p.id,
        title: p.title,
        blockIds: p.blockIds.filter((id) => ids.has(id)),
      }))
      .filter((s) => s.blockIds.length > 0);
    if (slides.length) return slides;
  }
  // Sin páginas: las cifras juntas (una fila de indicadores) y cada otro bloque solo.
  const metrics = visible.filter((b) => b.type === 'metric');
  const others = visible.filter((b) => b.type !== 'metric');
  const slides: TvSlide[] = [];
  if (metrics.length)
    slides.push({ id: 'cifras', title: 'Indicadores', blockIds: metrics.map((b) => b.id) });
  for (const b of others)
    slides.push({
      id: b.id,
      title: 'title' in b && b.title ? b.title : 'Pantalla',
      blockIds: [b.id],
    });
  return slides;
}

/** Cuál sección toca a los `elapsedMs` de haber empezado, con `rotateSeconds` por sección. */
export function tvSlideAt(count: number, elapsedMs: number, rotateSeconds: number): number {
  if (count <= 1) return 0;
  const step = Math.max(1, rotateSeconds) * 1000;
  const n = Math.floor(Math.max(0, elapsedMs) / step);
  return n % count;
}

/** Segundos que faltan para cambiar de sección (para la barra de avance). */
export function tvSecondsLeft(elapsedMs: number, rotateSeconds: number): number {
  const step = Math.max(1, rotateSeconds) * 1000;
  return Math.ceil((step - (Math.max(0, elapsedMs) % step)) / 1000);
}

/** La hora que se pinta en el reloj (24 h, Bogotá). */
export function tvClock(now: Date, timeZone = 'America/Bogota'): { time: string; date: string } {
  const time = new Intl.DateTimeFormat('es-CO', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const date = new Intl.DateTimeFormat('es-CO', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now);
  return { time, date };
}
