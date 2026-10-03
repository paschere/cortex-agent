import type { StatusTone } from '@/lib/status-chip';
import type { DraftFigures, DraftStatus } from '@cortex/agent-tools';

/**
 * Lo que la pantalla de Impuestos recibe ya armado (lib/tax/screen.ts). Sólo
 * tipos y datos planos: estos componentes son de cliente y no importan nada
 * en tiempo de ejecución de @cortex/agent-tools.
 */

export type TaxStatus = 'pendiente' | 'presentada' | 'pagada' | 'no_aplica';

export interface TaxObligationView {
  id: string;
  kind: string;
  kindLabel: string;
  title: string;
  period: string;
  authority: string;
  form: string | null;
  dueDate: string;
  /** «14 may». */
  dueLabel: string;
  /** «jueves». */
  weekday: string;
  /** `YYYY-MM` del vencimiento: la agrupación por mes. */
  month: string;
  daysLeft: number;
  status: TaxStatus;
  statusLabel: string;
  tone: StatusTone;
  /** «Vence en 4 días», «Venció hace 2 días», «Pagada el 12 may». */
  whenText: string;
  overdue: boolean;
  needsConfirmation: boolean;
  requiresPayment: boolean;
  sourceNote: string | null;
  statusNote: string | null;
  evidenceHref: string | null;
  evidenceLabel: string | null;
  /** «Ver borrador» (0197): la ruta del borrador, si esta obligación tiene. */
  draftHref: string | null;
  draftStatus: DraftStatus | null;
}

export interface TaxPerson {
  id: string;
  name: string;
}

export interface TaxProfileView {
  nit: string;
  dv: string | null;
  personType: 'juridica' | 'natural';
  granContribuyente: boolean;
  regimenSimple: boolean;
  ivaPeriodicity: 'none' | 'bimestral' | 'cuatrimestral';
  agenteRetencion: boolean;
  icaCity: 'bogota' | 'medellin' | 'cali' | 'barranquilla' | 'otra' | null;
  icaPeriodicity: 'bimestral' | 'anual' | 'mensual' | null;
  exogena: boolean;
  activosExterior: boolean;
  camaraComercio: boolean;
  nominaElectronica: boolean;
  pila: boolean;
  facturacionElectronica: boolean;
  impuestoPatrimonio: boolean;
  vinculadosExterior: boolean;
  rubLastChange: string | null;
  autorretencionRate: number | null;
  simpleRate: number | null;
  icaActivities: Array<{ code: string; label: string; ratePerMil: number }>;
  ownerUserId: string | null;
  ownerName: string | null;
  noticeDays: number;
  source: 'manual' | 'rut';
  updatedLabel: string | null;
}

/** Lo que manda el formulario del perfil. */
export type TaxProfileFormInput = Omit<TaxProfileView, 'ownerName' | 'updatedLabel'>;

export interface TaxSummary {
  pending: number;
  overdue: number;
  toConfirm: number;
  done: number;
  next: TaxObligationView | null;
}

export interface TaxScreenData {
  year: number;
  years: number[];
  today: string;
  profile: TaxProfileView | null;
  obligations: TaxObligationView[];
  summary: TaxSummary;
  /** Lo que Cortex no calcula, en frases. */
  gaps: string[];
  /** Contra qué se verificaron las fechas del año. */
  sourceLine: string;
  canEdit: boolean;
  canMark: boolean;
  people: TaxPerson[];
  /** NIT sugerido desde «Datos de la empresa», si no hay perfil. */
  suggestedNit: string | null;
}

export interface TaxLinks {
  self: string;
  /** El chat con la petición de leer el RUT. */
  rutChat: string;
  /** Procesos de la DIAN listos para activar. */
  processes: string;
  finance: string;
  commitments: string;
  /** POST multipart para subir la evidencia al Cerebro. */
  uploadApi: string;
  /** Las pestañas (0197). */
  certificates?: string;
  exogena?: string;
}

