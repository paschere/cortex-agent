import 'server-only';
import type { GridView } from '@/components/datagrid/types';
import { clientColumns, clientGridRow, clientPresets, tagsInUse } from '@/lib/clients/grid';
import type {
  AccountingConflictView,
  BacklogView,
  Client360View,
  DuplicateView,
  Piece,
  ProposalGroupView,
  TeamMember,
} from '@/lib/clients/types';
import { client360View } from '@/lib/clients/view360';
import {
  type AccountingInvoiceIn,
  type Client360,
  type ClientRow,
  type CommitmentIn,
  type ContactIn,
  type DocumentInvoiceIn,
  type LedgerIn,
  type ListClientIn,
  type PaymentIn,
  type TimelineItem,
  assembleClientRows,
  clientHealth,
  fullNit,
  invoicesByClient,
  moneyOf,
} from '@cortex/agent-tools';

/**
 * CLIENTES CON DATOS INVENTADOS, CALCULADOS CON EL MOTOR DE VERDAD.
 *
 * Transportes del Valle (la empresa de prueba de Finanzas) y sus clientes:
 * Nexa Logística (debe y está atrasada), Coltrans (al día, paga rápido),
 * Agroandes (cartera muy vencida), Ferretería El Tornillo (callada, debe),
 * Café Montaña (sin movimiento) y dos más. Las filas crudas pasan por
 * `assembleClientRows` / `moneyOf` / `clientHealth`: la misma cuenta que hace
 * /clients con la base de verdad.
 */

