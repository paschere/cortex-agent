import type { SupabaseClient } from '@supabase/supabase-js';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import type { ToolContext } from '../../types';

/**
 * A small two-company world, shared by the snapshot test and the isolation test.
 *
 * It is deliberately ADVERSARIAL in the same way `tenancy/__tests__/isolation.
 * test.ts` is: both companies have a truck, a SOAT commitment, a client called
 * the same thing and a pending fine, so a query that lost its workspace filter
 * returns something plausible rather than something empty. A reporting module
 * makes that failure mode worse than usual — a stray row does not appear as a
 * row anybody could notice, it lands inside a total.
 */

export const ACME = 'org-acme';
export const GLOBEX = 'org-globex';

export const ANA = '11111111-1111-4111-8111-111111111111'; // Acme
export const CARLA = '33333333-3333-4333-8333-333333333333'; // Globex

const V_ACME = 'aaaa0000-0000-4000-8000-000000000001';
const V_GLOBEX = 'bbbb0000-0000-4000-8000-000000000001';

/** Fixed so every date in the fixture is a known distance from "today". */
export const TODAY = '2026-08-04';
export const NOW = new Date('2026-08-04T15:18:00.000Z');

function commitment(over: Record<string, unknown>): Record<string, unknown> {
  return {
    detail: null,
    counterparty: null,
    amount_cop: null,
    notice_days: 30,
    state: 'in_force',
    met_at: null,
    met_by: null,
    met_note: null,
    dropped_at: null,
    dropped_reason: null,
    owner_user_id: null,
    escalate_to_user_id: null,
    escalate_after_days: 3,
    source_kind: 'manual',
    source_system: null,
    source_read_at: null,
    source_user_id: null,
    source_document_id: null,
    source_chunk_id: null,
    source_quote: null,
    review_state: 'confirmed',
    confirmed_at: null,
    confirmed_by: null,
    vehicle_id: null,
    recurrence: 'none',
    previous_commitment_id: null,
    calendar_event_id: null,
    calendar_id: null,
    calendar_user_id: null,
    calendar_synced_due_on: null,
    calendar_error: null,
    created_by: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...over,
  };
}

