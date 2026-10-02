import type { AccountingConnectionRow, AccountingProviderInfo } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { ago, buildAccountingCards, canManageAccounting } from './card';

const siigo: AccountingProviderInfo = {
  id: 'siigo',
  name: 'Siigo',
  available: true,
  credentialsHelp: 'Alianzas → Mi credencial API',
  credentialFields: [
    { key: 'username', label: 'Usuario API', secret: false },
    { key: 'access_key', label: 'Access key', secret: true },
  ],
  entities: ['customers', 'products', 'invoices', 'payments'],
  paymentsLabel: 'Recibos de caja',
  connect: 'credentials',
  setupMissing: null,
};
const alegra: AccountingProviderInfo = {
  id: 'alegra',
  name: 'Alegra',
  available: false,
  credentialsHelp: '',
  credentialFields: [],
  entities: [],
  paymentsLabel: 'Pagos recibidos',
  connect: 'credentials',
  setupMissing: null,
};

const NOW = new Date('2026-10-01T12:00:00Z');

function conn(over: Partial<AccountingConnectionRow> = {}): AccountingConnectionRow {
  return {
    id: 'c1',
    provider: 'siigo',
    created_by: 'u1',
    account_label: 'contabilidad@andina.co',
    entities: ['invoices', 'payments'],
    trackers: { invoices: 't-inv' },
    cursors: {},
    interval_minutes: 60,
    notify: true,
    enabled: true,
    next_run_at: NOW.toISOString(),
    last_run_at: '2026-10-01T11:48:00Z',
    last_status: 'ok',
    last_error: null,
    last_counts: { invoices: { fetched: 10, inserted: 3, updated: 2, unchanged: 5, skipped: 0 } },
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  };
}

const slug = (p: AccountingProviderInfo, e: string) => `${p.id}_${e}`;

describe('la tarjeta de un programa contable', () => {
  it('sólo dueños y administradores conectan', () => {
    expect(canManageAccounting('owner')).toBe(true);
    expect(canManageAccounting('admin')).toBe(true);
    expect(canManageAccounting('member')).toBe(false);
    expect(canManageAccounting(undefined)).toBe(false);
  });

  it('conectado y al día: cuenta, frase, y qué trajo con enlace a la tabla', () => {
    const [card, soon] = buildAccountingCards([siigo, alegra], [conn()], slug, NOW);
    expect(card).toMatchObject({
      connected: true,
      accountLabel: 'contabilidad@andina.co',
      tone: 'ok',
      status: 'Al día · última sincronización hace 12 min.',
      error: null,
    });
    expect(card?.lines).toEqual([
      {
        entity: 'invoices',
        label: 'Facturas de venta',
        text: '3 nuevos, 2 actualizados en la última corrida',
        href: '/trackers/siigo_invoices',
      },
      { entity: 'payments', label: 'Recibos de caja', text: 'Todavía no se ha traído', href: null },
    ]);
    expect(soon).toMatchObject({ connected: false, status: 'Próximamente.', tone: 'idle' });
  });

  it('con error muestra el motivo; en pausa lo dice', () => {
    const [failed] = buildAccountingCards(
      [siigo],
      [
        conn({
          last_status: 'error',
          last_error: 'Siigo no aceptó el usuario API o la access key.',
        }),
      ],
      slug,
      NOW,
    );
    expect(failed).toMatchObject({
      tone: 'error',
      error: 'Siigo no aceptó el usuario API o la access key.',
    });
    const [paused] = buildAccountingCards([siigo], [conn({ enabled: false })], slug, NOW);
    expect(paused?.tone).toBe('paused');
  });

  it('«hace» en palabras', () => {
    expect(ago('2026-10-01T11:59:40Z', NOW)).toBe('hace un momento');
    expect(ago('2026-10-01T09:00:00Z', NOW)).toBe('hace 3 h');
    expect(ago(null, NOW)).toBe('');
  });
});
