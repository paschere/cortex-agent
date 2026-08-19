'use client';

import { createContext, useContext } from 'react';

/**
 * El compositor, visto desde una tarjeta.
 *
 * El sí de una cola MANDÁ el turno. Rellenar el compositor y esperar a que
 * alguien pulse enviar es un índice que se lee y no se contesta — el mismo
 * fallo que el briefing vacío ya dejó atrás. `ask` es `handleSend`: la
 * pregunta entra al hilo por la misma puerta que si la hubiera escrito. El
 * modelo propone (`actions.propose`); aprobar el envío sigue siendo el
 * segundo toque, en la tarjeta. `compose` queda para lo que no es un sí:
 * citar, retocar, seguir.
 *
 * Fuera de `ChatRoot` no hay compositor, y el botón no se dibuja.
 */

export interface ChatCompose {
  compose: (text: string) => void;
  ask: (text: string) => void;
}

const ChatComposeContext = createContext<ChatCompose | null>(null);

export function ChatComposeProvider({
  compose,
  ask,
  children,
}: {
  compose: (text: string) => void;
  ask: (text: string) => void;
  children: React.ReactNode;
}) {
  return (
    <ChatComposeContext.Provider value={{ compose, ask }}>{children}</ChatComposeContext.Provider>
  );
}

export function useChatCompose(): ChatCompose | null {
  return useContext(ChatComposeContext);
}
