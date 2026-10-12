import type { StatusTone } from '@/lib/status-chip';

/**
 * EL RIESGO DE UNA ACCIÓN, DICHO EN UNA PALABRA.
 *
 * Una función pura sobre el nombre de la herramienta: no consulta nada y no
 * decide nada, sólo rotula lo que una tarjeta de aprobación ya iba a mostrar.
 * «Alto» es lo que sale de la empresa o mueve plata y no se recoge (enviar,
 * pagar, borrar, presentar ante la DIAN); «medio» es escribir en el sistema
 * (crear, actualizar, programar); lo demás es «bajo».
 */
export type RiskLevel = 'alto' | 'medio' | 'bajo';

export interface Risk {
  level: RiskLevel;
  label: string;
  tone: StatusTone;
}

const HIGH =
  /(^|[._])(send|pay|transfer|delete|remove|destroy|void|cancel|file|submit|publish|approve|disburse|payroll|refund|wire|charge|email|whatsapp|sms|message|reply|forward|invite)([._]|$)|payment|payroll|nomina|dian|exogena|transfer/i;
const MEDIUM =
  /(^|[._])(create|update|upsert|set|write|add|insert|edit|schedule|log|register|record|save|archive|import|sync|mark|assign|connect)([._]|$)/i;

const RISKS: Record<RiskLevel, Risk> = {
  alto: { level: 'alto', label: 'Riesgo alto', tone: 'rose' },
  medio: { level: 'medio', label: 'Riesgo medio', tone: 'amber' },
  bajo: { level: 'bajo', label: 'Riesgo bajo', tone: 'neutral' },
};

export function riskOfTool(toolId: string | null | undefined): Risk {
  const id = toolId ?? '';
  if (HIGH.test(id)) return RISKS.alto;
  if (MEDIUM.test(id)) return RISKS.medio;
  return RISKS.bajo;
}

/** Para una cosa del piloto, que no trae herramienta sino un área y a veces plata. */
export function riskOfPilotItem(input: {
  area?: string | null;
  hasAmount?: boolean;
  hasPreview?: boolean;
}): Risk {
  if (input.hasPreview || input.hasAmount) return RISKS.alto;
  if (input.area && /pay|money|plata|tax|impuesto|cobro|pago/i.test(input.area)) return RISKS.alto;
  return RISKS.medio;
}

/** «espera hace 2 días» / «espera desde hoy». */
export function waitingAge(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const minutes = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  if (minutes < 60)
    return minutes < 2 ? 'espera desde hace un momento' : `espera hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `espera hace ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  const days = Math.floor(hours / 24);
  return `espera hace ${days} ${days === 1 ? 'día' : 'días'}`;
}

/** Edad en días enteros, para ordenar y para el KPI. */
export function ageDays(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}
