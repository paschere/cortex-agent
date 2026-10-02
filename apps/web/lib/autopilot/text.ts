/**
 * Texto del piloto que necesitan también los componentes de cliente. Sin
 * dependencias: lo que importa de aquí un componente de cliente no arrastra
 * @cortex/agent-tools al navegador.
 */

/** Cierra una frase con un solo punto, aunque termine en «a. m.». */
export function endSentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}
