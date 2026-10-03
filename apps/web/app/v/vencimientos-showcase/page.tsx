import type { Option } from '@/components/doc-expirations/types';
import { type ScreenExpiration, buildExpirationsScreen } from '@/lib/doc-expirations/grid';
import { type ExpirationRow, adaptExpiration } from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { VencimientosShowcase } from './Showcase';

/**
 * «DOCUMENTOS QUE VENCEN» CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /documentos-vencen pide sesión; aquí se pintan los mismos componentes con
 * una flota y unos papeles de mentira: un SOAT vencido, una tecnomecánica por
 * vencer, una póliza vigente, un contrato renovado, y en «Por revisar» tres
 * lecturas (una alta, una sin fecha porque el documento la calculaba, una de
 * un espacio que quien mira no ve).
 *
 * Parámetros: `?pantalla=revisar`, `?pantalla=ficha` (el panel de la ficha
 * del cliente), `?modo=oscuro`, `?vacia=1`. En producción responde 404.
 */
export const dynamic = 'force-dynamic';

const TODAY = '2026-10-03';
const ANA = 'u-ana';
const LUIS = 'u-luis';

const TEAM: Option[] = [
  { value: ANA, label: 'Ana Gómez' },
  { value: LUIS, label: 'Luis Peña' },
];

function row(over: Partial<ExpirationRow>): ExpirationRow {
  return {
    id: 'x',
    document_id: 'doc-1',
    chunk_id: null,
    space_id: 'space-flota',
    source: 'documento',
    kind: 'soat',
    title: 'SOAT',
    subject_kind: 'vehiculo',
    subject: null,
    subject_key: null,
    vehicle_id: null,
    client_id: null,
    issuer: null,
    number: null,
    issued_on: null,
    expires_on: null,
    issued_quote: null,
    expires_quote: null,
    renewal_lead_days: 30,
    owner_user_id: ANA,
    status: 'vigente',
    confidence: 'alta',
    needs_review: false,
    review_note: null,
    confirmed_by: ANA,
    confirmed_at: '2026-09-01T12:00:00Z',
    commitment_id: 'c-1',
    renewed_by_id: null,
    renewed_at: null,
    dismissed_reason: null,
    model_id: null,
    extractor_version: 'v1',
    created_by: LUIS,
    created_at: '2026-09-01T12:00:00Z',
    updated_at: '2026-09-01T12:00:00Z',
    owner_name: 'Ana Gómez',
    document_title: 'SOAT WGY482 2026.pdf',
    vehicle_plate: null,
    client_name: null,
    ...over,
  };
}

const WATCHED: ExpirationRow[] = [
  row({
    id: 'e-soat',
    title: 'SOAT · WGY482',
    subject: 'WGY482',
    vehicle_plate: 'WGY482',
    issuer: 'Seguros del Estado',
    number: '1234567890',
    expires_on: '2026-09-28',
    expires_quote: 'FIN DE VIGENCIA 28/09/2026 23:59',
  }),
  row({
    id: 'e-rtm',
    kind: 'tecnomecanica',
    title: 'Tecnomecánica · HKL903',
    subject: 'HKL903',
    issuer: 'CDA Autopista Sur',
    expires_on: '2026-10-21',
    expires_quote: 'Fecha de vencimiento: 21 de octubre de 2026',
    owner_user_id: LUIS,
    owner_name: 'Luis Peña',
    document_title: 'Certificado RTM HKL903.pdf',
  }),
  row({
    id: 'e-poliza',
    kind: 'poliza',
    title: 'Póliza de responsabilidad civil · Seguros Bolívar',
    subject_kind: 'empresa',
    issuer: 'Seguros Bolívar',
    number: 'RC-88213',
    issued_on: '2026-04-01',
    expires_on: '2027-03-31',
    expires_quote: 'Vigencia: desde 01/04/2026 hasta 31/03/2027',
    renewal_lead_days: 45,
    document_title: 'Póliza RC 2026-2027.pdf',
  }),
  row({
    id: 'e-contrato',
    kind: 'contrato',
    title: 'Contrato de transporte · Nexa Logística',
    subject_kind: 'cliente',
    subject: 'Nexa Logística',
    client_id: 'cl-nexa',
    client_name: 'Nexa Logística',
    expires_on: '2026-11-30',
    expires_quote: 'El presente contrato estará vigente hasta el 30 de noviembre de 2026.',
    renewal_lead_days: 60,
    document_title: 'Contrato Nexa 2025.pdf',
  }),
  row({
    id: 'e-licencia',
    kind: 'licencia',
    title: 'Licencia de funcionamiento',
    subject_kind: 'empresa',
    source: 'manual',
    document_id: null,
    space_id: null,
    expires_on: '2027-06-30',
    renewal_lead_days: 60,
    document_title: null,
  }),
  row({
    id: 'e-viejo',
    kind: 'contrato',
    title: 'Contrato de transporte · Nexa Logística',
    subject_kind: 'cliente',
    subject: 'Nexa Logística',
    expires_on: '2025-11-30',
    status: 'renovado',
    renewed_by_id: 'e-contrato',
    document_title: 'Contrato Nexa 2024.pdf',
  }),
];