export function fixture(): Tables {
  return {
    users: [
      { id: ANA, organization_id: ACME, email: 'ana@acme.com', name: 'Ana', role: 'org_admin' },
      // Same display name, other company. A missing filter names the wrong
      // person as the source of a date, which is a citation that reads fine.
      {
        id: CARLA,
        organization_id: GLOBEX,
        email: 'ana@globex.com',
        name: 'Ana',
        role: 'org_admin',
      },
    ],

    commitments: [
      commitment({
        id: 'c-acme-1',
        organization_id: ACME,
        title: 'SOAT WGY123',
        kind: 'soat',
        counterparty: 'Servientrega',
        amount_cop: 1_200_000,
        due_on: '2026-08-20',
        source_kind: 'system',
        source_system: 'RUNT',
        source_read_at: '2026-07-30T10:00:00Z',
        vehicle_id: V_ACME,
        series_id: 's-acme-1',
      }),
      commitment({
        id: 'c-acme-2',
        organization_id: ACME,
        title: 'Contrato Servientrega',
        kind: 'contract',
        counterparty: 'Servientrega',
        amount_cop: 8_000_000,
        due_on: '2026-07-15', // already overdue on TODAY
        notice_days: 45,
        source_user_id: ANA,
        series_id: 's-acme-2',
      }),
      commitment({
        id: 'c-acme-3',
        organization_id: ACME,
        title: 'Póliza almacén',
        kind: 'policy',
        counterparty: 'Seguros Bolívar',
        amount_cop: 3_000_000,
        due_on: '2026-12-01',
        source_user_id: ANA,
        series_id: 's-acme-3',
      }),
      // Globex's rows mirror Acme's closely enough that a lost filter looks
      // like a plausible report rather than an obvious bug.
      commitment({
        id: 'c-globex-1',
        organization_id: GLOBEX,
        title: 'SOAT ZZZ999',
        kind: 'soat',
        counterparty: 'Servientrega',
        amount_cop: 999_999_999,
        due_on: '2026-08-21',
        source_kind: 'system',
        source_system: 'RUNT',
        source_read_at: '2026-07-30T10:00:00Z',
        vehicle_id: V_GLOBEX,
        series_id: 's-globex-1',
      }),
      commitment({
        id: 'c-globex-2',
        organization_id: GLOBEX,
        title: 'Contrato Servientrega',
        kind: 'contract',
        counterparty: 'Servientrega',
        amount_cop: 777_777_777,
        due_on: '2026-07-16',
        notice_days: 45,
        source_user_id: CARLA,
        series_id: 's-globex-2',
      }),
    ],

    vehicles: [
      {
        id: V_ACME,
        organization_id: ACME,
        user_id: ANA,
        plate: 'WGY123',
        label: 'Camión rojo',
        brand: 'Chevrolet',
        line: 'NPR',
        model_year: 2019,
        runt_estado: 'ACTIVO',
        soat_expires_at: '2026-08-20',
        rtm_expires_at: '2026-06-30',
        last_runt_sync: '2026-07-30T10:00:00Z',
        total_pending_cop: 480_000,
        last_simit_sync: '2026-07-30T10:05:00Z',
        archived: false,
      },
      {
        id: V_GLOBEX,
        organization_id: GLOBEX,
        user_id: CARLA,
        plate: 'ZZZ999',
        label: 'Camión rojo',
        brand: 'Chevrolet',
        line: 'NPR',
        model_year: 2019,
        runt_estado: 'ACTIVO',
        soat_expires_at: '2026-08-21',
        rtm_expires_at: '2026-07-01',
        last_runt_sync: '2026-07-30T10:00:00Z',
        total_pending_cop: 999_000_000,
        last_simit_sync: '2026-07-30T10:05:00Z',
        archived: false,
      },
    ],

    vehicle_fines: [
      {
        id: 'f-acme-1',
        organization_id: ACME,
        vehicle_id: V_ACME,
        code: 'C14',
        description: 'Exceso de velocidad',
        amount_cop: 480_000,
        issued_at: '2026-05-02T00:00:00Z',
        status: 'PENDING',
        detected_at: '2026-05-10T00:00:00Z',
      },
      {
        id: 'f-globex-1',
        organization_id: GLOBEX,
        vehicle_id: V_GLOBEX,
        code: 'C14',
        description: 'Exceso de velocidad',
        amount_cop: 999_000_000,
        issued_at: '2026-05-02T00:00:00Z',
        status: 'PENDING',
        detected_at: '2026-05-10T00:00:00Z',
      },
    ],

    kb_documents: [
      {
        id: 'd-acme-1',
        organization_id: ACME,
        collection_id: 'k-acme',
        title: 'Tarifas Acme 2026',
        status: 'ready',
        created_at: '2026-07-02T00:00:00Z',
      },
      {
        id: 'd-globex-1',
        organization_id: GLOBEX,
        collection_id: 'k-globex',
        title: 'Tarifas Globex 2026',
        status: 'ready',
        created_at: '2026-07-02T00:00:00Z',
      },
      {
        id: 'd-globex-2',
        organization_id: GLOBEX,
        collection_id: 'k-globex',
        title: 'Otro de Globex',
        status: 'ready',
        created_at: '2026-07-03T00:00:00Z',
      },
    ],

    reports: [],
  };
}

export interface World {
  tables: Tables;
  db(organizationId: string): SupabaseClient;
  ctx(organizationId: string, userId: string): ToolContext;
}

export function world(tables: Tables = fixture()): World {
  const fake = createFakeSupabase(tables);
  return {
    tables,
    db: (organizationId: string) => createOrgScopedClient(fake.client, organizationId),
    ctx: (organizationId: string, userId: string) =>
      ({
        organizationId,
        userId,
        agentId: userId,
        db: createOrgScopedClient(fake.client, organizationId),
        integrations: {
          getAccessToken: async () => ({ token: '', scopes: [] }),
          hasScopes: async () => false,
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      }) as unknown as ToolContext,
  };
}
