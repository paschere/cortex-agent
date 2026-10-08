/**
 * UN TURNO QUE TERMINA EN UNA PROMESA NO HA TERMINADO.
 *
 * Visto en producción: «Las tres tablas ya están confirmadas… Ahora diseño la
 * app completa.», una llamada a `trackers.list` y FIN del turno (finishReason
 * `stop`) sin llamar `apps.design`. La persona escribía «créala» y volvía a
 * pasar. El modelo anuncia la acción y da el turno por cerrado.
 *
 * Dos defensas: la regla en el system prompt (lib/system-prompt.ts, «si dices
 * que vas a hacer algo, hazlo en este mismo turno») y, si aun así el último
 * paso es texto que promete una acción, UNA continuación automática con un
 * empujón explícito — sólo si queda tiempo y pasos. Nunca dos: si tampoco lo
 * hace, la persona ve el anuncio y decide.
 */

/** Cuántos pasos de modelo puede dar un turno: proporcional a su presupuesto. */
export function maxStepsFor(limitMs: number): number {
  return Math.min(30, Math.max(12, Math.round(limitMs / 30_000)));
}

/** Frases que ceden la decisión a la persona: ahí terminar SÍ es correcto. */
const ASKS_PERSON =
  /[¿?]|si quieres|si te parece|si prefieres|si me confirmas|cuando me confirmes|cuando confirmes|me confirmas|confírma|apruébal|apruebas|avísame|dime si|quieres que/i;

/**
 * Anuncios de una acción inmediata, en primera persona: «ahora diseño…», «a
 * continuación te la creo…», «voy a…», «procedo a…». Con `\p{L}` y sin `\b`
 * porque `\b` no reconoce la ñ ni las tildes («diseño» no tendría frontera).
 */
const NOT_A_VERB = new Set([
  'todo',
  'esto',
  'eso',
  'ello',
  'como',
  'cuando',
  'nuestro',
  'vuestro',
  'solo',
  'sólo',
  'tengo',
  'puedo',
  'necesito',
  'quedo',
  'listo',
  'mismo',
  'nuevo',
  'claro',
  'correcto',
]);
const LEAD =
  /(?:^|[^\p{L}])(?:ahora|a continuaci[oó]n|enseguida|en seguida|de una vez|acto seguido|ya mismo)\s*,?\s+((?:(?:mismo|sí|ya|me|te|le|lo|la|les|los|las|se)\s+){0,2})(\p{L}+)(?=[^\p{L}]|$)/iu;
const PHRASE =
  /(?:^|[^\p{L}])(?:voy a|vamos a|procedo a|paso a|me pongo a|empiezo a|comienzo a|d[ée]jame|dame un momento)(?=[^\p{L}]|$)/iu;

function announces(sentence: string): boolean {
  if (PHRASE.test(sentence)) return true;
  const m = LEAD.exec(sentence);
  if (!m) return false;
  const verb = (m[2] ?? '').toLowerCase();
  return /[oé]$/u.test(verb) && !NOT_A_VERB.has(verb);
}

/** La última oración con contenido del texto. */
function lastSentence(text: string): string {
  const trimmed = text.trim().replace(/[\s:…]+$/u, '');
  const parts = trimmed.split(/(?<=[.!?\n])\s+/u).filter((s) => s.trim().length > 0);
  return (parts[parts.length - 1] ?? '').trim();
}

/**
 * ¿El texto con el que el modelo cerró el turno promete una acción que no hizo?
 * Mira sólo el final (la última oración o lo que va tras los dos puntos): un
 * «voy a» a mitad de una explicación no cuenta.
 */
export function promisesAction(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const tail = t.endsWith(':') ? t.slice(-200) : lastSentence(t);
  if (!tail || ASKS_PERSON.test(tail)) return false;
  return announces(tail);
}

export type ContinuationKind = 'promise' | 'steps';

/** Decide si el turno merece UNA continuación automática. */
export function shouldContinue(input: {
  lastStepText: string;
  lastStepHadTools: boolean;
  finishReason: string | undefined;
  stepsUsed: number;
  maxSteps: number;
  pastSoft: boolean;
  alreadyContinued: boolean;
}): ContinuationKind | null {
  if (input.alreadyContinued || input.pastSoft) return null;
  // Se agotaron los pasos con herramientas pendientes de comentar: la persona
  // se quedaría sin respuesta escrita.
  if (input.stepsUsed >= input.maxSteps && input.lastStepHadTools) return 'steps';
  if (input.finishReason !== 'stop' || input.lastStepHadTools) return null;
  return promisesAction(input.lastStepText) ? 'promise' : null;
}

/** El empujón: un mensaje de la persona generado por Cortex, dicho como tal. */
export function continuationNudge(kind: ContinuationKind, announced: string): string {
  if (kind === 'steps') {
    return (
      '[Mensaje automático de Cortex] Se acabaron los pasos de este turno. ' +
      'Cierra ahora con un resumen breve de lo que hiciste y lo que falta, y pide a la persona ' +
      'que escriba «sigue» si falta algo. No llames más herramientas.'
    );
  }
  return (
    '[Mensaje automático de Cortex] Terminaste diciendo ' +
    `«${announced.trim().slice(-200)}» pero no lo hiciste. Hazlo ahora, en este turno, con las ` +
    'herramientas que tienes (o con use_tool si la que necesitas no está), sin volver a anunciarlo. ' +
    'Si de verdad te falta un dato de la persona, pregúntaselo en una frase.'
  );
}
