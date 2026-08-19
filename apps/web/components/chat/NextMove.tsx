'use client';

import { useChatCompose } from './ChatCompose';

/**
 * El siguiente paso, ya redactado, en una tarjeta de cola.
 *
 * Un toque manda el turno — el mismo `ask` del briefing vacío. No aprueba el
 * correo: propone. Fuera del chat no hay a quién mandárselo, y no se dibuja.
 */
export function NextMove({
  text,
  label = '¿Le escribo?',
}: {
  text: string;
  label?: string;
}) {
  const chat = useChatCompose();
  if (!chat) return null;

  return (
    <button
      type="button"
      onClick={() => chat.ask(text)}
      className="text-sm font-semibold text-amber underline decoration-amber/40 underline-offset-4 transition-colors hover:decoration-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      {label}
    </button>
  );
}
