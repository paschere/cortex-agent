/**
 * A DÓNDE VUELVE UNA CONEXIÓN, Y QUÉ ARRANCA AL VOLVER.
 *
 * El recorrido de los primeros 15 minutos deja una cookie sin secreto
 * (`cx_connect_from=onboarding`) antes de mandar a la persona a Google o a
 * Intuit. Los retornos de OAuth la leen: si está, vuelven al recorrido y no a
 * /integrations. Todo lo demás de este archivo es puro para poder probarlo.
 */

export const CONNECT_FROM_COOKIE = 'cx_connect_from';
export const ONBOARDING_FROM = 'onboarding';

export function cameFromOnboarding(cookieValue: string | null | undefined): boolean {
  return cookieValue === ONBOARDING_FROM;
}

export type ConnectProvider = 'google' | 'quickbooks' | 'siigo' | 'alegra' | 'microsoft';

/** Ruta (relativa) a la que vuelve una conexión lograda. */
export function connectedPath(provider: ConnectProvider, fromOnboarding: boolean): string {
  if (fromOnboarding) return `/onboarding?paso=fuentes&connected=${provider}`;
  if (provider === 'quickbooks') return `/integrations?connected=${provider}#programas-contables`;
  return `/integrations?connected=${provider}`;
}

/** Ruta (relativa) a la que vuelve una conexión que falló. */
export function failedPath(
  provider: ConnectProvider,
  code: string,
  fromOnboarding: boolean,
): string {
  if (fromOnboarding) return `/onboarding?paso=fuentes&error=${code}`;
  if (provider === 'quickbooks') return `/integrations?error=${code}#programas-contables`;
  return `/integrations?error=${code}`;
}

export interface GmailStateLite {
  paused: boolean;
  backfillDoneAt: string | null;
}

export interface KickoffJob {
  name: string;
  data: Record<string, unknown>;
}

/**
 * Qué se encola al terminar de conectar Google.
 *
 * Conectar Google NO es consentir a leer el correo ni todo el Drive: eso lo
 * pide el recorrido con su propio interruptor (buzón) y su selector
 * (carpetas). Lo único que arranca solo es retomar una carga de correo que la
 * persona YA había encendido (reconexión tras perder el permiso): sigue activa,
 * sin terminar y no pausada.
 */
export function googleKickoffJobs(input: {
  userId: string;
  organizationId: string;
  gmail: GmailStateLite | null;
}): KickoffJob[] {
  const { gmail } = input;
  if (!gmail || gmail.paused || gmail.backfillDoneAt) return [];
  return [
    {
      name: 'gmail/backfill.user',
      data: { userId: input.userId, organizationId: input.organizationId },
    },
  ];
}
