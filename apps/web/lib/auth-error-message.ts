/**
 * LO QUE VE QUIEN NO PUDO ENTRAR, EN ESPAÑOL.
 *
 * Las pantallas de acceso pintaban `error.message` tal cual llega de
 * better-auth, que habla inglés («User already exists», «Invalid email or
 * password»). Para un dueño de empresa que se está registrando, un error en
 * inglés en la primera pantalla es una puerta cerrada sin cartel.
 *
 * Se traduce por `code` (estable entre versiones) y, si no hay código, por el
 * texto. Lo que no se reconoce cae en el mensaje de respaldo de cada pantalla,
 * que ya está escrito en español — nunca en el texto crudo en inglés. Un mensaje
 * que ya viene en español (los de nuestros propios ganchos, como el del código
 * de invitación) se respeta tal cual.
 */

const BY_CODE: Record<string, string> = {
  USER_ALREADY_EXISTS: 'Ya hay una cuenta con ese correo. Inicia sesión o recupera la contraseña.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    'Ya hay una cuenta con ese correo. Inicia sesión o recupera la contraseña.',
  INVALID_EMAIL_OR_PASSWORD:
    'El correo o la contraseña no coinciden. Revísalos e inténtalo otra vez.',
  INVALID_PASSWORD: 'La contraseña no es correcta.',
  INVALID_EMAIL: 'Ese correo no parece válido. Revísalo.',
  PASSWORD_TOO_SHORT: 'La contraseña es muy corta: usa al menos 10 caracteres.',
  PASSWORD_TOO_LONG: 'La contraseña es demasiado larga.',
  EMAIL_NOT_VERIFIED: 'Primero confirma tu correo: abre el enlace que te enviamos.',
  USER_NOT_FOUND: 'No encontramos una cuenta con ese correo.',
  INVALID_TOKEN: 'El enlace ya no sirve o expiró. Pide uno nuevo.',
  TOKEN_EXPIRED: 'El enlace expiró. Pide uno nuevo.',
  INVALID_TWO_FACTOR_CODE: 'El código no es correcto. Revisa la app de autenticación.',
  INVALID_CODE: 'El código no es correcto. Inténtalo otra vez.',
  OTP_EXPIRED: 'El código expiró. Pide uno nuevo.',
  TOO_MANY_ATTEMPTS: 'Demasiados intentos. Espera unos minutos y vuelve a probar.',
  TOO_MANY_REQUESTS: 'Demasiados intentos. Espera unos minutos y vuelve a probar.',
  FAILED_TO_CREATE_USER: 'No se pudo crear la cuenta. Inténtalo de nuevo en un momento.',
};

const BY_TEXT: Array<[RegExp, string]> = [
  [/already exists/i, BY_CODE.USER_ALREADY_EXISTS as string],
  [/invalid email or password/i, BY_CODE.INVALID_EMAIL_OR_PASSWORD as string],
  [/password.*(short|at least)/i, BY_CODE.PASSWORD_TOO_SHORT as string],
  [/invalid email/i, BY_CODE.INVALID_EMAIL as string],
  [/not verified/i, BY_CODE.EMAIL_NOT_VERIFIED as string],
  [/(invalid|expired) token|token (is )?(invalid|expired)/i, BY_CODE.INVALID_TOKEN as string],
  [/too many/i, BY_CODE.TOO_MANY_REQUESTS as string],
  [/failed to fetch|network/i, 'No hay conexión. Revisa tu internet e inténtalo otra vez.'],
];

/** Señales baratas de que un texto ya está en español y se puede mostrar tal cual. */
const SPANISH = /[áéíóúñ¿¡]|\b(el|la|los|las|de|que|tu|una?|para|con|cuenta|correo)\b/i;

export function authErrorMessage(
  error: { code?: string | null; message?: string | null } | unknown,
  fallback: string,
): string {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code.toUpperCase() : '';
  if (code && BY_CODE[code]) return BY_CODE[code] as string;
  const message = typeof e.message === 'string' ? e.message.trim() : '';
  if (!message) return fallback;
  for (const [re, text] of BY_TEXT) if (re.test(message)) return text;
  return SPANISH.test(message) ? message : fallback;
}
