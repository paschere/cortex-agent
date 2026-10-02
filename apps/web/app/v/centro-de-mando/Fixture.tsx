'use client';

import { DayJournal } from '@/app/(app)/dashboard/_components/DayJournal';
import {
  ActNowList,
  BrandMark,
  BusinessFacts,
  StatusChip,
} from '@/components/overview/BusinessPieces';
import { FounderOverview } from '@/components/overview/FounderOverview';
import { FounderTabs } from '@/components/overview/FounderTabs';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import {
  type BusinessMap,
  type CompanyBusiness,
  companyStatus,
  rankActionItems,
} from '@/lib/founder-business-shape';
import type { CompanyHealth } from '@/lib/founder-console';
import type { ConsoleRow } from '@/lib/founder-console-shape';
import type { Journal } from '@/lib/journal-shape';
import { Building2, LayoutDashboard } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

/** Un logo inventado (una montaña y un camino), en línea: sin red. */
const LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f766e"/><path d="M8 46 26 20l9 12 6-8 15 22z" fill="#f59e0b"/><path d="M22 54c6-6 14-8 22-8" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/></svg>',
)}`;

const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function health(id: string, patch: Partial<CompanyHealth> = {}): CompanyHealth {
  return {
    organizationId: id,
    status: 'ready',
    createdAt: ago(200),
    planName: 'Equipo',
    subscriptionStatus: 'active',
    seats: { used: 6, maximum: 10, full: false },
    answers: { used: 820, limit: 2000, ratio: 0.41, state: 'ok' },
    members: 6,
    pendingInvitations: 0,
    integrations: 4,
    routines: { active: 5, failedRecently: 0 },
    lastActivityAt: ago(0.05),
    health: { tone: 'emerald', label: 'En orden' },
    ...patch,
  };
}

function row(
  id: string,
  name: string,
  pulse: Partial<ConsoleRow['pulse']>,
  patch: Partial<ConsoleRow> = {},
): ConsoleRow {
  const full = {
    status: 'ready' as const,
    approvals: 0,
    actions: 0,
    deadlines: 0,
    blocked: 0,
    ...pulse,
  };
  return {
    id,
    name,
    kind: 'company',
    role: 'owner',
    active: false,
    owned: true,
    groupId: null,
    pulse: {
      ...full,
      pending: full.approvals + full.actions + (full.deadlines ?? 0) + (full.blocked ?? 0),
    },
    health: health(id),
    ...patch,
  };
}

const ROWS: ConsoleRow[] = [
  row(
    'andinos',
    'Transportes Andinos',
    { approvals: 3, actions: 1, deadlines: 2 },
    {
      groupId: 'logistica',
      active: true,
      health: health('andinos', {
        planName: 'Empresa',
        seats: { used: 12, maximum: 12, full: true },
        members: 12,
        pendingInvitations: 2,
        health: { tone: 'amber', label: 'Asientos llenos' },
      }),
    },
  ),
  row('cargo', 'Andes Cargo', { approvals: 1 }, { groupId: 'logistica' }),
  row(
    'test',
    'Test Logística',
    { deadlines: 1 },
    {
      health: health('test', {
        routines: { active: 6, failedRecently: 4 },
        health: { tone: 'amber', label: 'Rutinas con fallos' },
      }),
    },
  ),
  row(
    'cafe',
    'Café Nube',
    {},
    {
      health: health('cafe', {
        createdAt: ago(1),
        planName: 'Prueba',
        seats: { used: 1, maximum: 3, full: false },
        answers: { used: 12, limit: 200, ratio: 0.06, state: 'ok' },
        members: 1,
        integrations: 0,
        routines: { active: 0, failedRecently: 0 },
        lastActivityAt: ago(0.4),
      }),
    },
  ),
  row(
    'personal:yo',
    'Espacio personal',
    { approvals: 0 },
    {
      kind: 'personal',
      owned: false,
      health: null,
    },
  ),
];

const BLANK_RISK = {
  total: 0,
  receivablesOverdue: 0,
  overdueInvoices: 0,
  paymentsOverdue: 0,
  paymentsDueSoon: 0,
  finesPending: 0,
  others: [],
};

const BUSINESS: BusinessMap = {
  andinos: {
    organizationId: 'andinos',
    risk: {
      ...BLANK_RISK,
      total: 42_700_000,
      receivablesOverdue: 38_500_000,
      overdueInvoices: 7,
      paymentsDueSoon: 4_200_000,
      others: [{ currency: 'USD', amount: 3_400, invoices: 1 }],
    },
    recovered: { month: 12_400_000, monthInvoices: 3, total: 31_800_000, others: [] },
    sales: { month: 1_250_000_000, previous: 1_410_000_000, asOf: ago(0).slice(0, 10) },
    cash: {
      today: 186_400_000,
      runwayWeeks: 5,
      horizonWeeks: 13,
      lowest: { week: '2026-11-09', closing: 22_300_000 },
    },
    ledger: true,
    failing: { routines: 0, syncs: 0, total: 0 },
    setup: { ready: 5, total: 5, percent: 100, next: null },
    oldestDecisionAt: ago(3.2),
    pulseView: true,
    brand: { name: 'Transportes Andinos', color: '#f59e0b', logoUrl: null },
  },
  cargo: {
    organizationId: 'cargo',
    risk: { ...BLANK_RISK, total: 1_200_000, paymentsDueSoon: 1_200_000 },
    recovered: { month: 6_200_000, monthInvoices: 2, total: 18_000_000, others: [] },
    sales: { month: 412_000_000, previous: 380_000_000, asOf: ago(0).slice(0, 10) },
    cash: {
      today: 74_900_000,
      runwayWeeks: null,
      horizonWeeks: 13,
      lowest: { week: '2026-10-19', closing: 61_000_000 },
    },
    ledger: true,
    failing: { routines: 0, syncs: 0, total: 0 },
    setup: { ready: 5, total: 5, percent: 100, next: null },
    oldestDecisionAt: ago(0.2),
    pulseView: true,
    brand: { name: 'Andes Cargo', color: '#0f766e', logoUrl: LOGO },
  },
  test: {
    organizationId: 'test',
    risk: { ...BLANK_RISK },
    recovered: { month: 0, monthInvoices: 0, total: 2_500_000, others: [] },
    sales: null,
    cash: null,
    ledger: false,
    failing: { routines: 2, syncs: 1, total: 3 },
    setup: { ready: 4, total: 5, percent: 80, next: 'Invita a tu equipo' },
    oldestDecisionAt: null,
    pulseView: true,
    brand: null,
  },
  cafe: {
    organizationId: 'cafe',
    risk: { ...BLANK_RISK },
    recovered: { month: 0, monthInvoices: 0, total: 0, others: [] },
    sales: null,
    cash: null,
    ledger: false,
    failing: { routines: 0, syncs: 0, total: 0 },
    setup: { ready: 1, total: 5, percent: 20, next: 'Conecta tu correo' },
    oldestDecisionAt: null,
    pulseView: false,
    brand: { name: 'Café Nube', color: '#7c3aed', logoUrl: null },
  },
};

const GROUPS = [{ id: 'logistica', name: 'Logística' }];

const JOURNAL: Journal = {
  headline: 'Anoche y hoy hice 6 cosas; 2 piden que mires.',
  total: 6,
  attention: 2,
  lingering: [],
  gaps: [],
  days: [
    {
      date: '2026-10-02',
      label: 'Hoy',
      lines: [
        {
          id: 'a',
          at: NOW - 3_600_000,
          clock: '07:00',
          text: 'Avisé de 2 facturas que pasaron los 30 días: Nexa y Frío Sur.',
          kind: 'commitments',
          tone: 'amber',
          href: '/payments',
          attention: true,
        },
        {
          id: 'b',
          at: NOW - 7_200_000,
          clock: '06:30',
          text: 'Dejé redactado el correo de cobro a Nexa por la FE-4471.',
          kind: 'drafts',
          tone: 'primary',
          href: '/approvals',
          attention: true,
        },
        {
          id: 'c',
          at: NOW - 9_000_000,
          clock: '06:00',
          text: 'Revisé 14 vencimientos; ninguno nuevo para hoy.',
          kind: 'commitments',
          tone: 'neutral',
          href: null,
          attention: false,
        },
      ],
    },
    {
      date: '2026-10-01',
      label: 'Ayer',
      lines: [
        {
          id: 'd',
          at: NOW - 60_000_000,
          clock: '18:10',
          text: 'Leí 12 guías nuevas del Drive y las dejé en «Guías».',
          kind: 'routine',
          tone: 'emerald',
          href: null,
          attention: false,
        },
        {
          id: 'e',
          at: NOW - 64_000_000,
          clock: '17:02',
          text: 'Anoté que con Nexa quedaron en 45 días de plazo.',
          kind: 'memory',
          tone: 'neutral',
          href: null,
          attention: false,
        },
      ],
    },
  ],
};

function Detail({ business }: { business: CompanyBusiness }) {
  const now = useMemo(() => new Date(), []);
  const r = ROWS[0] as ConsoleRow;
  const status = companyStatus(r, business, now);
  const items = rankActionItems([{ row: r, business }], { now, limit: 5, perCompany: 5 });
  return (
    <>
      <PageHeader
        title={r.name}
        subtitle="Empresa que fundaste · Plan Empresa · creada el 14 mar 2026"
        icon={<Building2 className="h-5 w-5" />}
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel className="p-5">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <BrandMark name={r.name} brand={business.brand} size="lg" />
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-extrabold text-ink">Cómo va</h2>
              <p className="text-xs text-ink-muted">{status.reasons.join(' · ')}</p>
            </div>
            <StatusChip status={status} />
          </div>
          <BusinessFacts
            business={business}
            decisions={r.pulse.approvals + r.pulse.actions}
            now={now}
            columns="wide"
          />
          <div className="mt-5">
            <h3 className="field-label mb-2">Dónde actuar</h3>
            <ActNowList items={items} loading={false} showCompany={false} />
          </div>
        </Panel>
        <DayJournal journal={JOURNAL} limit={8} />
      </div>
    </>
  );
}

export function MandoFixture({
  dark,
  table,
  loading,
  detail,
  planOpen,
}: {
  dark: boolean;
  table: boolean;
  loading: boolean;
  detail: boolean;
  planOpen: boolean;
}) {
  // Antes de que FounderOverview lea su preferencia guardada (los efectos de
  // los hijos corren primero): la vista la manda la URL del escaparate.
  useState(() => {
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem('cortex:founder-console:view', table ? 'table' : 'grid');
    } catch {
      /* Escaparate: sin almacenamiento da igual. */
    }
    return null;
  });
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  useEffect(() => {
    if (planOpen) document.querySelector('details')?.setAttribute('open', '');
  }, [planOpen]);
  // `?cargando=1`: una promesa que nunca resuelve, para mirar el esqueleto.
  const business = useMemo<Promise<BusinessMap>>(
    () =>
      loading
        ? new Promise<BusinessMap>(() => {})
        : new Promise<BusinessMap>((resolve) => setTimeout(() => resolve(BUSINESS), 250)),
    [loading],
  );

  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-8 md:py-7">
        {detail ? (
          <Detail business={BUSINESS.andinos as CompanyBusiness} />
        ) : (
          <>
            <PageHeader
              title="Centro de mando"
              subtitle="Cómo va cada empresa que diriges y dónde actuar hoy, en una sola vista."
              icon={<LayoutDashboard className="h-5 w-5" />}
            />
            <FounderTabs current="companies" showPeople />
            <FounderOverview
              rows={ROWS}
              unavailable={0}
              groups={GROUPS}
              ownedCount={4}
              ownedLimit={10}
              business={business}
              initialView={table ? 'table' : 'grid'}
            />
          </>
        )}
      </main>
    </div>
  );
}
