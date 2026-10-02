import type { PlanView } from '@/lib/autopilot/screen';

/**
 * Lo que las pantallas del piloto le piden al servidor. En /piloto son las
 * acciones de servidor (app/(app)/piloto/actions.ts); en /v/piloto-showcase,
 * unas de mentira que contestan igual sin guardar nada.
 */

export interface AutopilotSettingsInput {
  enabled?: boolean;
  runHour?: number;
  runDays?: number[];
  skipHolidays?: boolean;
  quietDays?: string[];
  areaLevels?: Record<string, 'avisar' | 'proponer' | 'hacer'>;
  maxExternalMessages?: number;
  maxAmountReferenced?: number;
  maxActionsPerRun?: number;
  notifyEmail?: boolean;
}

export type AutopilotActionResult = { ok: boolean; note: string };

export interface AutopilotActions {
  save(input: AutopilotSettingsInput): Promise<AutopilotActionResult>;
  dryRun(): Promise<{ ok: true; plan: PlanView } | { ok: false; note: string }>;
  decide(input: {
    itemId: string;
    decision: 'approve' | 'dismiss';
    contentHash: string;
  }): Promise<AutopilotActionResult>;
}
