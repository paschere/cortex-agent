import type { UsageRow } from '@/lib/usage-cost';
import { buildUsageCostData } from '@/lib/usage-cost-view';
import { notFound } from 'next/navigation';
import { UsageFixture } from './Showcase';

/**
 * COSTO DE CORTEX CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * Parámetros: `?dias=7|14|30`, `?vacio=1`, `?modo=oscuro`.
 */
export const dynamic = 'force-dynamic';

const TODAY = '2026-10-05';
const PEOPLE = new Map([
  ['u-ana', 'Ana Gómez'],
  ['u-luis', 'Luis Pardo'],
  ['u-mar', 'María Restrepo'],
]);
const CONVERSATIONS = new Map([
  ['c1', 'Cierre de septiembre: conciliación y causación'],
  ['c2', 'Presupuesto de octubre contra real'],
  ['c3', 'Cartera vencida y cobros de la semana'],
  ['c4', 'Informe para socios del tercer trimestre'],
  ['c5', 'Revisar facturas de proveedores de Zona Franca'],
  ['c6', 'Inventario: mínimos y órdenes de compra'],
  ['c7', 'Nómina de octubre'],
  ['c8', 'Preguntas rápidas'],
  ['c9', 'Impuestos: retenciones de septiembre'],
  ['c10', 'Guías de carga a Medellín'],
  ['c11', 'Conciliación Davivienda'],
]);

function rows(): UsageRow[] {
  const out: UsageRow[] = [];
  const convs = [...CONVERSATIONS.keys()];
  const users = [...PEOPLE.keys()];
  const end = Date.parse(`${TODAY}T17:00:00Z`);
  for (let d = 0; d < 80; d++) {
    const weekday = new Date(end - d * 86_400_000).getUTCDay();
    const turns = weekday === 0 || weekday === 6 ? 2 : 9 + ((d * 7) % 11);
    for (let t = 0; t < turns; t++) {
      const k = (d * 13 + t * 5) % convs.length;
      const heavy = k < 3 ? 3.2 : k < 6 ? 1.6 : 0.7;
      const idx = (d * 3 + t) % 40;
      out.push({
        userId: users[k % users.length] ?? null,
        conversationId: convs[k] ?? null,
        taskId: null,
        surface: idx % 11 === 0 ? 'mcp' : idx % 17 === 0 ? 'google-chat' : 'web',
        source: 'chat',
        model: 'claude-sonnet-5',
        input: Math.round(5_000 * heavy + (idx % 5) * 900),
        cacheRead: Math.round(42_000 * heavy),
        cacheWrite: idx % 6 === 0 ? Math.round(9_000 * heavy) : 0,
        output: Math.round(900 * heavy + (idx % 7) * 180),
        at: new Date(end - d * 86_400_000 - t * 1_700_000).toISOString(),
      });
    }
  }
  // Dos tareas en segundo plano.
  for (const [id, mult] of [
    ['t-informe', 5],
    ['t-conciliacion', 2.4],
  ] as const)
    out.push({
      userId: 'u-ana',
      conversationId: 'c4',
      taskId: id,
      surface: 'task',
      source: 'task',
      model: 'claude-sonnet-5',
      input: 30_000 * mult,
      cacheRead: 400_000 * mult,
      cacheWrite: 60_000 * mult,
      output: 12_000 * mult,
      at: `2026-10-0${id === 't-informe' ? 3 : 4}T15:00:00Z`,
    });
  return out;
}

export default async function UsageShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : '');
  const days = [7, 14, 30].includes(Number(one('dias'))) ? Number(one('dias')) : 30;
  const data = buildUsageCostData(one('vacio') === '1' ? [] : rows(), {
    rate: 4150,
    customRate: true,
    days,
    chartDays: 90,
    today: TODAY,
    userNames: PEOPLE,
    conversationTitles: CONVERSATIONS,
    taskTitles: new Map([
      ['t-informe', 'Informe semanal de ventas y cartera'],
      ['t-conciliacion', 'Conciliar Davivienda de septiembre'],
    ]),
    truncated: false,
    canEditRate: true,
  });
  return <UsageFixture data={data} dark={one('modo') === 'oscuro'} />;
}
