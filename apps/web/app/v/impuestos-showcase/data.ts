import type {
  CertificatesScreen,
  ExogenaScreen,
  TaxDraftScreen,
  TaxLinks,
  TaxPerson,
  TaxScreenData,
  TaxTabLinks,
} from '@/components/tax/types';
import { buildCertificatesScreen } from '@/lib/tax/certificates-screen';
import { buildDraftScreen } from '@/lib/tax/draft-screen';
import { buildTaxScreen } from '@/lib/tax/screen';
import {
  type TaxObligation,
  type TaxProfile,
  VERIFIED_DIAN_2026,
  buildExogena,
  buildIvaDraft,
  buildRetencionDraft,
  buildTaxCalendar,
  buildWithholdingCertificates,
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
  impuestoPatrimonio: false,
  vinculadosExterior: false,
  rubLastChange: null,
  autorretencionRate: 0.8,
  simpleRate: null,
  icaActivities: [{ code: '4923', label: 'Transporte de carga por carretera', ratePerMil: 9.66 }],
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
    draftStatuses: new Map(
      rows.filter((r) => r.key === 'retencion:2026-08').map((r) => [r.id, 'revisado'] as const),
    ),
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
    certificates: '/v/impuestos-showcase?vista=certificados',
    exogena: '/v/impuestos-showcase?vista=exogena',
  };
  return { data, links };
}

// ---------------------------------------------------------------------------
// Borradores, certificados y exógena (0197), con los constructores de verdad
// ---------------------------------------------------------------------------

export const TABS: TaxTabLinks = {
  calendario: '/v/impuestos-showcase',
  certificados: '/v/impuestos-showcase?vista=certificados',
  exogena: '/v/impuestos-showcase?vista=exogena',
};

const sale = (
  id: string,
  date: string,
  client: [string, string],
  lines: Array<[IvaRate, number]>,
  w: { retefuentePct?: number; reteivaPct?: number; reteicaPerMil?: number } = {},
  kind: 'invoice' | 'credit_note' = 'invoice',
) => ({
  id,
  number: id,
  date,
  clientName: client[0],
  clientNit: client[1],
  kind,
  lines: lines.map(([rate, base]) => ({
    rate,
    base,
    iva:
      rate === 'iva_19' ? Math.round(base * 0.19) : rate === 'iva_5' ? Math.round(base * 0.05) : 0,
  })),
  withholdings: w,
  path: `/ventas/${id}`,
});
type IvaRate = 'iva_19' | 'iva_5' | 'iva_0' | 'excluido';

const ANDINA: [string, string] = ['Comercial Andina S.A.S.', '800111222'];
const ALPINA: [string, string] = ['Lácteos del Valle S.A.', '860025900'];
const SALES = [
  sale('FE-1201', '2026-09-03', ANDINA, [['iva_19', 18_400_000]], {
    retefuentePct: 1,
    reteivaPct: 15,
    reteicaPerMil: 9.66,
  }),
  sale(
    'FE-1202',
    '2026-09-11',
    ALPINA,
    [
      ['iva_19', 9_800_000],
      ['iva_5', 2_100_000],
    ],
    { retefuentePct: 1 },
  ),
  sale('FE-1207', '2026-09-24', ANDINA, [['excluido', 3_200_000]]),
  sale('FE-1215', '2026-10-06', ALPINA, [['iva_19', 12_650_000]], {
    retefuentePct: 1,
    reteivaPct: 15,
  }),
  sale('FE-1219', '2026-10-17', ['Agroinsumos del Sur', '900777888'], [['iva_0', 4_000_000]]),
  sale('NC-31', '2026-10-21', ANDINA, [['iva_19', 1_200_000]], {}, 'credit_note'),
];

const buy = (
  id: string,
  date: string,
  supplier: [string, string, string | null],
  subtotal: number | null,
  iva: number,
  w: { rf?: number; riva?: number; rica?: number } = {},
  extra: Partial<{
    pendingApproval: boolean;
    concept: 'compras' | 'servicios' | 'honorarios' | 'arrendamiento_inmuebles' | null;
    paidAt: string | null;
  }> = {},
) => ({
  id,
  number: id,
  date,
  supplierId: supplier[2],
  supplierName: supplier[0],
  supplierNit: supplier[1],
  kind: 'invoice' as const,
  subtotal,
  iva,
  total: (subtotal ?? 0) + iva || 0,
  retefuente: w.rf ?? 0,
  reteiva: w.riva ?? 0,
  reteica: w.rica ?? 0,
  concept: extra.concept ?? null,
  pendingApproval: extra.pendingApproval ?? false,
  paidAt: extra.paidAt ?? null,
  path: '/pagar',
});
const TERPEL: [string, string, string] = ['Combustibles Terpel', '830095213', 's1'];
const LLANTAS: [string, string, string] = ['Llantas y Rines del Norte', '901222333', 's2'];
const CONTADOR: [string, string, string] = ['Gómez & Asociados Contadores', '901444555', 's3'];
const BODEGA: [string, string, string] = ['Inmobiliaria La Sabana', '900666777', 's4'];
const PURCHASES = [
  buy(
    'FV-8812',
    '2026-09-05',
    TERPEL,
    6_200_000,
    1_178_000,
    { rf: 62_000 },
    { concept: 'compras', paidAt: '2026-09-20' },
  ),
  buy(
    'LL-334',
    '2026-09-12',
    LLANTAS,
    4_800_000,
    912_000,
    { rf: 120_000, riva: 136_800, rica: 46_368 },
    { concept: 'compras' },
  ),
  buy('GA-77', '2026-09-30', CONTADOR, 3_500_000, 665_000, { rf: 385_000 }, {}),
  buy(
    'LS-09',
    '2026-09-01',
    BODEGA,
    7_000_000,
    1_330_000,
    { rf: 245_000 },
    { concept: 'arrendamiento_inmuebles', paidAt: '2026-09-05' },
  ),
  buy(
    'FV-8890',
    '2026-10-04',
    TERPEL,
    5_900_000,
    1_121_000,
    { rf: 59_000 },
    { concept: 'compras', pendingApproval: true },
  ),
  buy('PP-12', '2026-10-09', ['Papelería El Punto', '79555111', null], null, 0, {}, {}),
];

