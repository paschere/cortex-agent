/**
 * LOS INTERRUPTORES DEL REGISTRO Y DEL COBRO.
 *
 * Todo es variable de entorno y todo arranca APAGADO: sin tocar nada, Cortex se
 * comporta exactamente como antes de la 0187 (registro por invitación con
 * `SIGNUP_INVITE_CODE`, sin pruebas, sin pasarela). El dueño enciende cada cosa
 * cuando decide.
 *
 *   SIGNUP_MODE   'invite'  (por defecto) igual que hoy: código compartido
 *                           `SIGNUP_INVITE_CODE` si está puesto, invitaciones de
 *                           better-auth siempre.
 *                 'request' la página pública pide acceso (/acceso), operaciones
 *                           aprueba en /overview/access y sale por correo un
 *                           código personal de un solo uso. El código compartido
 *                           sigue sirviendo si está puesto.
 *                 'open'    cualquiera se registra y su empresa empieza una
 *                           prueba de TRIAL_DAYS días sobre el plan elegido.
 *   TRIAL_DAYS    días de prueba en 'open' (por defecto 14, entre 1 y 90).
 *   TRIAL_PLAN    plan de la prueba si la persona no eligió (por defecto 'team').
 *
 * Archivo sin directiva y sin imports de servidor: lo leen el formulario (vía
 * props desde su página de servidor), la landing y las pruebas. Cada función
 * recibe el entorno como argumento para poder probarla sin tocar process.env.
 */

export const SIGNUP_MODES = ['invite', 'request', 'open'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

type Env = Record<string, string | undefined>;

/** Lo que no se reconoce cae en 'invite': un error de tipeo nunca abre la puerta. */
export function signupMode(env: Env = process.env): SignupMode {
  const raw = (env.SIGNUP_MODE ?? '').trim().toLowerCase();
  return (SIGNUP_MODES as readonly string[]).includes(raw) ? (raw as SignupMode) : 'invite';
}

export const TRIAL_DAYS_DEFAULT = 14;

export function trialDays(env: Env = process.env): number {
  const n = Number.parseInt((env.TRIAL_DAYS ?? '').trim(), 10);
  if (!Number.isFinite(n)) return TRIAL_DAYS_DEFAULT;
  return Math.min(90, Math.max(1, n));
}

/**
 * Los planes que se pueden probar solos. Gratis no tiene prueba (ya es gratis),
 * Enterprise y Gerente se acuerdan en una conversación.
 */
export const TRIAL_PLAN_CODES = ['team', 'business'] as const;
export type TrialPlanCode = (typeof TRIAL_PLAN_CODES)[number];

export const TRIAL_PLAN_LABEL: Record<TrialPlanCode, string> = {
  team: 'Equipo',
  business: 'Empresa',
};

export function isTrialPlanCode(value: string | null | undefined): value is TrialPlanCode {
  return (TRIAL_PLAN_CODES as readonly string[]).includes((value ?? '').trim());
}

/** El plan de la prueba: el elegido si es válido, si no TRIAL_PLAN, si no Equipo. */
export function trialPlanCode(
  requested: string | null | undefined,
  env: Env = process.env,
): TrialPlanCode {
  if (isTrialPlanCode(requested)) return requested.trim() as TrialPlanCode;
  const configured = (env.TRIAL_PLAN ?? '').trim();
  return isTrialPlanCode(configured) ? configured : 'team';
}

/** La cookie que lleva el plan elegido hasta la petición que crea la empresa. */
export const SIGNUP_PLAN_COOKIE = 'cortex_signup_plan';

/** A dónde va el formulario público de «Pide tu acceso». */
export const ACCESS_REQUEST_PATH = '/acceso';

export interface LandingCta {
  label: 'Crear mi espacio' | 'Pide tu acceso';
  href: string;
  /** La línea chica debajo del botón. */
  note: string;
  /** Enlace secundario de la nota, si lo hay. */
  noteLink: { label: string; href: string } | null;
  /** El botón de las tarjetas de planes. */
  planCta: { label: string; href: string };
}

/**
 * El botón principal de la landing según el modo.
 *
 * `externalAccessHref` es el `ACCESS_REQUEST_HREF` que ya existía (un mailto o
 * un WhatsApp): en modo 'invite' se sigue respetando para no cambiar nada a
 * quien lo tenga puesto.
 */
export function landingCta(
  mode: SignupMode,
  externalAccessHref: string | null,
  days: number = TRIAL_DAYS_DEFAULT,
): LandingCta {
  if (mode === 'open') {
    return {
      label: 'Crear mi espacio',
      href: '/signup',
      note: `Prueba gratis ${days} días. Sin tarjeta.`,
      noteLink: null,
      planCta: { label: `Probar ${days} días`, href: '/signup' },
    };
  }
  if (mode === 'request') {
    return {
      label: 'Pide tu acceso',
      href: ACCESS_REQUEST_PATH,
      note: '¿Ya tienes tu código de invitación?',
      noteLink: { label: 'Crea tu espacio', href: '/signup' },
      planCta: { label: 'Pide tu acceso', href: ACCESS_REQUEST_PATH },
    };
  }
  if (externalAccessHref) {
    return {
      label: 'Pide tu acceso',
      href: externalAccessHref,
      note: '¿Ya tienes tu código de invitación?',
      noteLink: { label: 'Crea tu espacio', href: '/signup' },
      planCta: { label: 'Crear mi espacio', href: '/signup' },
    };
  }
  return {
    label: 'Crear mi espacio',
    href: '/signup',
    note: 'Acceso por invitación: necesitas tu código. Sin tarjeta.',
    noteLink: null,
    planCta: { label: 'Crear mi espacio', href: '/signup' },
  };
}

/** ¿Este modo exige un código para registrarse? */
export function signupNeedsCode(mode: SignupMode, sharedCodeConfigured: boolean): boolean {
  if (mode === 'open') return false;
  if (mode === 'request') return true;
  return sharedCodeConfigured;
}