export const TODAY = '2026-10-02';
const T = (days: number) => {
  const t = Date.parse(`${TODAY}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

export const TEAM: TeamMember[] = [
  { id: 'u-ana', name: 'Ana Restrepo' },
  { id: 'u-juan', name: 'Juan Ospina' },
  { id: 'u-sofia', name: 'Sofía Mejía' },
];

const C = {
  nexa: 'c0000000-0000-4000-8000-000000000001',
  coltrans: 'c0000000-0000-4000-8000-000000000002',
  agro: 'c0000000-0000-4000-8000-000000000003',
  tornillo: 'c0000000-0000-4000-8000-000000000004',
  cafe: 'c0000000-0000-4000-8000-000000000005',
  andina: 'c0000000-0000-4000-8000-000000000006',
  pacifico: 'c0000000-0000-4000-8000-000000000007',
};

const CLIENTS: Array<ListClientIn & Partial<ClientRow>> = [
  {
    id: C.nexa,
    name: 'Nexa Logística',
    legal_name: 'NEXA LOGISTICA S.A.S.',
    tax_id: '900431212',
    status: 'active',
    owner_user_id: 'u-ana',
    owner_name: 'Ana Restrepo',
    tags: ['Clave', 'Bogotá'],
    source: 'accounting',
    city: 'Bogotá',
    updated_at: `${TODAY}T08:00:00Z`,
  },
  {
    id: C.coltrans,
    name: 'Coltrans',
    legal_name: 'Colombiana de Transportes S.A.S.',
    tax_id: '890903938',
    status: 'active',
    owner_user_id: 'u-juan',
    owner_name: 'Juan Ospina',
    tags: ['Clave'],
    source: 'manual',
    city: 'Medellín',
    updated_at: `${TODAY}T08:00:00Z`,
  },
  {
    id: C.agro,
    name: 'Agroandes',
    legal_name: 'AGROANDES LTDA',
    tax_id: '811022334',
    status: 'active',
    owner_user_id: 'u-sofia',
    owner_name: 'Sofía Mejía',
    tags: ['Cobro jurídico'],
    source: 'accounting',
    city: 'Rionegro',
    updated_at: `${TODAY}T08:00:00Z`,
  },
  {
    id: C.tornillo,
    name: 'Ferretería El Tornillo',
    legal_name: null,
    tax_id: '79854123',
    status: 'active',
    owner_user_id: null,
    owner_name: null,
    tags: [],
    source: 'accounting',
    city: 'Cali',
    updated_at: `${TODAY}T08:00:00Z`,
  },
  {
    id: C.cafe,
    name: 'Café Montaña',
    legal_name: null,
    tax_id: null,
    status: 'dormant',
    owner_user_id: 'u-juan',
    owner_name: 'Juan Ospina',
    tags: [],
    source: 'manual',
    city: 'Manizales',
    updated_at: `${TODAY}T08:00:00Z`,
  },
  {
    id: C.andina,
    name: 'Distribuidora Andina',
    legal_name: 'DISTRIBUIDORA ANDINA S.A.',
    tax_id: '860001022',
    status: 'active',
    owner_user_id: 'u-ana',
    owner_name: 'Ana Restrepo',
    tags: ['Bogotá'],
    source: 'accounting',
    city: 'Bogotá',
    updated_at: `${TODAY}T08:00:00Z`,
  },
  {
    id: C.pacifico,
    name: 'Puerto Pacífico',
    legal_name: null,
    tax_id: '900777001',
    status: 'prospect',
    owner_user_id: 'u-sofia',
    owner_name: 'Sofía Mejía',
    tags: ['Nuevo'],
    source: 'chat',
    city: 'Buenaventura',
    updated_at: `${TODAY}T08:00:00Z`,
  },
];

let seq = 0;
const id = (p: string) => {
  seq += 1;
  return `${p}-${seq}`;
};

function inv(
  client: string,
  doc: string,
  total: number,
  balance: number,
  issued: number,
  due: number | null,
): AccountingInvoiceIn {
  return {
    id: id('acc'),
    client_id: client,
    doc_number: doc,
    currency: 'COP',
    total,
    balance,
    issued_on: T(issued),
    due_on: due === null ? null : T(due),
    annulled: false,
    source_system: 'Siigo',
    public_url: null,
  };
}

const ACCOUNTING: AccountingInvoiceIn[] = [
  // Nexa: factura grande, una vencida hace 47 días y otra al día.
  inv(C.nexa, 'FV-1180', 18_400_000, 0, -200, -170),
  inv(C.nexa, 'FV-1204', 12_900_000, 0, -140, -110),
  inv(C.nexa, 'FV-1236', 9_850_000, 4_200_000, -77, -47),
  inv(C.nexa, 'FV-1261', 14_300_000, 14_300_000, -20, 10),
  inv(C.nexa, 'FV-1270', 6_100_000, 6_100_000, -5, 25),
  // Coltrans: todo pagado rápido, una abierta al día.
  inv(C.coltrans, 'FV-1190', 22_000_000, 0, -180, -150),
  inv(C.coltrans, 'FV-1220', 19_500_000, 0, -110, -80),
  inv(C.coltrans, 'FV-1250', 21_300_000, 0, -50, -20),
  inv(C.coltrans, 'FV-1275', 23_800_000, 23_800_000, -3, 27),
  // Agroandes: muy vencida.
  inv(C.agro, 'FV-1101', 31_000_000, 31_000_000, -160, -130),
  inv(C.agro, 'FV-1150', 8_400_000, 8_400_000, -100, -70),
  // El Tornillo: debe poquito, al día, pero nadie habla con ellos.
  inv(C.tornillo, 'FV-1240', 2_350_000, 2_350_000, -25, 5),
  // Andina: al día.
  inv(C.andina, 'FV-1210', 15_200_000, 0, -120, -90),
  inv(C.andina, 'FV-1265', 16_900_000, 0, -15, 15),
];

const DOCUMENTS: DocumentInvoiceIn[] = [
  {
    id: id('doc'),
    client_id: C.andina,
    doc_number: 'FE-88',
    currency: 'USD',
    total_amount: 4_500,
    issued_on: T(-40),
    due_on: T(-10),
  },
];

const PAYMENTS: PaymentIn[] = [
  {
    id: id('pay'),
    client_id: C.nexa,
    extraction_id: null,
    invoice_number: 'FV-1180',
    amount: 18_400_000,
    currency: 'COP',
    paid_on: T(-152),
    kind: 'payment',
  },
  {
    id: id('pay'),
    client_id: C.nexa,
    extraction_id: null,
    invoice_number: 'FV-1204',
    amount: 12_900_000,
    currency: 'COP',
    paid_on: T(-82),
    kind: 'payment',
  },
  {
    id: id('pay'),
    client_id: C.nexa,
    extraction_id: null,
    invoice_number: 'FV-1236',
    amount: 5_650_000,
    currency: 'COP',
    paid_on: T(-12),
    kind: 'payment',
  },
  {
    id: id('pay'),
    client_id: C.coltrans,
    extraction_id: null,
    invoice_number: 'FV-1190',
    amount: 22_000_000,
    currency: 'COP',
    paid_on: T(-158),
    kind: 'payment',
  },
  {
    id: id('pay'),
    client_id: C.coltrans,
    extraction_id: null,
    invoice_number: 'FV-1220',
    amount: 19_500_000,
    currency: 'COP',
    paid_on: T(-88),
    kind: 'payment',
  },
  {
    id: id('pay'),
    client_id: C.coltrans,
    extraction_id: null,
    invoice_number: 'FV-1250',
    amount: 21_300_000,
    currency: 'COP',
    paid_on: T(-26),
    kind: 'payment',
  },
  {
    id: id('pay'),
    client_id: C.andina,
    extraction_id: null,
    invoice_number: 'FV-1210',
    amount: 15_200_000,
    currency: 'COP',
    paid_on: T(-60),
    kind: 'payment',
  },
  {
    id: id('pay'),
    client_id: C.andina,
    extraction_id: null,
    invoice_number: 'FV-1265',
    amount: 16_900_000,
    currency: 'COP',
    paid_on: T(-2),
    kind: 'payment',
  },
];

const LEDGER: LedgerIn[] = [];

const CONTACTS: ContactIn[] = [
  { client_id: C.nexa, at: `${T(-3)}T15:20:00Z`, kind: 'email' },
  { client_id: C.coltrans, at: `${T(-1)}T10:00:00Z`, kind: 'meeting' },
  { client_id: C.agro, at: `${T(-9)}T12:00:00Z`, kind: 'action' },
  { client_id: C.tornillo, at: `${T(-64)}T12:00:00Z`, kind: 'whatsapp' },
  { client_id: C.cafe, at: `${T(-140)}T12:00:00Z`, kind: 'note' },
  { client_id: C.andina, at: `${T(-18)}T12:00:00Z`, kind: 'email' },
];

const COMMITMENTS: CommitmentIn[] = [
  {
    client_id: C.nexa,
    due_on: T(4),
    state: 'due_soon',
    title: 'Renovar contrato de transporte 2027',
    amount_cop: null,
  },
  {
    client_id: C.pacifico,
    due_on: T(8),
    state: 'in_force',
    title: 'Enviar propuesta de bodegaje',
    amount_cop: null,
  },
];

export function fixtureList(opts: { failing: boolean; empty: boolean }) {
  const clients = opts.empty ? [] : CLIENTS;
  const rows = assembleClientRows(
    clients,
    {
      accountingInvoices: opts.failing ? undefined : ACCOUNTING,
      documentInvoices: opts.failing ? undefined : DOCUMENTS,
      payments: opts.failing ? undefined : PAYMENTS,
      ledger: LEDGER,
      contacts: CONTACTS,
      commitments: COMMITMENTS,
    },
    TODAY,
  );
  const savedViews: GridView[] = [
    {
      id: 'v-ana',
      name: 'Cartera de Ana',
      filters: [{ key: 'responsable', op: 'eq', value: 'u-ana' }],
      sort: [{ key: 'vencido', dir: 'desc' }],
      hidden: [],
      layout: 'table',
      shared: true,
      canManage: true,
    },
  ];
  return {
    columns: clientColumns(TEAM, tagsInUse(rows)),
    rows: rows.map(clientGridRow),
    presets: clientPresets('u-ana'),
    savedViews,
    missing: opts.failing
      ? ['facturas del programa contable', 'facturas confirmadas', 'pagos']
      : [],
    pending: opts.empty ? 0 : 61,
  };
}

// ---------------------------------------------------------------------------
// La ficha de Nexa
// ---------------------------------------------------------------------------

export function fixture360(opts: { failing: boolean }): Client360View {
  const client = CLIENTS[0] as ListClientIn & Partial<ClientRow>;
  const invoices =
    invoicesByClient(
      { accountingInvoices: ACCOUNTING, documentInvoices: DOCUMENTS, payments: PAYMENTS },
      TODAY,
    ).get(C.nexa) ?? [];
  const money = moneyOf(
    invoices,
    PAYMENTS.filter((p) => p.client_id === C.nexa),
    [],
    TODAY,
  );
  const lastContactAt = `${T(-3)}T15:20:00Z`;
  const fail = <X>(data: X, error: string): { ok: true; data: X } | { ok: false; error: string } =>
    opts.failing ? { ok: false, error } : { ok: true, data };

  const timeline: TimelineItem[] = [
    {
      id: 't1',
      kind: 'commitment',
      at: T(4),
      title: 'Renovar contrato de transporte 2027',
      detail: null,
      tone: 'amber',
      href: '/commitments',
    },
    {
      id: 't2',
      kind: 'invoice',
      at: T(-5),
      title: 'Factura FV-1270 por $6.100.000',
      detail: `Debe $6.100.000, vence ${T(25)}`,
      by: 'Siigo',
      tone: 'amber',
    },
    {
      id: 't3',
      kind: 'email',
      at: `${T(-3)}T15:20:00Z`,
      title: 'Re: Programación de despachos octubre',
      detail: '6 mensajes',
      by: 'Gmail',
    },
    {
      id: 't4',
      kind: 'whatsapp',
      at: `${T(-4)}T21:02:00Z`,
      title: 'Carlos Pérez en Operación Nexa – TDV',
      detail: 'Mañana sale el camión a Funza a las 6, ¿confirmamos muelle 3?',
    },
    {
      id: 't5',
      kind: 'action',
      at: `${T(-9)}T13:10:00Z`,
      title: 'Cobro: Recordatorio factura FV-1236',
      detail: 'Enviado a pagos@nexa.co',
      tone: 'primary',
      href: '/actions',
    },
    {
      id: 't6',
      kind: 'payment',
      at: T(-12),
      title: 'Pago de $5.650.000',
      detail: 'Factura FV-1236',
      tone: 'emerald',
    },
    {
      id: 't7',
      kind: 'meeting',
      at: `${T(-16)}T14:00:00Z`,
      title: 'Revisión trimestral con Nexa',
      detail: 'Asistió Carlos Pérez',
    },
    {
      id: 't8',
      kind: 'note',
      at: `${T(-18)}T16:40:00Z`,
      title:
        'Llamé a Carlos: pagan el saldo de la FV-1236 cuando les entre el anticipo de su cliente.',
    },
    {
      id: 't9',
      kind: 'invoice',
      at: T(-20),
      title: 'Factura FV-1261 por $14.300.000',
      detail: `Debe $14.300.000, vence ${T(10)}`,
      by: 'Siigo',
      tone: 'amber',
    },
    {
      id: 't10',
      kind: 'case',
      at: T(-30),
      title: 'Recuperar cartera Nexa septiembre',
      detail: 'Cobro de su factura FV-1236',
      href: '/management',
    },
    {
      id: 't11',
      kind: 'invoice',
      at: T(-77),
      title: 'Factura FV-1236 por $9.850.000',
      detail: 'Debe $4.200.000, vencida hace 47 días',
      by: 'Siigo',
      tone: 'rose',
    },
    {
      id: 't12',
      kind: 'payment',
      at: T(-82),
      title: 'Pago de $12.900.000',
      detail: 'Factura FV-1204',
      tone: 'emerald',
    },
    {
      id: 't13',
      kind: 'document',
      at: T(-95),
      title: 'Contrato marco de transporte Nexa 2026.pdf',
      detail: 'NIT 900.431.212-6',
    },
    {
      id: 't14',
      kind: 'invoice',
      at: T(-140),
      title: 'Factura FV-1204 por $12.900.000',
      detail: 'Pagada',
      by: 'Siigo',
      tone: 'emerald',
    },
  ];

  const hub: Client360 = {
    client: {
      id: C.nexa,
      organization_id: 'org',
      name: client.name,
      legal_name: client.legal_name,
      tax_id: client.tax_id,
      tax_id_dv: null,
      name_key: null,
      status: 'active',
      city: 'Bogotá',
      department: 'Cundinamarca',
      address: null,
      phone: '+57 601 744 1200',
      website: 'nexa.co',
      services: ['carga'],
      customs_role: null,
      payment_terms_days: 30,
      credit_limit_cop: 60_000_000,
      owner_user_id: 'u-ana',
      owner_name: 'Ana Restrepo',
      since: '2023-02-01',
      notes: null,
      tags: ['Clave', 'Bogotá'],
      source: 'accounting',
      source_detail: 'Creado desde Siigo',
      created_by: null,
      created_at: '2026-01-10T00:00:00Z',
      updated_at: `${TODAY}T08:00:00Z`,
    },
    nit: fullNit(client.tax_id),
    contacts: [
      {
        id: 'k1',
        organization_id: 'org',
        client_id: C.nexa,
        full_name: 'Carlos Pérez',
        email: 'carlos.perez@nexa.co',
        phone: '+57 310 555 0101',
        role_title: 'Jefe de operaciones',
        is_primary: true,
        status: 'active',
        source: 'manual',
        source_detail: null,
        first_seen_at: null,
        last_seen_at: `${T(-3)}T15:20:00Z`,
        notes: null,
        created_by: 'u-ana',
        created_at: '2026-01-10T00:00:00Z',
        updated_at: '2026-01-10T00:00:00Z',
      },
      {
        id: 'k2',
        organization_id: 'org',
        client_id: C.nexa,
        full_name: 'Paola Gómez',
        email: 'pagos@nexa.co',
        phone: null,
        role_title: 'Tesorería',
        is_primary: false,
        status: 'active',
        source: 'email',
        source_detail: null,
        first_seen_at: null,
        last_seen_at: `${T(-9)}T13:10:00Z`,
        notes: null,
        created_by: null,
        created_at: '2026-02-10T00:00:00Z',
        updated_at: '2026-02-10T00:00:00Z',
      },
    ],
    domains: [
      {
        id: 'd1',
        organization_id: 'org',
        client_id: C.nexa,
        domain: 'nexa.co',
        verified_by: 'u-ana',
        verified_at: '2026-01-10T00:00:00Z',
        note: null,
        created_at: '2026-01-10T00:00:00Z',
      },
    ],
    aliases: [
      {
        id: 'a1',
        client_id: C.nexa,
        alias: 'NEXA LOGISTICA SAS BOGOTA',
        alias_key: null,
        source: 'confirmation',
        verified_by: 'u-ana',
        verified_at: '2026-08-01T00:00:00Z',
        created_at: '2026-08-01T00:00:00Z',
      },
      {
        id: 'a2',
        client_id: C.nexa,
        alias: 'Nexa Log.',
        alias_key: null,
        source: 'merge',
        verified_by: 'u-ana',
        verified_at: '2026-06-01T00:00:00Z',
        created_at: '2026-06-01T00:00:00Z',
      },
    ],
    money: fail(money, 'No pude leer las facturas o los pagos.'),
    recovered: fail(
      { total: 5_650_000, invoices: 1, lastOn: T(-12) },
      'No pude calcular lo recuperado.',
    ),
    expected: fail(
      [
        {
          expectedDate: T(14),
          amount: 14_300_000,
          expectedAmount: 12_900_000,
          probability: 0.9,
          label: 'FV-1261',
          reason: 'Vence el 12 oct; Nexa suele pagar 4 días tarde.',
        },
        {
          expectedDate: T(29),
          amount: 6_100_000,
          expectedAmount: 5_500_000,
          probability: 0.9,
          label: 'FV-1270',
          reason: 'Vence el 27 oct.',
        },
      ],
      'No pude leer la proyección de caja.',
    ),
    health: clientHealth({
      status: 'active',
      money: opts.failing ? null : money,
      lastContactAt,
      today: TODAY,
    }),
    lastContactAt,
    timeline: fail(timeline, 'No pude armar la línea de tiempo.'),
    open: {
      invoices: fail(money.open, 'No pude leer las facturas.'),
      commitments: {
        ok: true,
        data: [
          {
            id: 'cm1',
            title: 'Renovar contrato de transporte 2027',
            kind: 'contract',
            dueOn: T(4),
            state: 'due_soon',
            daysLeft: 4,
            amountCop: null,
          },
        ],
      },
      cases: fail(
        [
          {
            id: 'cs1',
            title: 'Recuperar cartera Nexa septiembre',
            state: 'working',
            dueOn: T(6),
            nextAction: 'Llamar a tesorería el lunes',
            why: 'Cobro de su factura FV-1236',
          },
        ],
        'No pude leer los casos.',
      ),
      work: {
        ok: true,
        data: [
          {
            id: 'w1',
            title: 'Conciliar despachos de septiembre con Nexa',
            assignee: 'Juan Ospina',
            dueOn: T(3),
            workType: 'tarea',
          },
        ],
      },
    },
    documents: fail(
      [
        {
          id: 'doc1',
          title: 'Contrato marco de transporte Nexa 2026.pdf',
          at: T(-95),
          kind: 'document',
          href: null,
        },
        {
          id: 'doc2',
          title: 'RUT Nexa Logística 2026.pdf',
          at: T(-260),
          kind: 'document',
          href: null,
        },
      ],
      'No pude leer los documentos.',
    ),
    proposals: 3,
  };
  return client360View(hub, TODAY);
}

// ---------------------------------------------------------------------------
// «Por confirmar»
// ---------------------------------------------------------------------------

export function fixtureReview(opts: { failing: boolean }): {
  groups: Piece<ProposalGroupView[]>;
  duplicates: Piece<DuplicateView[]>;
  backlog: Piece<BacklogView[]>;
  conflicts: Piece<AccountingConflictView[]>;
} {
  return {
    groups: opts.failing
      ? { ok: false, error: 'No pude leer las propuestas.' }
      : {
          ok: true,
          data: [
            {
              key: 'g1',
              ids: Array.from({ length: 47 }, (_, i) => `l${i}`),
              clientId: C.coltrans,
              clientName: 'Coltrans',
              kindLabel: 'Movimiento de plata',
              methodLabel: 'Nombre exacto',
              why: 'El nombre del cliente aparece completo.',
              evidence: 'COLTRANS SAS',
              count: 47,
              samples: [
                { label: 'TRANSF COLTRANS SAS NIT 890903938', date: '30 sep 2026' },
                { label: 'TRANSF COLTRANS SAS', date: '12 sep 2026' },
                { label: 'ABONO COLTRANS SAS FV-1250', date: '6 sep 2026' },
              ],
              rivals: [],
              canLearnAlias: true,
            },
            {
              key: 'g2',
              ids: ['m1', 'm2'],
              clientId: C.nexa,
              clientName: 'Nexa Logística',
              kindLabel: 'Reunión',
              methodLabel: 'Nombre de un contacto',
              why: 'Aparece el nombre de una persona de este cliente, pero puede ser otra con el mismo nombre.',
              evidence: 'Asistió Carlos Pérez',
              count: 2,
              samples: [
                { label: 'Revisión de rutas Q4', date: '24 sep 2026' },
                { label: 'Comité de operación', date: '3 sep 2026' },
              ],
              rivals: [],
              canLearnAlias: false,
            },
            {
              key: 'g3',
              ids: ['w1'],
              clientId: C.andina,
              clientName: 'Distribuidora Andina',
              kindLabel: 'Grupo de WhatsApp',
              methodLabel: 'Nombre parecido',
              why: 'Hay un parecido en el nombre, pero no es exacto.',
              evidence: 'Andina – despachos',
              count: 1,
              samples: [{ label: 'Andina – despachos', date: '1 oct 2026' }],
              rivals: ['Andina Cargo'],
              canLearnAlias: false,
            },
          ],
        },
    duplicates: {
      ok: true,
      data: [
        {
          keep: { id: C.coltrans, name: 'Coltrans', nit: '890.903.938-8' },
          merge: { id: 'dup', name: 'COLTRANS S.A.S.', nit: null },
          why: 'Se escriben igual sin tildes ni S.A.S.',
        },
      ],
    },
    backlog: {
      ok: true,
      data: [
        {
          counterparty: 'Nexa',
          count: 3,
          candidates: [{ id: C.nexa, name: 'Nexa Logística', why: 'coincide el nombre' }],
        },
        { counterparty: 'DIAN', count: 5, candidates: [] },
      ],
    },
    conflicts: { ok: true, data: [{ name: 'Café Montaña', nit: '901234567', system: 'Siigo' }] },
  };
}
