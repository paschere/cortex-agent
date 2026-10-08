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
  options: ['payroll'],
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
  options: [],
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
        text: 'Carga inicial pendiente · 3 nuevos, 2 actualizados en la última corrida',
        href: '/trackers/siigo_invoices',
      },
      {
        entity: 'payments',
        label: 'Recibos de caja',
        text: 'Carga inicial pendiente · Todavía no se ha traído',
        href: null,
      },
    ]);
    expect(soon).toMatchObject({ connected: false, status: 'Próximamente.', tone: 'idle' });
  });

  it('la nómina es opcional, no lleva enlace a una tabla y no se activa sola', () => {
    const [off] = buildAccountingCards([siigo], [], slug, NOW);
    expect(off?.entities).not.toContain('payroll');
    const [on] = buildAccountingCards(
      [siigo],
      [
        conn({
          entities: ['invoices', 'payroll'],
          cursors: { payroll: { since: '2026-10-08T00:00:00Z' } },
        }),
      ],
      slug,
      NOW,
    );
    expect(on?.lines.find((l) => l.entity === 'payroll')).toMatchObject({
      href: null,
      text: expect.stringContaining('Carga inicial finalizada'),
    });
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
