import type {
  BankPreviewResult,
  ColumnRole,
  PreviewLine,
  SuggestionView,
} from '@cortex/agent-tools';

/**
 * Lo que la conciliación del banco le entrega al navegador.
 *
 * Mismo criterio que `types.ts`: el servidor ya escribió las cifras y las
 * fechas, y el navegador no suma nada. Los tipos del paquete se importan como
 * TIPOS: un componente de cliente no puede arrastrar `@cortex/agent-tools`
 * entero al bundle.
 */

export type { BankPreviewResult, ColumnRole, PreviewLine, SuggestionView };

export interface SuggestionChoice {
  kind: 'document' | 'accounting';
  id: string;
  label: string;
  reasons: string[];
  exact: boolean;
}

export interface ReconItemView {
  paymentId: string;
  date: string;
  amount: string;
  description: string;
  reference: string | null;
  account: string | null;
  client: string | null;
  invoiceNumber: string | null;
  status: 'matched' | 'suggested' | 'unmatched' | 'disputed';
  reason: string;
  suggestions: SuggestionChoice[];
  currency: string;
}

export interface BankReconView {
  matched: ReconItemView[];
  suggested: ReconItemView[];
  unmatched: ReconItemView[];
  accounts: string[];
  /** Para escoger a mano, cuando ninguna sugerencia es la buena. */
  openInvoices: Array<SuggestionChoice & { currency: string }>;
}

export type BankPreviewAction =
  | { ok: true; result: BankPreviewResult }
  | { ok: false; error: string };

export interface BankImportAction {
  ok: boolean;
  error?: string;
  note?: string;
  needsMapping?: boolean;
}
