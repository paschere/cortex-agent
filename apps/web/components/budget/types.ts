import type { ScreenResult } from '@/components/statements/types';
import type { Budget, BudgetReport, ForecastBundle } from '@cortex/agent-tools';

export interface BudgetLinks {
  self: string;
  statements: string;
  board: string;
  finance: string;
}

export interface BudgetActions {
  create: (input: {
    year: number;
    basis: 'ultimo_anio' | 'desde_cero';
    growthPct: number;
    incomeGrowthPct: number | null;
  }) => Promise<ScreenResult & { id?: string }>;
  setCells: (
    budgetId: string,
    cells: Array<{ category: string; month: number; amount: number }>,
  ) => Promise<ScreenResult>;
  removeCategory: (budgetId: string, category: string) => Promise<ScreenResult>;
  setStatus: (
    budgetId: string,
    status: 'borrador' | 'aprobado' | 'archivado',
  ) => Promise<ScreenResult>;
}

export interface BudgetScenario {
  ventasPct: number | null;
  category: string | null;
  categoryPct: number | null;
  withoutClient: string | null;
}

export interface BudgetScreenProps {
  year: number;
  today: string;
  tab: 'real' | 'editar' | 'pronostico';
  budgets: Budget[];
  report: BudgetReport;
  forecast: ForecastBundle | null;
  forecastError: string | null;
  /** Categorías conocidas del libro, para agregar filas. */
  categories: Array<{ key: string; label: string }>;
  lightLabels: Record<string, string>;
  statusLabels: Record<string, string>;
  scenario: BudgetScenario;
  hasLastYear: boolean;
  links: BudgetLinks;
  actions: BudgetActions;
}
