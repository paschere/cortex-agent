/**
 * «ARREGLAR CON CORTEX»: el contexto de un bloque roto, en una instrucción.
 *
 * Cuando un bloque dice «X ya no tiene los campos…» o «No se pudo cargar este
 * bloque», quien puede editar la app toca «Arreglar con Cortex» y se abre el
 * chat con esta instrucción ya escrita: dónde está el problema (app, pantalla,
 * bloque), el mensaje tal cual y qué se espera de Cortex (diagnosticar y
 * proponer; el arreglo pasa por confirmación como siempre). Quien no puede
 * editar usa «Avisar al administrador», que manda este mismo texto como aviso.
 * Puro: sin React ni red, se prueba solo.
 */

export interface FixContext {
  /** Nombre de la app, si el bloque vive en una. */
  appName?: string | null;
  appRef?: string | null;
  screenTitle?: string | null;
  screenSlug?: string | null;
  /** Nombre de la vista (cuando no es una app). */
  viewName?: string | null;
  blockId?: string | null;
  blockTitle?: string | null;
  /** Lo que la pantalla dijo, tal cual. */
  message: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Las llaves de campo que el mensaje nombra entre «», por si Cortex quiere empezar por ahí. */
export function quotedNames(message: string): string[] {
  return [...message.matchAll(/«([^»]{1,60})»/g)].map((m) => m[1] as string);
}

/** Dónde ocurrió, en una frase. */
export function whereOf(ctx: FixContext): string {
  const parts: string[] = [];
  if (clean(ctx.appName)) parts.push(`la aplicación «${clean(ctx.appName)}»`);
  else if (clean(ctx.viewName)) parts.push(`la vista «${clean(ctx.viewName)}»`);
  if (clean(ctx.screenTitle)) parts.push(`la pantalla «${clean(ctx.screenTitle)}»`);
  if (clean(ctx.blockTitle) || clean(ctx.blockId))
    parts.push(
      `el bloque «${clean(ctx.blockTitle) || clean(ctx.blockId)}»${clean(ctx.blockId) && clean(ctx.blockTitle) ? ` (id ${clean(ctx.blockId)})` : ''}`,
    );
  return parts.length ? parts.join(', ') : 'una pantalla';
}

/** La instrucción para Cortex. */
export function buildFixPrompt(ctx: FixContext): string {
  const names = quotedNames(ctx.message);
  return [
    `Arréglame un problema en ${whereOf(ctx)}.`,
    `Lo que se ve en pantalla: «${clip(clean(ctx.message), 400)}»`,
    names.length ? `Nombres que menciona: ${names.map((n) => `«${n}»`).join(', ')}.` : '',
    'Diagnostícalo primero (abre la app y la pantalla con apps.get, revisa las tablas y sus campos con trackers.list y mira cuáles bloques quedaron apuntando a algo que ya no existe), dime la causa en una o dos frases y propón el arreglo mínimo. No borres campos ni datos; lo que cambies pasa por confirmación como siempre.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** El aviso al administrador: título corto y cuerpo con lo mismo. */
export function buildReportNotice(
  ctx: FixContext,
  who: string,
): { title: string; body: string; dedupeKey: string } {
  const where = whereOf(ctx);
  return {
    title: `Algo no funciona en ${clean(ctx.appName) || clean(ctx.viewName) || 'una pantalla'}`,
    body: clip(
      `${who} avisa que falla ${where}: «${clip(clean(ctx.message), 240)}». Ábrela y pídele a Cortex que lo arregle.`,
      500,
    ),
    dedupeKey:
      `block-problem:${clean(ctx.appRef) || clean(ctx.viewName)}:${clean(ctx.screenSlug)}:${clean(ctx.blockId)}`.slice(
        0,
        120,
      ),
  };
}

/** La dirección del chat con la instrucción ya escrita (sólo para quien tiene sesión de Cortex). */
export function chatHrefWith(prompt: string): string {
  return `/chat?prompt=${encodeURIComponent(prompt.slice(0, 3800))}`;
}
