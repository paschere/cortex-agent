/**
 * SOPORTE, COMO DATO: estados, validación del formulario, el contexto que la
 * app adjunta sola y el correo que le llega a soporte.
 *
 * Puro y sin `server-only`: lo usan el formulario (cliente), las acciones del
 * servidor y las pruebas. Nada de aquí toca la base ni `@cortex/agent-tools`.
 */

export const SUPPORT_STATUSES = [
  'abierto',
  'en_curso',
  'esperando_cliente',
  'resuelto',
  'cerrado',
] as const;

export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const SUPPORT_STATUS_LABEL: Record<SupportStatus, string> = {
  abierto: 'Recibido',
  en_curso: 'Lo estamos revisando',
  esperando_cliente: 'Esperando tu respuesta',
  resuelto: 'Resuelto',
  cerrado: 'Cerrado',
};

export const SUPPORT_STATUS_TONE: Record<SupportStatus, 'primary' | 'amber' | 'emerald' | 'muted'> =
  {
    abierto: 'primary',
    en_curso: 'amber',
    esperando_cliente: 'amber',
    resuelto: 'emerald',
    cerrado: 'muted',
  };

export function isSupportStatus(value: unknown): value is SupportStatus {
  return typeof value === 'string' && (SUPPORT_STATUSES as readonly string[]).includes(value);
}

/** `SUPPORT_OPERATORS`: correos separados por comas que operan la bandeja de soporte. */
export function operatorEmails(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes('@')),
  );
}

/** `SUPPORT_CHANNEL=email|off`. Sin valor: `email` (el canal existe por defecto). */
export type SupportChannel = 'email' | 'off';

export function supportChannel(value: string | undefined): SupportChannel {
  return value?.trim().toLowerCase() === 'off' ? 'off' : 'email';
}

export const SCREENSHOT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

export const SUBJECT_MIN = 3;
export const SUBJECT_MAX = 160;
export const MESSAGE_MIN = 10;
export const MESSAGE_MAX = 8000;

export interface SupportDraft {
  subject: string;
  message: string;
}

/** El primer problema del formulario, en palabras, o `null` si está bien. */
export function draftProblem(draft: SupportDraft): string | null {
  const subject = draft.subject.trim();
  const message = draft.message.trim();
  if (subject.length < SUBJECT_MIN) return 'Ponle un asunto corto: de qué se trata.';
  if (subject.length > SUBJECT_MAX) return `El asunto va hasta ${SUBJECT_MAX} caracteres.`;
  if (message.length < MESSAGE_MIN) return 'Cuéntanos un poco más qué pasó.';
  if (message.length > MESSAGE_MAX) return `El mensaje va hasta ${MESSAGE_MAX} caracteres.`;
  return null;
}

export function screenshotProblem(file: { size: number; type: string } | null): string | null {
  if (!file || file.size === 0) return null;
  if (!(SCREENSHOT_TYPES as readonly string[]).includes(file.type)) {
    return 'El pantallazo debe ser PNG, JPG o WebP.';
  }
  if (file.size > SCREENSHOT_MAX_BYTES) return 'El pantallazo pesa más de 5 MB.';
  return null;
}

/** Lo que la app adjunta sola. Todo opcional: se manda lo que haya. */
export interface SupportContext {
  route?: string;
  userAgent?: string;
  viewport?: string;
  language?: string;
  timezone?: string;
  recentErrors?: string[];
}

const clip = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

/**
 * El contexto que mandó el navegador, recortado y sin nada que no sea texto.
 * Es entrada de usuario: se guarda como dato, nunca decide nada.
 */
export function sanitizeContext(raw: unknown): SupportContext {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const route = clip(r.route, 300);
  const errors = Array.isArray(r.recentErrors)
    ? r.recentErrors
        .map((e) => clip(e, 300))
        .filter((e): e is string => Boolean(e))
        .slice(-5)
    : [];
  return {
    ...(route?.startsWith('/') ? { route } : {}),
    ...(clip(r.userAgent, 500) ? { userAgent: clip(r.userAgent, 500) } : {}),
    ...(clip(r.viewport, 40) ? { viewport: clip(r.viewport, 40) } : {}),
    ...(clip(r.language, 20) ? { language: clip(r.language, 20) } : {}),
    ...(clip(r.timezone, 60) ? { timezone: clip(r.timezone, 60) } : {}),
    ...(errors.length > 0 ? { recentErrors: errors } : {}),
  };
}

/** «Chrome 129 en macOS»: el navegador en palabras, para la lista de soporte. */
export function browserLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  if (!ua) return 'Navegador desconocido';
  const browser = /Edg\/(\d+)/.exec(ua)
    ? `Edge ${/Edg\/(\d+)/.exec(ua)?.[1]}`
    : /Chrome\/(\d+)/.exec(ua)
      ? `Chrome ${/Chrome\/(\d+)/.exec(ua)?.[1]}`
      : /Firefox\/(\d+)/.exec(ua)
        ? `Firefox ${/Firefox\/(\d+)/.exec(ua)?.[1]}`
        : /Version\/(\d+).*Safari/.exec(ua)
          ? `Safari ${/Version\/(\d+)/.exec(ua)?.[1]}`
          : 'Otro navegador';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} en ${os}` : browser;
}

export interface SupportEmailInput {
  number: number;
  subject: string;
  message: string;
  organizationName: string;
  organizationId: string;
  fromEmail: string;
  fromName: string | null;
  context: SupportContext;
  hasScreenshot: boolean;
  /** Dirección absoluta de la bandeja de operación, si se conoce. */
  inboxUrl?: string;
}

/** El correo que le llega a SUPPORT_EMAIL. Texto llano: se lee en cualquier cliente. */
export function supportEmail(input: SupportEmailInput): { subject: string; text: string } {
  const who = input.fromName ? `${input.fromName} <${input.fromEmail}>` : input.fromEmail;
  const lines = [
    `Caso #${input.number} — ${input.subject}`,
    '',
    `De: ${who}`,
    `Empresa: ${input.organizationName} (${input.organizationId})`,
    `Pantalla: ${input.context.route ?? 'sin dato'}`,
    `Navegador: ${browserLabel(input.context.userAgent)}`,
    ...(input.context.viewport ? [`Pantalla del equipo: ${input.context.viewport}`] : []),
    ...(input.hasScreenshot ? ['Adjuntó un pantallazo (verlo en la bandeja de soporte).'] : []),
    '',
    input.message.trim(),
    ...(input.context.recentErrors?.length
      ? ['', 'Errores recientes del navegador:', ...input.context.recentErrors.map((e) => `- ${e}`)]
      : []),
    ...(input.inboxUrl ? ['', `Bandeja de soporte: ${input.inboxUrl}`] : []),
  ];
  return {
    subject: `[Soporte Cortex #${input.number}] ${input.subject.trim()}`,
    text: lines.join('\n'),
  };
}
