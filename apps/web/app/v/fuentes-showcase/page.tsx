import { AccountingCardsGrid } from '@/app/(app)/integrations/_components/AccountingSection';
import { buildAccountingCards } from '@/lib/accounting/card';
import { buildCatalog } from '@/lib/sources/catalog';
import { type SourcesSnapshot, buildConnectedSources, unreadParts } from '@/lib/sources/overview';
import {
  type AccountingConnectionRow,
  accountingTableSpec,
  getAccountingProvider,
  listAccountingProviders,
} from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { FuentesShowcase } from './Showcase';

/**
 * «DATOS Y CONEXIONES» CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /integrations pide sesión; aquí se pintan los mismos componentes —el
 * resumen de salud, las tarjetas de «Conectado», el catálogo de «Conecta algo
 * nuevo» con la sección de programas contables— con una empresa de mentira
 * que tiene de todo: una carpeta de Drive que perdió el permiso, una hoja al
 * día, Siigo trayendo datos, un extracto viejo, WhatsApp caído.
 *
 * Parámetros: `?modo=oscuro`, `?empresa=vacia` (nada conectado todavía) y
 * `?lectura=caida` (dos lecturas que fallaron). En producción responde 404.
 */
export const dynamic = 'force-dynamic';

const NOW = new Date('2026-10-02T15:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const FULL: SourcesSnapshot = {
  userId: 'yo',
  canManage: true,
  hubspotWorkspace: false,
  integrations: [
    {
      provider: 'google',
      scopes: ['gmail.modify', 'calendar', 'drive.readonly', 'spreadsheets'],
      updated_at: ago(60 * 24 * 12),
      user_id: 'yo',
    },
    { provider: 'hubspot', scopes: [], updated_at: ago(60 * 24 * 40), user_id: 'yo' },
    { provider: 'google', scopes: [], updated_at: ago(60 * 24 * 3), user_id: 'ana' },
  ],
  accounting: [
    {
      id: 'acc-1',
      provider: 'siigo',
      providerName: 'Siigo',
      account_label: 'Transportes Andinos S.A.S.',
      entities: ['customers', 'invoices', 'payments'],
      enabled: true,
      interval_minutes: 60,
      last_run_at: ago(22),
      last_status: 'ok',
      last_error: null,
      last_counts: {
        customers: { inserted: 3, updated: 11 },
        invoices: { inserted: 28, updated: 6 },
        payments: { inserted: 14, updated: 0 },
      },
      created_by: 'ana',
    },
  ],
  drive: [
    {
      id: '00000000-0000-4000-8000-0000000000d1',
      folder_name: 'Guías aéreas — agente de carga',
      tracker_name: 'Guías',
      tracker_slug: 'guias',
      enabled: true,
      interval_minutes: 10,
      last_run_at: ago(95),
      last_status: 'error',
      last_error: 'invalid_grant: Token has been expired or revoked.',
      last_files: 0,
      last_inserted: 0,
      last_updated: 0,
      last_needs_review: 0,
      last_failed: 0,
      created_by: 'yo',
    },
    {
      id: '00000000-0000-4000-8000-0000000000d2',
      folder_name: 'Facturas de proveedores',
      tracker_name: 'Cuentas por pagar',
      tracker_slug: 'cuentas_por_pagar',
      enabled: true,
      interval_minutes: 30,
      last_run_at: ago(8),
      last_status: 'ok',
      last_error: null,
      last_files: 41,
      last_inserted: 6,
      last_updated: 1,
      last_needs_review: 2,
      last_failed: 3,
      created_by: 'luis',
    },
  ],
  tableSyncs: [
    {
      id: '00000000-0000-4000-8000-0000000000s1',
      source_name: 'Despachos 2026 (Google Sheets)',
      source_kind: 'google_sheet',
      tracker_name: 'Despachos',
      tracker_slug: 'despachos',
      enabled: true,
      interval_minutes: 15,
      last_run_at: ago(4),
      last_status: 'ok',
      last_error: null,
      last_inserted: 12,
      last_updated: 37,
      created_by: 'yo',
    },
    {
      id: '00000000-0000-4000-8000-0000000000s2',
      source_name: 'Inventario bodega Funza',
      source_kind: 'google_sheet',
      tracker_name: 'Inventario',
      tracker_slug: 'inventario',
      enabled: false,
      interval_minutes: 60,
      last_run_at: ago(60 * 24 * 6),
      last_status: 'ok',
      last_error: null,
      last_inserted: 0,
      last_updated: 0,
      created_by: 'ana',
    },
  ],
  feedSources: [
    {
      id: '00000000-0000-4000-8000-0000000000f1',
      kind: 'api',
      name: 'ERP · pedidos abiertos',
      enabled: true,
      status: 'error',
      last_checked_at: ago(180),
      error: 'Request failed with status 503 Service Unavailable',
    },
  ],
  bank: [
    {
      account: 'Bancolombia corriente 4410',
      movements: 214,
      unmatched: 9,
      lastImportAt: ago(60 * 24 * 41),
      lastBy: 'ana',
    },
  ],
  whatsapp: {
    status: 'connected',
    lastSeenAt: ago(1),
    groups: 4,
    links: 7,
    mineLinked: false,
  },
  inbox: { count: 12, latestAt: ago(35) },
  people: { ana: 'Ana Restrepo', luis: 'Luis Gómez' },
};

