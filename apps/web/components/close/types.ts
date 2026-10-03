import type {
  ClosePeriodSummary,
  CloseTaskView,
  CloseView,
  WritebackKind,
  WritebackPreview,
  WritebackQueueItem,
} from '@cortex/agent-tools';

/** Lo que devuelve cada botón de /cierre. */
export type CloseActionResult = { ok: true; note: string } | { ok: false; error: string };

export interface MappingRowView {
  scope: 'categoria' | 'proveedor' | 'rol';
  key: string;
  /** «Arriendo», «Retención en la fuente – compras», «Banco: Bancolombia corriente». */
  label: string;
  accountCode: string;
  accountName: string;
  costCenter: string | null;
  refs: { siigo?: string; alegra?: string; quickbooks?: string };
  /** true: la empresa lo cambió; false: es el defecto de Cortex. */
  custom: boolean;
}

export interface CloseScreenData {
  today: string;
  period: string;
  periods: string[];
  view: CloseView | null;
  viewError: string | null;
  queue: {
    provider: string | null;
    providerName: string | null;
    guidance: string | null;
    items: WritebackQueueItem[];
    done: WritebackQueueItem[];
  } | null;
  queueError: string | null;
  history: ClosePeriodSummary[];
  mapping: MappingRowView[];
  suppliers: Array<{ id: string; name: string }>;
  team: Array<{ id: string; name: string }>;
  events: Array<{ kind: string; who: string | null; detail: string | null; at: string }>;
  canManage: boolean;
  links: {
    self: string;
    pdf: string;
    integrations: string;
    approvals: string;
    /** El chat, para «Pídeselo a Cortex» (se le agrega ?prompt=). */
    chat: string;
  };
  /** La ruta de cada arreglo, ya con el espacio de trabajo. */
  fixHref: Record<string, string>;
}

export interface CloseScreenActions {
  markTask: (
    period: string,
    key: string,
    status: 'pendiente' | 'hecha' | 'no_aplica',
    evidence: string,
  ) => Promise<CloseActionResult>;
  assignTask: (period: string, key: string, ownerId: string | null) => Promise<CloseActionResult>;
  closePeriod: (period: string, note: string) => Promise<CloseActionResult>;
  reopenPeriod: (period: string, reason: string) => Promise<CloseActionResult>;
  openOverride: (period: string, reason: string) => Promise<CloseActionResult>;
  preview: (
    kind: WritebackKind,
    sourceId: string,
  ) => Promise<{ ok: true; preview: WritebackPreview } | { ok: false; error: string }>;
  register: (
    items: Array<{ kind: WritebackKind; sourceId: string }>,
    retryUncertain: boolean,
  ) => Promise<
    | { ok: true; note: string; results: Array<{ sourceId: string; ok: boolean; message: string }> }
    | { ok: false; error: string }
  >;
  discard: (kind: WritebackKind, sourceId: string, reason: string) => Promise<CloseActionResult>;
  restore: (kind: WritebackKind, sourceId: string) => Promise<CloseActionResult>;
  saveMapping: (row: {
    scope: 'categoria' | 'proveedor' | 'rol';
    key: string;
    accountCode: string;
    accountName: string;
    costCenter: string;
    refs: { siigo?: string; alegra?: string; quickbooks?: string };
  }) => Promise<CloseActionResult>;
  resetMapping: (
    scope: 'categoria' | 'proveedor' | 'rol',
    key: string,
  ) => Promise<CloseActionResult>;
}

export type { CloseTaskView };
