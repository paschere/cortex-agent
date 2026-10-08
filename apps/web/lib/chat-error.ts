/**
 * LO QUE VE LA PERSONA CUANDO UN TURNO NO TERMINA BIEN.
 *
 * Una frase en español y qué hacer, nunca el error técnico (en inglés, con
 * JSON) — ése queda en el log. Vive aquí y no en la ruta porque el cliente
 * también tiene que reconocerlas: un turno CORTADO (tiempo, red) se retoma con
 * «sigue» y lo hecho quedó guardado; un error de verdad se reintenta.
 */

export const CHAT_ERRORS = {
  toolArgs:
    'Se me enredó una pregunta que te iba a hacer. Escríbeme «sigue» y continúo desde aquí.',
  busy: 'Hay mucha demanda en este momento. Espera unos segundos y escríbeme «sigue».',
  timeout:
    'Se me acabó el tiempo de este turno. Lo que alcancé a hacer quedó guardado: toca «Continuar» y sigo desde ahí.',
  cut: 'Se cortó la conexión mientras respondía. Lo que alcancé a hacer quedó guardado: toca «Continuar» y retomo.',
  tooLong:
    'La conversación quedó demasiado larga para seguir aquí. Abre una nueva y te resumo lo importante.',
  generic:
    'Algo falló mientras respondía. Escríbeme «sigue» para retomar; si se repite, avísale al equipo de Cortex.',
} as const;

/** El texto del error del stream, ya en español. `deadline` si el corte fue nuestro por tiempo. */
export function humanChatError(message: string, opts: { deadline?: boolean } = {}): string {
  if (opts.deadline) return CHAT_ERRORS.timeout;
  if (/Invalid arguments for tool|Type validation failed|InvalidToolArguments/i.test(message))
    return CHAT_ERRORS.toolArgs;
  if (/rate.?limit|429|overloaded|529/i.test(message)) return CHAT_ERRORS.busy;
  if (/Task timed out|Runtime Timeout|FUNCTION_INVOCATION_TIMEOUT|TimeoutError/i.test(message))
    return CHAT_ERRORS.timeout;
  if (/timeout|timed out|aborted|ETIMEDOUT|ECONNRESET|fetch failed/i.test(message))
    return CHAT_ERRORS.cut;
  // Sólo los errores que de verdad hablan del largo de la conversación. Con un
  // /context/ suelto, cualquier «Cannot read … 'context'» se leía como «la
  // conversación quedó demasiado larga» en un chat recién abierto.
  if (
    /prompt is too long|context length|context window|maximum context|input is too long|too many (input )?tokens|exceeds? the (maximum|context)/i.test(
      message,
    )
  )
    return CHAT_ERRORS.tooLong;
  return CHAT_ERRORS.generic;
}

export type ChatErrorKind = 'interrupted' | 'error';

/**
 * Lo que el cliente hace con un error de `useChat`: el texto que muestra y si
 * es un CORTE (se retoma con «Continuar») o un error (se reintenta).
 *
 * Un stream que la plataforma corta no trae parte de error: `fetch` revienta
 * con «network error», «terminated», «Load failed»… según el navegador. Eso es
 * un corte, no un fallo de Cortex, y se dice así.
 */
export function classifyClientChatError(raw: string): { message: string; kind: ChatErrorKind } {
  const text = raw.trim();
  if (text === CHAT_ERRORS.timeout || text === CHAT_ERRORS.cut)
    return { message: text, kind: 'interrupted' };
  if ((Object.values(CHAT_ERRORS) as string[]).includes(text))
    return { message: text, kind: 'error' };
  if (
    /network ?error|terminated|failed to fetch|load failed|network connection was lost|BodyStreamBuffer|input stream|ERR_|socket|timed? ?out|504|502/i.test(
      text,
    )
  )
    return { message: CHAT_ERRORS.cut, kind: 'interrupted' };
  return { message: text.slice(0, 300) || CHAT_ERRORS.generic, kind: 'error' };
}
