/**
 * LA PUERTA DEL REGISTRO: UN CÓDIGO QUE HAY QUE SABER PARA CREAR UNA CUENTA.
 *
 * ===========================================================================
 * QUÉ ES Y QUÉ NO ES
 * ===========================================================================
 * Es una CORTINA, no una cerradura. Un código compartido lo sabe todo el que lo
 * recibió y todo el que se lo reenviaron: no autentica a nadie, no dice quién
 * entró, y el día que se filtre no hay forma de saberlo. Sirve exactamente para
 * lo que sirve —que no se registre quien pasaba por ahí mientras el producto no
 * está abierto— y para nada más. Decirlo aquí importa porque la tentación
 * siguiente es apoyar en él alguna decisión de permisos, y no aguanta ninguna.
 *
 * La cerradura de verdad sigue estando donde estaba: `ALLOWED_EMAIL_DOMAIN` para
 * una instalación de una sola empresa, y las invitaciones de `ba_invitation`,
 * que sí son nominales, caducan a las 48 horas y nombran el espacio al que
 * entras.
 *
 * ===========================================================================
 * POR QUÉ UNA COOKIE Y NO UN CAMPO DEL FORMULARIO
 * ===========================================================================
 * Porque hay dos formas de registrarse y sólo una tiene formulario. Con Google
 * el navegador se va a otro dominio y vuelve, y por el camino no sobrevive nada
 * que no esté en una cookie — así que un campo enviado a `signUp.email` dejaría
 * la puerta abierta de par en par para quien entre con Google, que es
 * precisamente el camino más cómodo para un desconocido.
 *
 * Es el mismo problema que ya resolvió `workspace-cookie.ts` («la persona lo
 * escribe una navegación antes, así que tiene que sobrevivir el viaje») y se
 * resuelve igual: `SameSite=Lax` para aguantar la vuelta desde Google, diez
 * minutos de vida, y se lee UNA vez.
 *
 * La diferencia con aquella es lo que pasa si falta o viene falseada. Un nombre
 * de espacio falseado no concede nada; un código falseado sí querría conceder
 * algo, así que la comprobación NO ocurre en el navegador: ocurre en el gancho
 * `user.create.before` de better-auth (lib/auth.ts), donde el navegador no puede
 * saltársela. Lo de aquí es sólo el transporte y el vocabulario compartido.
 *
 * Este archivo no lleva directiva y no importa nada, para que el formulario
 * (`'use client'`) y el servidor lean la misma constante en vez de dos literales
 * que se separan.
 */

export const SIGNUP_CODE_COOKIE = 'cortex_signup_code';

/** Diez minutos: el borde exterior de «me estoy registrando ahora mismo». */
export const SIGNUP_CODE_MAX_AGE_SECONDS = 600;

/** Más largo que esto no es un código, es alguien probando algo. */
export const SIGNUP_CODE_MAX_LENGTH = 200;

/**
 * La forma canónica de un código.
 *
 * Mayúsculas y sin espacios porque la gente lo recibe por WhatsApp y lo pega con
 * un espacio detrás, o lo escribe en minúscula desde el teléfono. Un código
 * correcto rechazado por un espacio invisible es una llamada a soporte que no
 * enseña nada a nadie.
 */
export function normalizeSignupCode(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/\s+/g, '').toUpperCase().slice(0, SIGNUP_CODE_MAX_LENGTH);
}

/**
 * ¿Coinciden? Comparación de tiempo constante.
 *
 * Contra un código compartido la fuga de tiempo es casi teórica —hace falta
 * medir miles de intentos sobre la red para sacar un carácter— pero «casi
 * teórica» no es una razón para escribir la comparación insegura cuando la
 * segura cuesta cuatro líneas. Lo que sí es real y sí se evita aquí es el
 * cortocircuito por longitud: `a === b` se rinde en el primer carácter distinto,
 * y este bucle recorre siempre lo mismo.
 */
export function signupCodeMatches(given: string | null | undefined, expected: string): boolean {
  const a = normalizeSignupCode(given);
  const b = normalizeSignupCode(expected);
  if (b.length === 0) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  }
  return diff === 0;
}

/** Lo que se le dice a quien no lo trae. Sin pistas sobre el código. */
export const SIGNUP_CODE_ERROR =
  'Cortex está en acceso por invitación. Necesitas un código para crear la cuenta — pídeselo a quien te habló del producto.';
