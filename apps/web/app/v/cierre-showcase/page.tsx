import type { CloseScreenData } from '@/components/close/types';
import {
  ACCOUNT_ROLE_DEFAULTS,
  ACCOUNT_ROLE_KEYS,
  ACCOUNT_ROLE_LABEL,
  CLOSE_TASKS,
  closeHeadline,
  closeTaskReady,
  evaluateCloseCheck,
} from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { CloseFixture } from './Showcase';

/**
 * EL CIERRE DEL MES CON DATOS INVENTADOS (0192). SÓLO EN DESARROLLO.
 *
 * /cierre pide sesión; aquí se pinta la misma pantalla (components/close) con
 * Transportes Andinos y la revisión automática de verdad (close/shape.ts).
 * Parámetros: `?tab=mes|registrar|cuentas|historial`, `?modo=oscuro`.
 * En producción responde 404.
 */
export const dynamic = 'force-dynamic';

export default async function CierreShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const tabs = ['mes', 'registrar', 'cuentas', 'historial'] as const;
  const tab = tabs.find((t) => t === q.tab) ?? 'mes';
  const period = '2026-09';
  const checks = {
    bankAccounts: [
      { name: 'Bancolombia corriente', lastDate: '2026-09-30' },
      { name: 'Davivienda ahorros', lastDate: '2026-09-15' },
    ],
    bankUnmatched: { count: 2, amount: 3_450_000 },
    payablesAwaiting: 0,
    purchasesToBook: 3,
    receiptsToRegister: 2,
    supplierPaymentsToRegister: 0,
    uncategorized: { count: 0, amount: 0 },
    taxPending: [],
    taxDue: 2,
  };
  const tasks = CLOSE_TASKS.filter(
    (t) => !t.module || ['payables', 'finance', 'taxes'].includes(t.module),
  ).map((def) => {
    const auto = evaluateCloseCheck(def.key, checks, period);
    const status = def.key === 'provisiones' ? ('hecha' as const) : ('pendiente' as const);
    return {
      key: def.key,
      title: def.title(period),
      help: def.help,
      status,
      auto,
      automatic: def.auto,
      ready: closeTaskReady({ key: def.key, status, auto }),
      ownerId: def.key === 'conciliacion' ? 'u-ana' : null,
      evidence:
        def.key === 'provisiones'
          ? 'Causadas arriendo, servicios y prestaciones de septiembre.'
          : null,
      evidenceUrl: null,
      doneBy: null,
      doneAt: null,
      fix: def.fix,
    };
  });
  const done = tasks.filter((t) => t.ready).length;
  const data: CloseScreenData = {
    today: '2026-10-03',
    period,
    periods: ['2026-10', '2026-09', '2026-08', '2026-07'],
    view: {
      period,
      label: 'Septiembre de 2026',
      status: 'en_cierre',
      locked: false,
      closedAt: null,
      closedBy: null,
      overrideUntil: null,
      tasks,
      progress: { done, total: tasks.length },
      pending: tasks.length - done,
      headline: closeHeadline(period, tasks.length - done),
    },
    viewError: null,
    queue: {
      provider: 'siigo',
      providerName: 'Siigo',
      guidance: null,
      items: [
        {
          kind: 'compra',
          sourceId: '00000000-0000-4000-a000-000000000001',
          label: 'Factura FEPA-451 de Papelería El Cóndor',
          date: '2026-09-12',
          amount: 1_190_000,
          currency: 'COP',
          counterparty: 'Papelería El Cóndor',
          status: 'pendiente',
          error: null,
          providerNumber: null,
          updatedAt: null,
        },
        {
          kind: 'compra',
          sourceId: '00000000-0000-4000-a000-000000000002',
          label: 'Factura FE-88 de Transportes Ruta 45',
          date: '2026-09-18',
          amount: 4_760_000,
          currency: 'COP',
          counterparty: 'Transportes Ruta 45',
          status: 'error',
          error:
            'Siigo no aceptó la factura de compra: el cliente no existe en Siigo con ese NIT (créalo en Siigo o corrige el NIT).',
          providerNumber: null,
          updatedAt: null,
        },
        {
          kind: 'recibo',
          sourceId: '00000000-0000-4000-a000-000000000003',
          label: 'Pago de Nexa Logística a la factura FV-1-68',
          date: '2026-09-20',
          amount: 11_900_000,
          currency: 'COP',
          counterparty: 'Nexa Logística',
          status: 'incierta',
          error: 'La conexión con Siigo se cortó mientras se enviaba el recibo de caja.',
          providerNumber: null,
          updatedAt: null,
        },
      ],
      done: [
        {
          kind: 'compra',
          sourceId: '00000000-0000-4000-a000-000000000004',
          label: 'Factura 2201 de EPM',
          date: '2026-09-05',
          amount: 830_000,
          currency: 'COP',
          counterparty: 'EPM',
          status: 'registrada',
          error: null,
          providerNumber: 'FC-2-21',
          updatedAt: null,
        },
      ],
    },
    queueError: null,
    history: [
      {
        period: '2026-09',
        label: 'Septiembre de 2026',
        status: 'en_cierre',
        closedAt: null,
        closedBy: null,
        done: 0,
        total: 0,
      },
      {
        period: '2026-08',
        label: 'Agosto de 2026',
        status: 'cerrado',
        closedAt: '2026-09-04T15:00:00Z',
        closedBy: 'u-1',
        done: 10,
        total: 10,
      },
    ],
    mapping: [
      ...ACCOUNT_ROLE_KEYS.map((k) => ({
        scope: 'rol' as const,
        key: k,
        label: ACCOUNT_ROLE_LABEL[k],
        accountCode: ACCOUNT_ROLE_DEFAULTS[k].code,
        accountName: ACCOUNT_ROLE_DEFAULTS[k].name,
        costCenter: null,
        refs: {},
        custom: false,
      })),
      {
        scope: 'rol',
        key: 'banco:bancolombia corriente',
        label: 'Banco: Bancolombia corriente',
        accountCode: '11100501',
        accountName: 'Bancolombia corriente',
        costCenter: null,
        refs: { siigo: '5638' },
        custom: true,
      },
      {
        scope: 'categoria',
        key: 'arriendo',
        label: 'Arriendo',
        accountCode: '51201001',
        accountName: 'Arriendo oficina',
        costCenter: '235',
        refs: {},
        custom: true,
      },
    ],
    suppliers: [{ id: 's-1', name: 'Papelería El Cóndor' }],
    team: [{ id: 'u-ana', name: 'Ana Gómez' }],
    events: [
      {
        kind: 'tarea',
        who: 'Ana Gómez',
        detail: 'Causaciones y provisiones del mes → hecha',
        at: '2026-10-02T14:00:00Z',
      },
    ],
    canManage: true,
    links: { self: '/v/cierre-showcase', pdf: '#', integrations: '#', approvals: '#', chat: '#' },
    fixHref: Object.fromEntries(CLOSE_TASKS.map((t) => [t.key, '#'])),
  };
  return <CloseFixture dark={q.modo === 'oscuro'} tab={tab} data={data} />;
}