export function draftFixture(kind: 'iva' | 'retencion'): TaxDraftScreen {
  const figures =
    kind === 'iva'
      ? buildIvaDraft({
          period: { from: '2026-09-01', to: '2026-10-31', label: 'Septiembre–octubre 2026' },
          sales: SALES,
          purchases: PURCHASES,
          accountingSales: [],
          ledgerIncomeWithoutInvoice: [
            {
              id: 'm1',
              date: '2026-10-14',
              amount: 2_380_000,
              description: 'Consignación sucursal Funza',
              counterparty: null,
            },
          ],
          unrecordedSupplierCreditNotes: 1,
          builtAt: `${TODAY}T12:00:00Z`,
        })
      : buildRetencionDraft({
          period: { from: '2026-09-01', to: '2026-09-30', label: 'Septiembre 2026' },
          purchases: PURCHASES,
          sales: SALES,
          salaries: {
            total: 1_284_000,
            base: 31_500_000,
            employees: 9,
            source: 'Nómina de Cortex',
          },
          hasEmployees: true,
          autorretencionRate: 0.8,
          uvt: 52_374,
          builtAt: `${TODAY}T12:00:00Z`,
        });
  const engine = buildTaxCalendar(PROFILE, 2026);
  const key = kind === 'iva' ? 'iva:b5' : 'retencion:2026-09';
  const g = engine.obligations.find((o) => o.key === key) ?? engine.obligations[0];
  const obligation: TaxObligation = {
    ...(g as NonNullable<typeof g>),
    id: 'fx-draft',
    status: 'pendiente',
    statusAt: null,
    statusBy: null,
    statusNote: null,
    evidenceDocumentId: null,
    evidenceUrl: null,
    commitmentId: null,
  };
  return buildDraftScreen({
    obligation,
    figures,
    saved: null,
    today: kind === 'iva' ? '2026-11-06' : TODAY,
    canAct: true,
    href: (p) => p,
    tabs: TABS,
  });
}

export function certificatesFixture(): CertificatesScreen {
  const certificates = buildWithholdingCertificates(PURCHASES, { kind: 'renta', year: 2026 });
  return buildCertificatesScreen({
    kind: 'renta',
    year: 2026,
    period: null,
    years: [2024, 2025, 2026],
    certificates,
    records: [],
    suppliers: new Map([
      ['s1', { email: 'facturacion@terpel.example', concept: 'compras' }],
      ['s2', { email: 'cartera@llantas.example', concept: 'compras' }],
      ['s3', { email: null, concept: null }],
      ['s4', { email: 'admin@lasabana.example', concept: 'arrendamiento_inmuebles' }],
    ]),
    canAct: true,
    href: (p) => p,
    tabs: TABS,
  });
}

export function exogenaFixture(): ExogenaScreen {
  const formats = buildExogena({
    year: 2026,
    purchases: PURCHASES,
    sales: SALES,
    receivables: [
      {
        id: 'r1',
        thirdNit: '800111222',
        thirdName: 'Comercial Andina S.A.S.',
        date: '2026-10-06',
        amount: 15_053_500,
        settledAt: null,
      },
      {
        id: 'r2',
        thirdNit: '860025900',
        thirdName: 'Lácteos del Valle S.A.',
        date: '2026-09-11',
        amount: 13_867_000,
        settledAt: null,
      },
    ],
  });
  return {
    year: 2026,
    years: [2024, 2025, 2026],
    versionNote: formats[0]?.versionNote ?? '',
    formats: formats.map((f) => ({
      code: f.code,
      title: f.title,
      rows: f.rows.length,
      total: f.total,
      columns: f.columns,
      preview: f.rows.slice(0, 8),
      missing: f.missing,
      notes: f.notes,
      csvHref: '#',
    })),
    hrefs: { tabs: TABS, self: '/v/impuestos-showcase?vista=exogena' },
  };
}
