import type { MandateGrant } from '../security/mandate';
import type { AutopilotSnapshot } from './collectors';
import type { ToolFacts } from './policy';
import { type AutopilotSettings, DEFAULT_AREA_LEVELS, DEFAULT_SETTINGS } from './settings';

/**
 * Transportes Andinos S.A.S., un martes cualquiera (2026-10-06), para las
 * pruebas del piloto y la vitrina de /v/piloto-showcase.
 */

export const FIXTURE_DAY = '2026-10-06';
/** 07:00 de Bogotá. */
export const FIXTURE_NOW = new Date('2026-10-06T12:00:00Z');

export const OWNER_ID = '11111111-1111-4111-8111-111111111111';
export const LAURA_ID = '22222222-2222-4222-8222-222222222222';
export const ANDRES_ID = '33333333-3333-4333-8333-333333333333';

export function fixtureSnapshot(): AutopilotSnapshot {
  return {
    today: FIXTURE_DAY,
    overdueInvoices: [
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        source: 'document',
        docNumber: 'FE-1043',
        clientId: 'c1',
        counterparty: 'Coltrans S.A.S.',
        currency: 'COP',
        balance: 12_400_000,
        dueOn: '2026-08-20',
        daysOverdue: 47,
        contact: { name: 'Marta Ruiz', email: 'cartera@coltrans.co' },
      },
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        source: 'accounting',
        docNumber: 'FV-88',
        clientId: 'c2',
        counterparty: 'Nexa Logística',
        currency: 'COP',
        balance: 3_150_000,
        dueOn: '2026-09-30',
        daysOverdue: 6,
        contact: null,
      },
    ],
    payments: { overdueAmount: 0, dueSoonAmount: 8_200_000, commitments: 2, finesPending: 0 },
    reconciliation: [
      {
        paymentId: 'bbbbbbbb-0000-4000-8000-000000000001',
        date: '2026-10-05',
        amount: 4_500_000,
        currency: 'COP',
        description: 'TRANSF NEXA FV-77',
        client: 'Nexa Logística',
        reason: 'Muy probable: mismo valor y número de factura FV-77. Confírmalo.',
        suggestions: [
          {
            kind: 'accounting',
            id: 'dddddddd-0000-4000-8000-000000000077',
            docNumber: 'FV-77',
            clientName: 'Nexa Logística',
            exact: true,
            reasons: ['mismo valor', 'número de factura FV-77'],
          },
        ],
      },
      {
        paymentId: 'bbbbbbbb-0000-4000-8000-000000000002',
        date: '2026-10-05',
        amount: 900_000,
        currency: 'COP',
        description: 'CONSIGNACION',
        client: null,
        reason: 'Dos facturas abiertas por un valor parecido.',
        suggestions: [
          {
            kind: 'document',
            id: 'dddddddd-0000-4000-8000-000000000010',
            docNumber: 'FE-1010',
            clientName: 'Coltrans S.A.S.',
            exact: false,
            reasons: ['valor parecido'],
          },
        ],
      },
    ],
    uncategorized: { count: 14, amount: 6_300_000, currency: 'COP' },
    syncs: [
      {
        kind: 'drive_folder',
        id: 'eeeeeeee-0000-4000-8000-000000000001',
        name: 'Facturas de proveedores',
        lastRunAt: '2026-10-06T09:10:00Z',
        lastError: 'Drive respondió 503',
      },
    ],
    commitments: [
      {
        id: 'ffffffff-0000-4000-8000-000000000001',
        title: 'SOAT camión TKL-482',
        kind: 'soat',
        counterparty: null,
        amountCop: 1_150_000,
        dueOn: '2026-10-08',
        ownerUserId: LAURA_ID,
        ownerName: 'Laura Gómez',
      },
      {
        id: 'ffffffff-0000-4000-8000-000000000002',
        title: 'Renovar póliza de carga',
        kind: 'policy',
        counterparty: 'Sura',
        amountCop: null,
        dueOn: '2026-10-01',
        ownerUserId: ANDRES_ID,
        ownerName: 'Andrés Mejía',
      },
    ],
    signals: [
      {
        kind: 'overloaded',
        personId: LAURA_ID,
        workType: 'despacho',
        severity: 'warn',
        message:
          'Laura Gómez tiene 12 despachos abiertos, 4 vencidos; la mediana del equipo en despachos es 5.',
        evidence: {
          person: 'Laura Gómez',
          workType: 'despacho',
          openNow: 12,
          overdueNow: 4,
          teamMedianOpen: 5,
          reassign: 4,
          receiver1: 'Andrés Mejía',
          receiver1Open: 3,
          receiver1Take: 4,
        },
        suggestion: 'Reasignar 4 a Andrés Mejía (tiene 3 despachos pendientes).',
        itemIds: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'],
      },
    ],
    staleApprovals: [
      {
        id: 'abababab-0000-4000-8000-000000000001',
        userId: OWNER_ID,
        ownerName: 'Mateo Ángel',
        kindLabel: 'Cobro de cartera',
        recipient: 'pagos@nexa.co',
        subject: 'Cartera pendiente — FV-61',
        createdAt: '2026-10-02T14:00:00Z',
        expiresAt: '2026-10-09T14:00:00Z',
      },
    ],
    cash: {
      currency: 'COP',
      alerts: [
        {
          kind: 'low_cash',
          week: '2026-10-19',
          severity: 'warn',
          message: 'La caja baja del mínimo que fijaste ($ 30.000.000).',
        },
        { kind: 'late_payer', severity: 'info', message: 'Nexa paga en promedio 18 días tarde.' },
      ],
      lowestWeek: '2026-10-19',
      lowestClosing: 21_700_000,
    },
  };
}

export function fixtureSettings(over: Partial<AutopilotSettings> = {}): AutopilotSettings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    actorUserId: OWNER_ID,
    areaLevels: { ...DEFAULT_AREA_LEVELS },
    ...over,
  };
}

/** Lo que el registro sabe de las herramientas que proponen los recolectores. */
export const FIXTURE_TOOLS: Record<string, ToolFacts> = {
  'gmail.send_message': { id: 'gmail.send_message', requiresConfirmation: true },
  'outlook.send_draft': { id: 'outlook.send_draft', requiresConfirmation: true },
  'payments.apply_to_invoice': { id: 'payments.apply_to_invoice', requiresConfirmation: true },
  'ledger.categorize_pending': { id: 'ledger.categorize_pending' },
  'trackers.retry_sync': { id: 'trackers.retry_sync' },
  'accounting.sync_now': { id: 'accounting.sync_now', requiresConfirmation: true },
  'autopilot.remind': { id: 'autopilot.remind' },
  'work.assign': { id: 'work.assign', requiresConfirmation: true },
  'payments.pay': { id: 'payments.pay', requiresConfirmation: true },
};

export const fixtureTool = (id: string): ToolFacts | undefined => FIXTURE_TOOLS[id];

export function mandate(over: Partial<MandateGrant> = {}): MandateGrant {
  return {
    id: '99999999-0000-4000-8000-000000000001',
    label: 'Correos de cobro',
    toolPatterns: ['gmail.send_message'],
    coveredToolIds: ['gmail.send_message'],
    maxRiskLevel: 'high',
    amountCeiling: null,
    currency: null,
    appliesUnattended: false,
    maxUsesPerDay: null,
    usesToday: 0,
    ...over,
  };
}
