import type { TaxLinks, TaxPerson, TaxScreenData } from '@/components/tax/types';
import { buildTaxScreen } from '@/lib/tax/screen';
import {
  type TaxObligation,
  type TaxProfile,
  VERIFIED_DIAN_2026,
  buildTaxCalendar,
} from '@cortex/agent-tools';

/**
 * Transportes Andinos S.A.S., persona jurídica en Bogotá, con el motor de
 * verdad: las fechas salen de las tablas de 2026. Hoy es el 3 de octubre de
 * 2026; lo de antes está marcado como lo marcaría el contador.
 */

const TODAY = '2026-10-03';
const PEOPLE: TaxPerson[] = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Laura Gómez (contadora)' },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Andrés Pardo' },
];

const PROFILE: TaxProfile = {
  nit: '900123456',
  dv: '8',
  personType: 'juridica',
  granContribuyente: false,
  regimenSimple: false,
  ivaPeriodicity: 'bimestral',
  agenteRetencion: true,
  icaCity: 'bogota',
  icaPeriodicity: 'bimestral',
  exogena: true,
  activosExterior: false,
  camaraComercio: true,
  nominaElectronica: true,
  pila: true,
  facturacionElectronica: true,
  ownerUserId: '00000000-0000-4000-8000-000000000001',
  noticeDays: 7,
  source: 'rut',
  sourceDocumentId: null,
  updatedAt: '2026-09-15T14:00:00Z',
  updatedBy: '00000000-0000-4000-8000-000000000002',
};

export function fixtureData({ empty }: { empty: boolean }): {
  data: TaxScreenData;
  links: TaxLinks;
} {
  const engine = buildTaxCalendar(PROFILE, 2026);
  const rows: TaxObligation[] = engine.obligations.map((g, i) => {
    const past = g.dueDate < TODAY;
    // Lo pasado quedó pagado, menos dos: una vencida sin marcar y una presentada.
    const status = !past
      ? 'pendiente'
      : g.key === 'pila:2026-09'
        ? 'pendiente'
        : g.key === 'nomina_electronica:2026-08'
          ? 'presentada'
          : g.requiresPayment
            ? 'pagada'
            : 'presentada';
    return {
      ...g,
      id: `fx-${i}`,
      status,
      statusAt: status === 'pendiente' ? null : `${g.dueDate}T15:00:00Z`,
      statusBy: status === 'pendiente' ? null : (PEOPLE[0]?.id ?? null),
      statusNote: g.kind === 'iva' && past ? 'Formulario 300 n.º 3007604123456' : null,
      evidenceDocumentId: null,
      evidenceUrl: g.kind === 'retencion' && past ? 'https://muisca.dian.gov.co/recibo' : null,
      commitmentId: null,
    };
  });
  const data = buildTaxScreen({
    year: 2026,
    years: [2026, 2027],
    today: TODAY,
    profile: empty ? null : PROFILE,
    obligations: empty ? [] : rows,
    gaps: empty ? [] : engine.gaps,
    sourceLine: `${VERIFIED_DIAN_2026}. ICA: resoluciones de Bogotá y Medellín (por confirmar).`,
    canEdit: true,
    canMark: true,
    people: PEOPLE,
    suggestedNit: empty ? '900.123.456-8' : null,
  });
  const links: TaxLinks = {
    self: '/v/impuestos-showcase',
    rutChat: '/chat?prompt=RUT',
    processes: '/procesos',
    finance: '/finance',
    commitments: '/commitments',
    uploadApi: '/api/kb/documents',
  };
  return { data, links };
}
