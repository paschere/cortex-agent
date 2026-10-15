import type { UsageCostData } from '@/components/admin/UsageCostSection';
import {
  type UsageRow,
  bogotaDay,
  costByConversation,
  costByDay,
  costBySurface,
  costByTask,
  costByUser,
  sumUsage,
  usdToCop,
} from '@/lib/usage-cost';

/**
 * Del consumo registrado a lo que pinta /admin/usage (0228). Pura: recibe las
 * filas ya leídas y los nombres, y devuelve todo en pesos. `rows` trae más días
 * que la ventana (para el rango de 30/90 días y la comparación del gráfico);
 * las listas y los totales sólo cuentan la ventana.
 */

export const SURFACE_NAME: Record<string, string> = {
  web: 'App web',
  mcp: 'Claude / ChatGPT conectados',
  schedule: 'Rutinas',
  task: 'Tareas en segundo plano',
  'google-chat': 'Google Chat',
  whatsapp: 'WhatsApp',
  voice: 'Voz',
};

export function buildUsageCostData(
  rows: readonly UsageRow[],
  ctx: {
    rate: number;
    customRate: boolean;
    days: number;
    /** Días de historia para el gráfico (≥ days). */
    chartDays: number;
    today: string;
    userNames: ReadonlyMap<string, string>;
    conversationTitles: ReadonlyMap<string, string>;
    taskTitles: ReadonlyMap<string, string>;
    truncated: boolean;
    canEditRate: boolean;
  },
): UsageCostData {
  const first = new Date(Date.parse(`${ctx.today}T00:00:00Z`) - (ctx.days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const inWindow = rows.filter((r) => bogotaDay(r.at) >= first);
  const total = sumUsage(inWindow);
  const cop = (usd: number) => usdToCop(usd, ctx.rate);
  const conversations = costByConversation(inWindow);
  return {
    rate: ctx.rate,
    customRate: ctx.customRate,
    days: ctx.days,
    today: ctx.today,
    totals: {
      cop: cop(total.usd),
      tokens: total.tokens,
      turns: total.turns,
      unpriced: total.unpriced,
      conversations: conversations.length,
    },
    daily: costByDay(rows, ctx.chartDays, ctx.today).map((d) => ({
      date: d.day,
      value: cop(d.usd),
    })),
    perUser: costByUser(inWindow).map((g) => ({
      label:
        g.key === 'sin-persona'
          ? 'Sin persona'
          : (ctx.userNames.get(g.key) ?? 'Alguien del equipo'),
      cop: cop(g.usd),
      tokens: g.tokens,
      turns: g.turns,
    })),
    perSurface: costBySurface(inWindow).map((g) => ({
      label: SURFACE_NAME[g.key] ?? g.key,
      cop: cop(g.usd),
      tokens: g.tokens,
      turns: g.turns,
    })),
    topConversations: conversations.slice(0, 10).map((g) => {
      const owner = inWindow.find((r) => r.conversationId === g.key)?.userId ?? null;
      return {
        id: g.key,
        title: ctx.conversationTitles.get(g.key) ?? 'Conversación sin título',
        person: owner ? (ctx.userNames.get(owner) ?? 'Alguien del equipo') : '—',
        cop: cop(g.usd),
        tokens: g.tokens,
        turns: g.turns,
        href: ctx.conversationTitles.has(g.key) ? `/chat/${g.key}` : null,
      };
    }),
    topTasks: costByTask(inWindow)
      .slice(0, 5)
      .map((g) => ({
        id: g.key,
        title: ctx.taskTitles.get(g.key) ?? 'Tarea',
        cop: cop(g.usd),
        tokens: g.tokens,
        href: ctx.taskTitles.has(g.key) ? `/tareas/${g.key}` : null,
      })),
    truncated: ctx.truncated,
    canEditRate: ctx.canEditRate,
  };
}
