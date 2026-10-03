import type { StatusTone } from '@/lib/status-chip';

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
