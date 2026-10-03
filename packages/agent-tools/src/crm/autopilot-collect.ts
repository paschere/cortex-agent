import type { PlanItem } from '../autopilot/types';
import { RISK_LABEL, type RiskLevel, formatAmount } from './shape';

/**
 * EL PILOTO MIRA EL EMBUDO (migración 0193) — la parte pura.
 *
 *   negocios quietos   UNA pregunta por negocio (los de más plata primero, a lo
 *                      sumo cinco): «dejarle a su responsable la tarea de
 *                      seguimiento para hoy». Aprobarla crea la tarea con
 *                      crm.log_activity; no le escribe a nadie de afuera.
 *                      Pide decisión porque no es una herramienta rutinaria.
 *   clientes en riesgo SÓLO SE CUENTA, y sólo lo NUEVO: un cliente que subió de
 *                      nivel desde la última vez que se dijo (crm_client_risk.
 *                      told_level). Mañana no se repite.
 *
 * La lectura (y la marca de «ya se contó») está en ./autopilot.ts.
 */

export interface SnapshotStaleDeal {
  id: string;
  title: string;
  clientName: string;
  ownerName: string | null;
  value: number;
  currency: string;
  quietDays: number;
  why: string;
  suggestion: string;
}

export interface SnapshotAtRisk {
  clientId: string;
  clientName: string;
  level: RiskLevel;
  score: number;
  evidence: string[];
  action: string | null;
  ownerName: string | null;
  revenue12m: number;
}

export interface SnapshotCrm {
  stale: SnapshotStaleDeal[];
  newlyAtRisk: SnapshotAtRisk[];
}

export const MAX_STALE_ASKS = 5;
export const MAX_RISK_TELLS = 5;

export function collectNegociosQuietos(s: SnapshotCrm | undefined, today: string): PlanItem[] {
  if (!s) return [];
  return s.stale.slice(0, MAX_STALE_ASKS).map((d) => ({
    area: 'gerencia',
    title: `Seguimiento a «${d.title}» (${d.clientName}): ${d.quietDays} días quieto`,
    why: `${d.why} Vale ${formatAmount(d.value, d.currency)}. ${d.suggestion}${d.ownerName ? ` La tarea le quedaría a ${d.ownerName}.` : ''}`,
    proposedAction: {
      toolId: 'crm.log_activity',
      input: {
        opportunity: d.id,
        kind: 'task',
        title: d.suggestion.slice(0, 300),
        dueOn: today,
      },
    },
    effect: 'internal_write',
    risk: 'low',
    amount: d.value,
    currency: d.currency,
    counterparty: d.clientName,
    dedupeKey: `crm:quieto:${d.id}`,
    href: `/comercial?tab=oportunidades&abrir=${d.id}`,
  }));
}

export function collectClientesEnRiesgo(s: SnapshotCrm | undefined): PlanItem[] {
  if (!s) return [];
  return s.newlyAtRisk.slice(0, MAX_RISK_TELLS).map((c) => ({
    area: 'gerencia',
    title: `${c.clientName}: ${RISK_LABEL[c.level].toLowerCase()} de perderse`,
    why: `${c.evidence.slice(0, 3).join(' ')}${c.action ? ` Sugerencia: ${c.action}` : ''}${c.ownerName ? ` (lo atiende ${c.ownerName}).` : ''}`,
    proposedAction: null,
    effect: null,
    risk: c.level === 'alto' ? 'high' : 'medium',
    amount: c.revenue12m > 0 ? c.revenue12m : null,
    currency: 'COP',
    counterparty: c.clientName,
    dedupeKey: `crm:riesgo:${c.clientId}:${c.level}`,
    href: '/comercial?tab=riesgo',
  }));
}
