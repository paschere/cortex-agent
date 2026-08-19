'use client';

import { createContext, useContext } from 'react';

/**
 * El compositor, visto desde una tarjeta.
 *
 * Una cola que enseña el siguiente paso ya redactado no puede mandar el turno
 * sola: la persona tiene que poder leerlo y tocarlo. La tarjeta escribe en el
 * borrador; el compositor es quien manda. Fuera de `ChatRoot` —un panel, una
 * pantalla— no hay compositor, y el botón no se dibuja.
 */

const ChatComposeContext = createContext<((text: string) => void) | null>(null);

export function ChatComposeProvider({
  compose,
  children,
}: {
  compose: (text: string) => void;
  children: React.ReactNode;
}) {
  return <ChatComposeContext.Provider value={compose}>{children}</ChatComposeContext.Provider>;
}

export function useChatCompose(): ((text: string) => void) | null {
  return useContext(ChatComposeContext);
}
