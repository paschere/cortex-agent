import type { ScenarioAdjustment } from '@cortex/agent-tools/src/ledger/types';

/**
 * Lo que el panel de Finanzas puede pedir al servidor. La página real pasa
 * las acciones de `app/(app)/finance/actions.ts`; el escaparate de desarrollo
 * pasa unas de mentira. Así los componentes no saben de dónde vienen.
 */
export type FinanceActionResult =
  | { ok: true; note: string; id?: string }
  | { ok: false; error: string };

export interface FinanceActions {
  updateBalance(input: {
    account: string;
    currency: string;
    balance: string;
  }): Promise<FinanceActionResult>;
  saveScenario(input: {
    id?: string | null;
    label: string;
    adjustments: ScenarioAdjustment[];
  }): Promise<FinanceActionResult>;
  deleteScenario(id: string): Promise<FinanceActionResult>;
  declareRecurring(input: {
    label: string;
    direction: 'in' | 'out';
    amount: string;
    every: 'week' | 'month';
    anchor: number;
    category?: string | null;
    currency?: string | null;
  }): Promise<FinanceActionResult>;
  decideRecurring(input: {
    detectedKey: string;
    status: 'confirmed' | 'ignored';
  }): Promise<FinanceActionResult>;
  /** La caja mínima de la empresa. `amount` vacío o nulo la quita. */
  saveMinimumCash(input: {
    amount: string | null;
    currency?: string;
  }): Promise<FinanceActionResult>;
}

/** Direcciones ya dentro de la empresa activa (`workspaceHref`). */
export interface FinanceLinks {
  /** /finance, sin parámetros. */
  self: string;
  chat: string;
  payments: string;
  bankImport: string;
  accounting: string;
}
