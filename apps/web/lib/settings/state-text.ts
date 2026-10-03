/**
 * EL DATO CORTO DE CADA AJUSTE, EN PALABRAS.
 *
 * «Google conectado», «7 módulos prendidos», «Plan Equipo · prueba: 9 días».
 * Puro: la página lee los números y esto los vuelve una frase con su tono, así
 * la redacción se prueba sin base de datos.
 */

export type SettingsTone = 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';

export interface SettingsState {
  text: string;
  tone: SettingsTone;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function profileState(name: string | null, roleLabel: string): SettingsState {
  return { text: name?.trim() ? `${name.trim()} · ${roleLabel}` : roleLabel, tone: 'neutral' };
}

export function notificationsState(p: {
  digestEnabled: boolean;
  digestTime: string;
  mailAlertsEnabled: boolean;
}): SettingsState {
  const parts: string[] = [];
  parts.push(p.digestEnabled ? `Resumen a las ${p.digestTime}` : 'Resumen apagado');
  if (p.mailAlertsEnabled) parts.push('avisos del correo prendidos');
  return {
    text: parts.join(' · '),
    tone: p.digestEnabled || p.mailAlertsEnabled ? 'emerald' : 'neutral',
  };
}

export function memoryState(active: number, pending: number): SettingsState {
  if (pending > 0) {
    return { text: `${pending} por revisar`, tone: 'amber' };
  }
  return active === 0
    ? { text: 'Todavía nada', tone: 'neutral' }
    : { text: plural(active, 'recuerdo', 'recuerdos'), tone: 'primary' };
}

export function mailState(
  googleConnected: boolean,
  mailbox: { paused: boolean; lastError: string | null } | null,
): SettingsState {
  if (!googleConnected) return { text: 'Google sin conectar', tone: 'neutral' };
  if (!mailbox) return { text: 'Google conectado · sin aprender', tone: 'primary' };
  if (mailbox.lastError) return { text: 'Aprendizaje con un error', tone: 'rose' };
  if (mailbox.paused) return { text: 'Aprendizaje en pausa', tone: 'amber' };
  return { text: 'Google conectado · aprendiendo', tone: 'emerald' };
}

export function modulesState(on: number): SettingsState {
  return { text: plural(on, 'módulo prendido', 'módulos prendidos'), tone: 'primary' };
}

export function peopleState(n: number): SettingsState {
  return { text: plural(n, 'persona', 'personas'), tone: 'neutral' };
}

export function mandatesState(active: number): SettingsState {
  return active === 0
    ? { text: 'Ninguno activo: Cortex pregunta siempre', tone: 'neutral' }
    : { text: plural(active, 'permiso activo', 'permisos activos'), tone: 'primary' };
}

export function connectionsState(n: number): SettingsState {
  return n === 0
    ? { text: 'Nada conectado todavía', tone: 'amber' }
    : { text: plural(n, 'conexión activa', 'conexiones activas'), tone: 'emerald' };
}

export function tokensState(active: number): SettingsState {
  return active === 0
    ? { text: 'Sin llaves', tone: 'neutral' }
    : { text: plural(active, 'llave activa', 'llaves activas'), tone: 'primary' };
}

export function autopilotState(enabled: boolean, runHour: number): SettingsState {
  return enabled
    ? { text: `Prendido · ${String(runHour).padStart(2, '0')}:00`, tone: 'emerald' }
    : { text: 'Apagado', tone: 'neutral' };
}

const BILLING_LABEL: Record<string, { text: (days: number | null) => string; tone: SettingsTone }> =
  {
    trialing: {
      text: (d) => (d === null ? 'prueba' : `prueba: ${d === 1 ? '1 día' : `${d} días`}`),
      tone: 'primary',
    },
    active: { text: () => 'al día', tone: 'emerald' },
    past_due: { text: () => 'pago pendiente', tone: 'amber' },
    grace: { text: () => 'solo lectura', tone: 'rose' },
    canceled: { text: () => 'cancelado', tone: 'amber' },
    legacy: { text: () => 'acordado contigo', tone: 'neutral' },
  };

export function planState(
  planName: string,
  billing: { status: string; daysLeft: number | null } | null,
): SettingsState {
  if (!billing) return { text: `Plan ${planName}`, tone: 'neutral' };
  const label = BILLING_LABEL[billing.status];
  if (!label) return { text: `Plan ${planName}`, tone: 'neutral' };
  const tone: SettingsTone =
    billing.status === 'trialing' && billing.daysLeft !== null && billing.daysLeft <= 3
      ? 'amber'
      : label.tone;
  return { text: `Plan ${planName} · ${label.text(billing.daysLeft)}`, tone };
}

export function versionState(sha: string | null): SettingsState {
  return sha
    ? { text: `Versión ${sha.slice(0, 7)}`, tone: 'neutral' }
    : { text: 'Versión de desarrollo', tone: 'neutral' };
}