const PENDING: ExpirationRow[] = [
  row({
    id: 'p-soat',
    title: 'SOAT · JKT221',
    subject: 'JKT221',
    issuer: 'Sura',
    number: '99887766',
    expires_on: '2027-08-14',
    expires_quote: 'FIN DE VIGENCIA 14/08/2027 23:59',
    needs_review: true,
    confirmed_by: null,
    confirmed_at: null,
    commitment_id: null,
    document_title: 'SOAT JKT221.pdf',
  }),
  row({
    id: 'p-poliza',
    kind: 'poliza',
    title: 'Póliza de cumplimiento · Seguros Mundial',
    subject_kind: 'empresa',
    issuer: 'Seguros Mundial',
    expires_on: null,
    expires_quote:
      'La presente póliza tiene una vigencia de doce meses desde el 1 de abril de 2026.',
    confidence: 'baja',
    review_note: 'la cita no dice 2027-04-01: la fecha sería calculada, no leída',
    needs_review: true,
    confirmed_by: null,
    confirmed_at: null,
    commitment_id: null,
    document_title: 'Póliza cumplimiento.pdf',
  }),
  row({
    id: 'p-hab',
    kind: 'habilitacion',
    title: 'Habilitación de transporte de carga',
    subject_kind: 'empresa',
    space_id: 'space-gerencia',
    expires_on: '2028-02-01',
    expires_quote: 'Resolución vigente hasta el 1 de febrero de 2028',
    confidence: 'media',
    review_note: 'no encontré la frase donde el documento dice qué es',
    needs_review: true,
    confirmed_by: null,
    confirmed_at: null,
    commitment_id: null,
  }),
];

export default async function VencimientosShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const empty = one('vacia') === '1';
  const visible = new Set(['space-flota']);
  const adapt = (r: ExpirationRow): ScreenExpiration => ({
    ...adaptExpiration(r, TODAY, visible),
    ownerId: r.owner_user_id,
    spaceId: r.space_id,
  });
  const screen = buildExpirationsScreen(
    empty ? [] : WATCHED.map(adapt),
    empty ? [] : PENDING.map(adapt),
    TEAM,
  );
  const pantalla = one('pantalla');
  const nexa = WATCHED.filter((r) => r.client_id === 'cl-nexa').map((r) => {
    const e = adaptExpiration(r, TODAY);
    return {
      id: e.id,
      title: e.title,
      kindLabel: e.kindLabel,
      expiresOn: e.expiresOn,
      when: e.when,
      status: e.status,
      statusLabel: e.statusLabel,
      needsReview: e.needsReview,
    };
  });
  return (
    <VencimientosShowcase
      dark={one('modo') === 'oscuro'}
      pantalla={pantalla === 'revisar' ? 'revisar' : pantalla === 'ficha' ? 'ficha' : 'lista'}
      screen={screen}
      team={TEAM}
      clientItems={nexa}
    />
  );
}