const EMPTY: SourcesSnapshot = {
  ...FULL,
  integrations: [],
  accounting: [],
  drive: [],
  tableSyncs: [],
  feedSources: [],
  bank: [],
  whatsapp: { status: 'disconnected', lastSeenAt: null, groups: 0, links: 0, mineLinked: false },
  inbox: { count: 0, latestAt: null },
};

export default async function FuentesShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const empty = q.empresa === 'vacia';
  const broken = q.lectura === 'caida';
  const snap: SourcesSnapshot = empty
    ? EMPTY
    : broken
      ? { ...FULL, bank: null, tableSyncs: null }
      : FULL;

  const connections: AccountingConnectionRow[] = empty
    ? []
    : [
        {
          id: 'acc-1',
          provider: 'siigo',
          created_by: 'ana',
          account_label: 'Transportes Andinos S.A.S.',
          entities: ['customers', 'invoices', 'payments'],
          trackers: { customers: 't1', invoices: 't2', payments: 't3' },
          cursors: {},
          interval_minutes: 60,
          notify: true,
          enabled: true,
          next_run_at: ago(-38),
          last_run_at: ago(22),
          last_status: 'ok',
          last_error: null,
          last_counts: FULL.accounting?.[0]?.last_counts ?? {},
          created_at: ago(60 * 24 * 30),
          updated_at: ago(22),
        } as unknown as AccountingConnectionRow,
      ];
  const cards = buildAccountingCards(
    listAccountingProviders(),
    connections,
    (provider, entity) =>
      accountingTableSpec(
        getAccountingProvider(provider.id) ?? { id: provider.id, name: provider.name },
        entity,
      ).slug,
    NOW,
  );

  const mine = new Set(
    (snap.integrations ?? []).filter((r) => r.user_id === 'yo').map((r) => r.provider),
  );
  return (
    <FuentesShowcase
      dark={q.modo === 'oscuro'}
      sources={buildConnectedSources(snap, NOW)}
      unread={unreadParts(snap)}
      googleConnected={mine.has('google')}
      catalog={buildCatalog({
        googleConnected: mine.has('google'),
        microsoftConnected: false,
        microsoftConfigured: true,
        hubspot: mine.has('hubspot') ? 'mine' : 'none',
        github: false,
        linear: false,
        whatsapp: snap.whatsapp?.status === 'connected' ? 'on' : 'off',
        bankAccounts: snap.bank?.length ?? 0,
        mcpServers: empty ? 0 : 1,
      })}
      accounting={<AccountingCardsGrid cards={cards} readError={false} />}
    />
  );
}
