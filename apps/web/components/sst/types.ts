/**
 * LAS FORMAS QUE PINTA /sst (0194). Llegan armadas del servidor; aquí no se
 * importa `@cortex/agent-tools` (sólo tipos).
 */

export type ActionResult = { ok: true; note: string } | { ok: false; error: string };

export interface SstOption {
  value: string;
  label: string;
}

export interface StandardView {
  id: string;
  code: string;
  title: string;
  cycle: string;
  weight: number;
  status: 'pendiente' | 'cumple' | 'no_cumple' | 'no_aplica';
  justification: string | null;
  evidenceDocumentId: string | null;
  evidenceUrl: string | null;
  dueDate: string | null;
}

export interface ComplianceView {
  score: number;
  rating: 'critico' | 'moderado' | 'aceptable';
  ratingLabel: string;
  action: string;
  met: number;
  notMet: number;
  pending: number;
  notApplicable: number;
  withoutEvidence: number;
  total: number;
}

export interface ActivityView {
  id: string;
  kind: string;
  kindLabel: string;
  title: string;
  plannedDate: string | null;
  doneDate: string | null;
  status: 'programada' | 'realizada' | 'cancelada';
  participants: number | null;
  person: string | null;
  examType: string | null;
  standardCode: string | null;
  hasEvidence: boolean;
  overdue: boolean;
}

export interface IncidentView {
  id: string;
  kind: string;
  kindLabel: string;
  severity: string;
  occurredOn: string;
  person: string | null;
  place: string | null;
  description: string;
  furatDue: string | null;
  furatReportedOn: string | null;
  investigationDue: string;
  investigationDoneOn: string | null;
  ministryDue: string | null;
  status: 'abierto' | 'investigado' | 'cerrado';
  alerts: Array<{ what: 'furat' | 'investigacion'; due: string; overdue: boolean }>;
}

export interface SstSettingsView {
  workers: number;
  maxRiskClass: number;
  committee: 'copasst' | 'vigia';
  responsibleUserId: string | null;
  responsibleName: string | null;
  responsibleLicense: string | null;
  arl: string | null;
  configured: boolean;
}
