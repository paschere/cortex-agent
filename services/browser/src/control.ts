import type { Target } from './types';

/**
 * Quién tiene el volante de una sesión, escrito como máquina de estados pura.
 *
 * ===========================================================================
 * POR QUÉ EXISTE UN "VOLANTE"
 * ===========================================================================
 * Hasta ahora la pregunta no se planteaba: una pestaña la conducía o bien un
 * replay sin nadie mirando, o bien una persona resolviendo un captcha en una
 * pestaña que el bot ya había soltado. La navegación libre cambia eso: el bot
 * y una persona pueden querer la MISMA pestaña en el MISMO minuto — el bot
 * porque está a mitad de un formulario, la persona porque el bot le pidió
 * ayuda con un paso que no puede hacer solo.
 *
 * Dos manos en un volante es la forma clásica de llenar "AlicAlice" en un
 * campo de nombre. Así que el volante es exclusivo y el cambio de manos es
 * explícito:
 *
 *   bot conduce  ──requestHelp()──▶  bot conduce, con la mano levantada
 *   (cualquiera) ──take()────────▶  humano conduce; TODO acto del bot es 409
 *   humano       ──release()─────▶  bot conduce otra vez
 *
 * La regla dura, tomada con nombre y apellido de lo que aprendimos leyendo
 * OpenBot: mientras el humano conduce, los actos del bot se RECHAZAN, no se
 * encolan. Un click encolado aterriza en una página que ya no es la que el
 * modelo estaba mirando, y "se ejecutó tarde" es indistinguible de "se
 * ejecutó mal" para quien revisa la auditoría después.
 *
 * ===========================================================================
 * EL SECRETO ES UN ESTADO, NO UNA ACCIÓN
 * ===========================================================================
 * `secretWanted` guarda QUÉ campo espera un valor y CÓMO se llama para una
 * persona («Contraseña del portal»). El valor no pasa por aquí jamás: viaja
 * del teclado de la persona a `supplySecret`, que lo escribe en la página y
 * lo suelta. Esta máquina solo sabe que se pidió y que se cumplió.
 *
 * ===========================================================================
 * POR QUÉ NO IMPORTA PLAYWRIGHT
 * ===========================================================================
 * A propósito. Todo lo de este archivo se puede ejercitar en un test sin
 * navegador, y la parte del navegador (resolver el campo, escribir el valor)
 * vive en browser.ts donde ya viven sus hermanos. La frontera es la misma que
 * snapshot.ts guarda con locators.ts.
 */

export interface HelpRequest {
  /** En palabras del bot, para que la tarjeta del chat lo diga tal cual. */
  reason: string;
  requestedAt: number;
}

export interface SecretRequest {
  /** Cómo se le nombra el campo a la persona. Nunca el valor. */
  label: string;
  /** Los localizadores del campo, elegidos del snapshot por el bot. */
  target: Target;
  requestedAt: number;
}

export interface ControlState {
  driver: 'bot' | 'human';
  /** La mano levantada. Presente hasta que alguien toma o suelta el volante. */
  help: HelpRequest | null;
  /** Un campo esperando que una persona lo llene. */
  secret: SecretRequest | null;
  /** Cuándo cambió de manos por última vez, para que la UI diga hace cuánto. */
  changedAt: number;
}

export function createControl(now: number = Date.now()): ControlState {
  return { driver: 'bot', help: null, secret: null, changedAt: now };
}

export function requestHelp(state: ControlState, reason: string, now = Date.now()): ControlState {
  // Pedir ayuda dos veces no apila dos manos: la última razón gana, porque es
  // la que describe la página como está ahora.
  return { ...state, help: { reason: reason.slice(0, 300), requestedAt: now } };
}

export function takeControl(state: ControlState, now = Date.now()): ControlState {
  // Tomar el volante responde la petición de ayuda si la había, y también es
  // válido sin petición: una persona que ve al bot equivocarse no tiene que
  // esperar a que el bot se dé cuenta.
  return { ...state, driver: 'human', help: null, changedAt: now };
}

export function releaseControl(state: ControlState, now = Date.now()): ControlState {
  return { ...state, driver: 'bot', changedAt: now };
}

export function wantSecret(
  state: ControlState,
  label: string,
  target: Target,
  now = Date.now(),
): ControlState {
  return { ...state, secret: { label: label.slice(0, 120), target, requestedAt: now } };
}

export function secretSettled(state: ControlState): ControlState {
  return { ...state, secret: null };
}

/** El bot solo actúa con el volante en la mano. */
export function botMayAct(state: ControlState): boolean {
  return state.driver === 'bot';
}

/**
 * El humano solo conduce cuando lo tomó. Un socket abierto no es permiso: la
 * comprobación se hace por gesto, no por conexión, así que soltar el volante
 * corta la conducción aunque la pantalla siga abierta.
 */
export function humanMayDrive(state: ControlState): boolean {
  return state.driver === 'human';
}

export class HumanHasControl extends Error {
  constructor() {
    super('a person is driving this tab right now');
    this.name = 'HumanHasControl';
  }
}

export class BotHasControl extends Error {
  constructor() {
    super('the bot is driving; take control first');
    this.name = 'BotHasControl';
  }
}
