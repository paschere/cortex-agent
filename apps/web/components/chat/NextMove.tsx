'use client';

import { useChatCompose } from './ChatCompose';

/**
 * El siguiente paso, ya redactado, en una tarjeta de cola.
 *
 * No manda el turno: lo deja en el compositor, que es donde una persona lo
 * puede retocar. Fuera del chat no hay compositor, y no se dibuja.
 */
export function NextMove({
  text,
  label = '¿Le escribo?',
}: {
  text: string;
  label?: string;
}) {
  const compose = useChatCompose();
  if (!compose) return null;

  return (
    <button
      type="button"
      onClick={() => compose(text)}
      className="text-micro font-semibold text-amber underline decoration-amber/40 underline-offset-4 transition-colors hover:decoration-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      {label}
    </button>
  );
}