export interface TaxMarkInput {
  id: string;
  status: TaxStatus;
  note?: string | null;
  evidenceDocumentId?: string | null;
  evidenceUrl?: string | null;
}

export interface TaxActions {
  saveProfile: (input: TaxProfileFormInput) => Promise<{ ok: boolean; note: string }>;
  mark: (input: TaxMarkInput) => Promise<{ ok: boolean; note: string }>;
}

/**
 * Sube un archivo al Cerebro y devuelve su id. No es una acción de servidor:
 * la pantalla lo hace con `fetch` a `links.uploadApi`; la ficha de muestra
 * pasa uno de mentira.
 */
export type TaxUpload = (file: File) => Promise<{ ok: boolean; documentId?: string; note: string }>;

// ---------------------------------------------------------------------------
// Borradores (0197)
// ---------------------------------------------------------------------------

/** La pestaña activa de /impuestos. */
export type TaxTab = 'calendario' | 'certificados' | 'exogena';

export interface TaxTabLinks {
  calendario: string;
  certificados: string;
  exogena: string;
}

export interface TaxDraftScreen {
  obligation: {
    id: string;
    title: string;
    dueLabel: string;
    whenText: string;
    tone: StatusTone;
    needsConfirmation: boolean;
    statusLabel: string;
    form: string | null;
  };
  figures: DraftFigures;
  /** El borrador guardado, si lo hay. */
  saved: {
    id: string;
    status: DraftStatus;
    statusLabel: string;
    reviewedLabel: string | null;
    presentedLabel: string | null;
    evidenceHref: string | null;
    notes: string | null;
  } | null;
  /** Las cifras son de ahora (true) o las congeladas al revisar (false). */
  live: boolean;
  canAct: boolean;
  /** Para armar los enlaces del detalle dentro del espacio. */
  hrefs: { back: string; pdf: string; upload: string; tabs: TaxTabLinks };
  /** Rutas del detalle («/ventas/…») ya con el espacio. */
  sourceHref: Record<string, string>;
}

export interface TaxDraftActions {
  save: (note: string | null) => Promise<{ ok: boolean; note: string }>;
  review: (note: string | null, expectedResult: number) => Promise<{ ok: boolean; note: string }>;
  present: (input: {
    evidenceDocumentId: string | null;
    evidenceUrl: string | null;
    note: string | null;
  }) => Promise<{ ok: boolean; note: string }>;
  annul: (note: string | null) => Promise<{ ok: boolean; note: string }>;
}

export interface CertificateRowView {
  key: string;
  supplierId: string | null;
  supplierName: string;
  supplierNit: string | null;
  concept: string | null;
  /** El concepto de retención guardado en el proveedor (sólo renta). */
  supplierConcept: string | null;
  base: number;
  withheld: number;
  invoices: number;
  hasEmail: boolean;
  sentLabel: string | null;
  pdfHref: string;
}

export interface CertificatesScreen {
  kind: 'renta' | 'iva' | 'ica';
  year: number;
  period: number | null;
  years: number[];
  rows: CertificateRowView[];
  total: number;
  canAct: boolean;
  concepts: Array<{ value: string; label: string }>;
  hrefs: { tabs: TaxTabLinks; self: string };
}

export interface CertificatesActions {
  send: (suppliers: string[]) => Promise<{ ok: boolean; note: string }>;
  setConcept: (
    supplierId: string,
    concept: string | null,
  ) => Promise<{ ok: boolean; note: string }>;
}

export interface ExogenaFormatView {
  code: string;
  title: string;
  rows: number;
  total: number;
  columns: string[];
  preview: Array<Array<string | number>>;
  missing: string[];
  notes: string[];
  csvHref: string;
}

export interface ExogenaScreen {
  year: number;
  years: number[];
  formats: ExogenaFormatView[];
  versionNote: string;
  hrefs: { tabs: TaxTabLinks; self: string };
}
