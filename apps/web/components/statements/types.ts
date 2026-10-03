import type { IncomeLineMeta, StatementsResult } from '@cortex/agent-tools';

/** Lo que una acción de /estados, /presupuesto o /informe-socios contesta. */
export type ScreenResult = { ok: true; note?: string } | { ok: false; error: string };

export interface StatementsLinks {
  self: string;
  budget: string;
  board: string;
  finance: string;
  integrations: string;
  chat: string;
}

export interface StatementsActions {
  refresh: (year: number, month: number) => Promise<ScreenResult>;
  saveClasses: (classes: Record<string, string>) => Promise<ScreenResult>;
}

export interface StatementsScreenProps {
  data: StatementsResult;
  lines: IncomeLineMeta[];
  classLabels: Record<string, string>;
  classKeys: string[];
  providerLabel: string | null;
  canEdit: boolean;
  links: StatementsLinks;
  actions: StatementsActions;
}
