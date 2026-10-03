import { z } from 'zod';
import { daysBetween } from '../commitments/shape';
import {
  CONFIDENCE_LABEL,
  EXPIRATION_KINDS,
  EXPIRATION_KIND_LABEL,
  EXPIRATION_STATUSES,
  STATUS_LABEL,
  SUBJECT_KINDS,
  SUBJECT_KIND_LABEL,
  daysPhrase,
  deriveExpirationStatus,
} from './kinds';
import type { ExpirationRow } from './store';

/**
 * Una fila, como la ven el chat y la pantalla.
 *
 * LA CITA SÓLO PARA QUIEN VE EL DOCUMENTO. La fecha, el tipo y el sujeto de
 * un papel son un hecho operativo de la empresa; la frase del documento y su
 * título son contenido del Cerebro, y el Cerebro tiene permisos por espacio
 * (0123). `visibleSpaces` es la lista de espacios que esa persona ve; un papel
 * de un espacio ajeno llega sin cita ni título, diciendo que existe.
 */

export const expirationSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(EXPIRATION_KINDS),
  kindLabel: z.string(),
  subjectKind: z.enum(SUBJECT_KINDS),
  subjectKindLabel: z.string(),
  subject: z.string().nullable().describe('Plate, client, person or company the paper belongs to'),
  issuer: z.string().nullable(),
  number: z.string().nullable(),
  issuedOn: z.string().nullable(),
  expiresOn: z.string().nullable().describe('YYYY-MM-DD, Colombian time. Null = not readable yet'),
  daysLeft: z.number().nullable().describe('Whole days until it lapses; negative once past'),
  when: z.string().describe('«vence en 12 días», «venció hace 3 días»'),
  status: z.enum(EXPIRATION_STATUSES),
  statusLabel: z.string(),
  renewalLeadDays: z.number(),
  owner: z.string().nullable(),
  needsReview: z
    .boolean()
    .describe('True = read from a document and NOT confirmed by a person; not being watched'),
  confidence: z.enum(['alta', 'media', 'baja']),
  confidenceLabel: z.string(),
  reviewNote: z.string().nullable(),
  source: z.enum(['documento', 'manual']),
  documentTitle: z.string().nullable(),
  documentId: z.string().nullable(),
  /** The literal sentence the expiry date was read from. Cite it. */
  evidence: z.string().nullable(),
  evidenceHidden: z.boolean().describe('The document lives in a space this person cannot see'),
  vehiclePlate: z.string().nullable(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  commitmentId: z.string().nullable(),
});

export type Expiration = z.infer<typeof expirationSchema>;

export function adaptExpiration(
  row: ExpirationRow,
  today: string,
  visibleSpaces?: ReadonlySet<string> | null,
): Expiration {
  const status = deriveExpirationStatus(row, today);
  const hidden = !!(visibleSpaces && row.space_id && !visibleSpaces.has(row.space_id));
  const left = row.expires_on ? daysBetween(today, row.expires_on) : null;
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    kindLabel: EXPIRATION_KIND_LABEL[row.kind] ?? row.kind,
    subjectKind: row.subject_kind,
    subjectKindLabel: SUBJECT_KIND_LABEL[row.subject_kind] ?? row.subject_kind,
    subject: row.subject,
    issuer: row.issuer,
    number: row.number,
    issuedOn: row.issued_on,
    expiresOn: row.expires_on,
    daysLeft: left != null && Number.isFinite(left) ? left : null,
    when: daysPhrase(row.expires_on, today),
    status,
    statusLabel: STATUS_LABEL[status],
    renewalLeadDays: row.renewal_lead_days,
    owner: row.owner_name ?? null,
    needsReview: row.needs_review,
    confidence: row.confidence,
    confidenceLabel: CONFIDENCE_LABEL[row.confidence] ?? row.confidence,
    reviewNote: row.review_note,
    source: row.source,
    documentTitle: hidden ? null : (row.document_title ?? null),
    documentId: hidden ? null : row.document_id,
    evidence: hidden ? null : (row.expires_quote ?? null),
    evidenceHidden: hidden,
    vehiclePlate: row.vehicle_plate ?? null,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    commitmentId: row.commitment_id,
  };
}

/** De dónde salió la fecha, en una frase para decir en voz alta. */
export function evidenceSentence(e: Expiration): string {
  if (e.source === 'manual') return 'Registrado a mano.';
  if (e.evidenceHidden) return 'Leído de un documento de un espacio que no ves.';
  const doc = e.documentTitle ? `«${e.documentTitle}»` : 'un documento del Cerebro';
  if (!e.evidence) return `Leído de ${doc}, sin una frase que diga la fecha.`;
  return e.needsReview
    ? `Propuesto a partir de ${doc} — «${e.evidence}» — y sin confirmar, así que todavía no se vigila.`
    : `Según ${doc}: «${e.evidence}».`;
}
