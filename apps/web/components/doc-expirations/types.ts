/**
 * Las formas que viajan del servidor a los componentes de «Documentos que
 * vencen». Datos planos: nada de aquí importa valores de `@cortex/agent-tools`.
 */

export interface Option {
  value: string;
  label: string;
}

export interface ExpirationDetail {
  id: string;
  title: string;
  kindLabel: string;
  subject: string | null;
  subjectKindLabel: string;
  issuer: string | null;
  number: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  when: string;
  status: string;
  statusLabel: string;
  owner: string | null;
  renewalLeadDays: number;
  confidence: 'alta' | 'media' | 'baja';
  confidenceLabel: string;
  reviewNote: string | null;
  source: 'documento' | 'manual';
  evidence: string | null;
  evidenceHidden: boolean;
  documentTitle: string | null;
  documentHref: string | null;
  /** El espacio del Cerebro donde subir la renovación. */
  spaceId: string | null;
  clientHref: string | null;
  clientName: string | null;
  vehiclePlate: string | null;
  commitmentHref: string | null;
}

export interface ReviewItem extends ExpirationDetail {
  kind: string;
  subjectKind: string;
  ownerId: string | null;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  note?: string;
}

export interface TrackInput {
  kind: string;
  expiresOn: string;
  subject?: string;
  subjectKind?: string;
  label?: string;
  issuer?: string;
  number?: string;
  issuedOn?: string;
  ownerUserId?: string;
  renewalLeadDays?: number;
}

export interface ConfirmInput {
  id: string;
  expiresOn?: string;
  kind?: string;
  subject?: string;
  ownerUserId?: string;
  renewalLeadDays?: number;
}

export interface ExpirationHandlers {
  confirm?: (input: ConfirmInput) => Promise<ActionResult>;
  discard?: (input: { id: string; reason: string }) => Promise<ActionResult>;
  track?: (input: TrackInput) => Promise<ActionResult>;
  edit?: (rowId: string, key: string, value: unknown) => Promise<void>;
  linkRenewal?: (input: { expirationId: string; documentId: string }) => Promise<ActionResult>;
  backfill?: () => Promise<ActionResult>;
}
