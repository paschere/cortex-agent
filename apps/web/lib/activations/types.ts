export type InvoiceColumnMapping = {
  invoiceNumber: number;
  issuer: number;
  amount: number;
  currency: number;
  issuedOn: number;
};

export type ActivationConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'is_empty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'before_today'
  | 'after_today';

export type ActivationDefinition =
  | {
      version: 1;
      name: string;
      kind: 'invoice_duplicates';
      mapping: InvoiceColumnMapping;
      caseTitle?: string;
      caseObjective?: string;
      caseNextAction?: string;
    }
  | {
      version: 1;
      name: string;
      kind: 'table_rule';
      rule: 'duplicates' | 'conditions';
      conditions: Array<{
        column: number;
        operator: ActivationConditionOperator;
        value?: string;
      }>;
      match: 'all' | 'any';
      groupBy: number[];
      evidenceColumns?: number[];
      caseTitle: string;
      caseObjective: string;
      caseNextAction: string;
    };

export type ActivationSource = {
  id: string;
  filename: string;
  createdAt: string;
  expiresAt: string;
  sheets: Array<{ index: number; name: string; rowCount: number; headers: string[] }>;
};

export type ActivationCandidate = {
  rowIndex: number;
  sourceKey: string;
  status: 'matched' | 'unmatched' | 'invalid';
  values: Array<{ column: number; header: string; value: string }>;
  reasons: string[];
  groupKey: string | null;
  // Present for the invoice preset so current consumers can show its richer evidence.
  invoiceNumber?: string;
  issuer?: string;
  amount?: string;
  currency?: string;
  issuedOn?: string;
};

export type ActivationRun = {
  id: string;
  sourceId: string;
  sourceName: string;
  sheetIndex: number;
  sheetName: string;
  definition: ActivationDefinition;
  mapping: InvoiceColumnMapping | null;
  status: 'simulated' | 'committed';
  candidates: ActivationCandidate[];
  createdAt: string;
  committedAt: string | null;
  caseIds: string[];
};

export type ActivationsGetResponse = {
  sources: ActivationSource[];
  runs: ActivationRun[];
  limits: { maxSheets: number; maxRows: number; maxTextLength: number };
};

export type SimulateActivationRequest = {
  action: 'simulate';
  sourceId: string;
  sheetIndex: number;
  definition: ActivationDefinition;
};

export type CommitActivationRequest = {
  action: 'commit';
  runId: string;
  shareConfirmed: true;
};

export type ActivationsPostRequest = SimulateActivationRequest | CommitActivationRequest;
export type SimulateActivationResponse = { run: ActivationRun };
export type CommitActivationResponse = {
  run: ActivationRun;
  created: number;
  reused: number;
};
