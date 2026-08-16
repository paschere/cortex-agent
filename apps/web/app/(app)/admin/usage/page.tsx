import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { clsx } from 'clsx';
import Link from 'next/link';
import {
  BarChart3,
  Zap,
  AlertTriangle,
  Users,
  Timer,
  CheckCircle2,
  Cpu,
  CircleDollarSign,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { SURFACE_LABEL } from '@/app/api/admin/_lib/audit-filters';
import { LegendDot, RISK_BAR, SURFACE_BAR } from '../audit/_components/tags';
import { formatTokens, turnTokens } from '../audit/_components/format';
import { cacheSavingsUsd, formatUsd, rateFor, stepCostUsd } from '@/lib/model-pricing';

interface AuditEvent {
  user_id: string;
  tool_id: string;
  status: string;
  latency_ms: number;
  created_at: string;
  surface: string | null;
  risk_level: string | null;
  metadata: Record<string, unknown> | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
}

export const dynamic = 'force-dynamic';

const RANGES = [7, 14, 30] as const;
const SURFACE_KEYS = ['web', 'mcp', 'schedule', 'unknown'] as const;
const RISK_KEYS = ['low', 'medium', 'high', 'critical'] as const;

const SELECT_FULL = 'user_id, tool_id, status, latency_ms, created_at, surface, risk_level, metadata';
const SELECT_LEGACY = 'user_id, tool_id, status, latency_ms, created_at, metadata';

/** Horizontal stacked bar + legend, built from plain divs. */
function StackedBar({
  segments,
  total,
}: {
  segments: Array<{ key: string; label: string; value: number; color: string }>;
  total: number;
}) {
  const visible = segments.filter((s) => s.value > 0);
  return (
    <div>
      {total === 0 ? (
        <div className="h-3 w-full rounded-full border border-border bg-surface-2" />
      ) : (
        <div className="flex h-3 w-full overflow-hidden rounded-full border border-border bg-surface-2">
          {visible.map((s) => (
            <div
              key={s.key}
              className={s.color}
              style={{ width: `${(s.value / total) * 100}%` }}
              title={`${s.label}: ${s.value} (${Math.round((s.value / total) * 100)}%)`}
            />
          ))}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((s) => (
          <LegendDot
            key={s.key}
            color={s.color}
            label={s.label}
            value={
              total === 0
                ? '0'
                : `${s.value.toLocaleString()} · ${Math.round((s.value / total) * 100)}%`
            }
          />
        ))}
      </div>
    </div>
  );
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days: daysParam } = await searchParams;
  const days = RANGES.includes(Number(daysParam) as (typeof RANGES)[number])
    ? Number(daysParam)
    : 7;

  // Session first: the client is scoped to the workspace it resolves.
  const user = await requireSession();
  const sb = getOrgScopedClient(user.organization.id);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const run = (select: string) =>
    sb
      .from('audit_events')
      .select(select)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5000);

  // Fall back to the pre-security column set if migration 0042 has not run here.
  // El costo se calcula aparte de la auditoría, porque la auditoría solo sabe de
  // turnos de chat: los encargos y el orquestador llevan sus tokens en sus
  // propias tablas, y el detalle del caché (que decide si un token de entrada
  // costó 1x, 0.1x o 1.25x) vive únicamente en turn_latencies.
  const [resFirst, latRes, errandRes, orchRes] = await Promise.all([
    run(SELECT_FULL),
    sb
      .from('turn_latencies')
      .select('model, prompt_tokens, completion_tokens, cache, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5000),
    sb.from('errands').select('tokens_spent, created_at').gte('created_at', since).limit(2000),
    sb
      .from('orchestration_runs')
      .select('total_tokens, created_at')
      .gte('created_at', since)
      .limit(2000),
  ]);
  let res = resFirst;
  if (res.error) res = await run(SELECT_LEGACY);

  const rows: AuditEvent[] = ((res.data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    user_id: String(r.user_id ?? ''),
    tool_id: String(r.tool_id ?? ''),
    status: String(r.status ?? ''),
    latency_ms: Number(r.latency_ms ?? 0),
    created_at: String(r.created_at ?? ''),
    surface: (r.surface as string | null) ?? null,
    risk_level: (r.risk_level as string | null) ?? null,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  }));

  // Aggregations
  const byTool: Record<string, { count: number; errors: number; latencies: number[] }> = {};
  const byUser: Record<string, number> = {};
  const byDay: Record<string, { ok: number; error: number }> = {};
  const bySurface: Record<string, number> = { web: 0, mcp: 0, schedule: 0, unknown: 0 };
  const byRisk: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  const tokensByDay: Record<string, { in: number; out: number }> = {};
  let riskClassified = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let turns = 0;
  let okCount = 0;
  let errorCount = 0;
  const allLatencies: number[] = [];

  for (const e of rows) {
    const t = (byTool[e.tool_id] ??= { count: 0, errors: 0, latencies: [] });
    t.count += 1;
    if (e.status === 'error') {
      t.errors += 1;
      errorCount += 1;
    } else if (e.status === 'ok') {
      okCount += 1;
    }
    if (e.latency_ms > 0) {
      t.latencies.push(e.latency_ms);
      allLatencies.push(e.latency_ms);
    }
    byUser[e.user_id] = (byUser[e.user_id] ?? 0) + 1;
    const day = e.created_at.slice(0, 10);
    const d = (byDay[day] ??= { ok: 0, error: 0 });
    if (e.status === 'error') d.error += 1;
    else d.ok += 1;

    const surfaceKey = e.surface && surfaceKnown(e.surface) ? e.surface : 'unknown';
    bySurface[surfaceKey] = (bySurface[surfaceKey] ?? 0) + 1;

    if (e.risk_level && e.risk_level in byRisk) {
      byRisk[e.risk_level] = (byRisk[e.risk_level] ?? 0) + 1;
      riskClassified += 1;
    }

    if (e.tool_id === '__agent_turn') {
      const usage = turnTokens(e.metadata);
      tokensIn += usage.tokensIn;
      tokensOut += usage.tokensOut;
      turns += 1;
      const td = (tokensByDay[day] ??= { in: 0, out: 0 });
      td.in += usage.tokensIn;
      td.out += usage.tokensOut;
    }
  }

  // -------------------------------------------------------------------------
  // COSTO ESTIMADO EN DÓLARES. Tres fuentes, tres grados de precisión, y la
  // página distingue las tres en vez de sumarlas como si fueran iguales:
  //
  //   Chat — turn_latencies trae, POR PETICIÓN al modelo, la entrada sin caché,
  //     lo leído del caché y lo escrito. Es la única superficie donde el costo
  //     se puede calcular como lo cobra Anthropic.
  //   Encargos y orquestador — guardan un total (entrada+salida mezcladas, sin
  //     caché). Se reparte con la proporción entrada/salida observada en el
  //     chat de la misma ventana y se cobra la entrada a precio pleno: si el
  //     caché les funciona, el número real es MENOR que este. Estimación
  //     conservadora, dicha como tal.
  //   Utilitarios (títulos, extractores, sugerencias, watch) — no persisten
  //     consumo en ninguna parte. No aparecen aquí; la nota al pie lo dice.
  // -------------------------------------------------------------------------
  interface CacheStep {
    read?: number;
    written?: number;
    promptTokens?: number;
  }
  interface LatencyRow {
    model: string;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    cache: CacheStep[] | null;
    created_at: string;
  }

  let chatCostUsd = 0;
  let chatCacheRead = 0;
  let chatCacheWritten = 0;
  let chatUncachedInput = 0;
  let chatSavingsUsd = 0;
  const latRows = ((latRes.data ?? []) as unknown as LatencyRow[]).filter((r) => r.model);
  for (const row of latRows) {
    const rate = rateFor(row.model, row.created_at);
    if (!rate) continue;
    const steps = Array.isArray(row.cache) ? row.cache : [];
    let input = 0;
    let read = 0;
    let written = 0;
    if (steps.length > 0) {
      for (const s of steps) {
        input += typeof s.promptTokens === 'number' ? s.promptTokens : 0;
        read += typeof s.read === 'number' ? s.read : 0;
        written += typeof s.written === 'number' ? s.written : 0;
      }
    } else {
      // Turno sin detalle de caché (fila vieja): la entrada completa a 1x, que
      // sobrestima en vez de subestimar.
      input = row.prompt_tokens ?? 0;
    }
    const output = row.completion_tokens ?? 0;
    chatCostUsd += stepCostUsd(rate, { input, cacheRead: read, cacheWrite: written, output });
    chatSavingsUsd += cacheSavingsUsd(rate, read);
    chatUncachedInput += input;
    chatCacheRead += read;
    chatCacheWritten += written;
  }
  const chatPromptTotal = chatUncachedInput + chatCacheRead + chatCacheWritten;
  const cacheHitPct =
    chatPromptTotal > 0 ? Math.round((chatCacheRead / chatPromptTotal) * 100) : null;

  // La proporción de salida del chat, para repartir los totales mezclados de
  // encargos y orquestador. Si no hubo chat en la ventana, 10% — la forma
  // típica de un bucle agéntico, donde casi todo el token es prompt releído.
  const chatBillable = latRows.reduce(
    (acc, r) => acc + (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0),
    0,
  );
  const chatOutTokens = latRows.reduce((acc, r) => acc + (r.completion_tokens ?? 0), 0);
  const outShare = chatBillable > 0 ? chatOutTokens / chatBillable : 0.1;

  const costMixedTotal = (rows2: Array<{ tokens: number; at: string }>) => {
    let usd = 0;
    let tokens = 0;
    for (const r of rows2) {
      if (r.tokens <= 0) continue;
      // Los agentes corren en el modelo por defecto del workspace (sonnet-5
      // desde la migración 0071); estas tablas no guardan el modelo por fila.
      const rate = rateFor('claude-sonnet-5', r.at);
      if (!rate) continue;
      const out = Math.round(r.tokens * outShare);
      usd += stepCostUsd(rate, { input: r.tokens - out, cacheRead: 0, cacheWrite: 0, output: out });
      tokens += r.tokens;
    }
    return { usd, tokens };
  };

  const errandCost = costMixedTotal(
    ((errandRes.data ?? []) as unknown as Array<{ tokens_spent: number; created_at: string }>).map(
      (r) => ({ tokens: r.tokens_spent ?? 0, at: r.created_at }),
    ),
  );
  const orchCost = costMixedTotal(
    ((orchRes.data ?? []) as unknown as Array<{ total_tokens: number; created_at: string }>).map(
      (r) => ({ tokens: r.total_tokens ?? 0, at: r.created_at }),
    ),
  );

  const totalCostUsd = chatCostUsd + errandCost.usd + orchCost.usd;
  const hasCostData = latRows.length > 0 || errandCost.tokens > 0 || orchCost.tokens > 0;

  const pct = (arr: number[], p: number) => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  };

  const successRate = okCount + errorCount > 0 ? Math.round((okCount / (okCount + errorCount)) * 100) : 100;
  const p50 = pct(allLatencies, 0.5);
  const p95 = pct(allLatencies, 0.95);

  const userIds = Object.keys(byUser);
  let userMap: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: users } = await sb.from('users').select('id, email, name').in('id', userIds);
    userMap = Object.fromEntries(
      ((users ?? []) as unknown as UserRow[]).map((u) => [u.id, u.name || u.email]),
    );
  }

  const toolEntries = Object.entries(byTool).sort((a, b) => b[1].count - a[1].count).slice(0, 15);
  const maxToolCount = toolEntries[0]?.[1].count ?? 1;
  const userEntries = Object.entries(byUser).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxUserCount = userEntries[0]?.[1] ?? 1;

  // Day series, oldest → newest, filling gaps
  const daySeries: Array<{ day: string; ok: number; error: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    daySeries.push({ day, ok: byDay[day]?.ok ?? 0, error: byDay[day]?.error ?? 0 });
  }
  const maxDay = Math.max(1, ...daySeries.map((d) => d.ok + d.error));

  const tokenSeries = daySeries.map((d) => ({
    day: d.day,
    in: tokensByDay[d.day]?.in ?? 0,
    out: tokensByDay[d.day]?.out ?? 0,
  }));
  const maxTokenDay = Math.max(1, ...tokenSeries.map((d) => d.in + d.out));
  const totalTokens = tokensIn + tokensOut;
  const tokensPerDay = Math.round(totalTokens / days);

  const surfaceSegments = SURFACE_KEYS.map((k) => ({
    key: k,
    label: SURFACE_LABEL[k] ?? k,
    value: bySurface[k] ?? 0,
    color: SURFACE_BAR[k] ?? 'bg-border-strong',
  }));
  const riskSegments = RISK_KEYS.map((k) => ({
    key: k,
    label: k,
    value: byRisk[k] ?? 0,
    color: RISK_BAR[k] ?? 'bg-border-strong',
  }));

  const stats = [
    { label: 'Llamadas', value: rows.length.toLocaleString('es-CO'), icon: Zap, tone: 'text-ink' },
    {
      label: 'Tasa de éxito',
      value: `${successRate}%`,
      icon: CheckCircle2,
      tone: successRate >= 95 ? 'text-emerald' : successRate >= 80 ? 'text-amber' : 'text-rose',
    },
    {
      label: 'Errores',
      value: errorCount.toLocaleString('es-CO'),
      icon: AlertTriangle,
      tone: errorCount > 0 ? 'text-amber' : 'text-emerald',
    },
    { label: 'Personas activas', value: String(userIds.length), icon: Users, tone: 'text-ink' },
    { label: 'Latencia p50 / p95', value: `${p50}ms / ${p95}ms`, icon: Timer, tone: 'text-ink' },
  ];

  return (
    <>
      <PageHeader
        title="Uso"
        subtitle={`Actividad de herramientas en todas las superficies · últimos ${days} días`}
        icon={<BarChart3 className="h-5 w-5" />}
      />

      <div className="mb-4 flex gap-2 text-xs">
        {RANGES.map((r) => (
          <Link
            key={r}
            href={`/admin/usage?days=${r}`}
            className={clsx(
              'rounded-pill border px-3 py-1 font-mono font-semibold transition-all duration-150',
              days === r
                ? 'border-primary bg-primary text-white hover:bg-primary-strong'
                : 'border-border bg-surface text-ink-muted hover:-translate-y-px hover:border-primary/30 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transform-none motion-reduce:transition-none',
            )}
          >
            {r}d
          </Link>
        ))}
      </div>

      <div className="space-y-4">
        {/* Hairlines come from the gap showing the border colour through, so the
            rules stay correct at every breakpoint the grid reflows to. */}
        <Panel className="overflow-hidden bg-border">
          <div className="grid grid-cols-2 gap-px lg:grid-cols-5">
            {stats.map((s) => (
              <div key={s.label} className="bg-surface p-4">
                <div className="flex items-center gap-1.5">
                  <s.icon className={`h-3.5 w-3.5 ${s.tone}`} />
                  <span className="field-label">{s.label}</span>
                </div>
                <div
                  className={`stat-num mt-1.5 truncate text-xl leading-none ${s.tone}`}
                  title={s.value}
                >
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        {/* Daily activity */}
        <Panel className="p-4">
          <div className="field-label mb-3">Actividad diaria</div>
          <div className="flex h-28 items-end gap-1">
            {daySeries.map((d) => {
              const total = d.ok + d.error;
              const h = Math.round((total / maxDay) * 100);
              const errH = total > 0 ? Math.round((d.error / total) * h) : 0;
              return (
                <div
                  key={d.day}
                  className="group relative flex-1"
                  title={`${d.day}: ${total} llamadas (${d.error} con error)`}
                >
                  <div className="flex h-28 flex-col justify-end overflow-hidden">
                    <div
                      className={clsx('w-full bg-rose', errH > 0 && 'rounded-t-full')}
                      style={{ height: `${errH}%` }}
                    />
                    <div
                      className={clsx('w-full bg-primary', errH === 0 && 'rounded-t-full')}
                      style={{ height: `${Math.max(total > 0 ? 2 : 0, h - errH)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="tabular mt-1.5 flex justify-between text-micro text-ink-faint">
            <span>{daySeries[0]?.day}</span>
            <span>{daySeries[daySeries.length - 1]?.day}</span>
          </div>
        </Panel>

        {/* Where it ran + how risky it was */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel className="p-4">
            <div className="field-label mb-3">Desde dónde corrió</div>
            <StackedBar segments={surfaceSegments} total={rows.length} />
            <p className="mt-3 text-micro leading-relaxed text-ink-faint">
              {rows.length === 0
                ? 'No hay llamadas en esta ventana.'
                : bySurface.unknown === rows.length
                  ? 'Estas llamadas todavía no traen la superficie registrada.'
                  : 'La app web, Claude por MCP y las rutinas que corren solas.'}
            </p>
          </Panel>

          <Panel className="p-4">
            <div className="field-label mb-3">Reparto de riesgo</div>
            <StackedBar segments={riskSegments} total={riskClassified} />
            <p className="mt-3 text-micro leading-relaxed text-ink-faint">
              {riskClassified === 0
                ? 'Todavía no se ha clasificado el riesgo de nada en esta ventana.'
                : `${riskClassified.toLocaleString('es-CO')} de ${rows.length.toLocaleString('es-CO')} llamadas traen nivel de riesgo.`}
            </p>
          </Panel>
        </div>

        {/* Token usage */}
        <Panel className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="field-label">Consumo de tokens · turnos de chat</div>
            <div className="flex items-center gap-3">
              <LegendDot color="bg-sky" label="entrada" />
              <LegendDot color="bg-primary" label="salida" />
            </div>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: 'Tokens en total', value: formatTokens(totalTokens) },
              { label: 'De entrada', value: formatTokens(tokensIn) },
              { label: 'De salida', value: formatTokens(tokensOut) },
              { label: 'Promedio por día', value: formatTokens(tokensPerDay) },
            ].map((s) => (
              <div key={s.label} className="rounded-sm border border-border bg-surface-2 p-3">
                <div className="stat-num text-lg leading-tight text-ink">{s.value}</div>
                <div className="field-label mt-1">{s.label}</div>
              </div>
            ))}
          </div>

          {totalTokens === 0 ? (
            <div className="flex h-20 items-center justify-center rounded-sm border border-border bg-surface-2 px-4 text-center text-xs text-ink-muted">
              Ningún turno de chat registró consumo de tokens en esta ventana.
            </div>
          ) : (
            <>
              <div className="flex h-20 items-end gap-1">
                {tokenSeries.map((d) => {
                  const total = d.in + d.out;
                  const h = Math.round((total / maxTokenDay) * 100);
                  const outH = total > 0 ? Math.round((d.out / total) * h) : 0;
                  return (
                    <div
                      key={d.day}
                      className="flex-1"
                      title={`${d.day}: ${d.in.toLocaleString('es-CO')} de entrada / ${d.out.toLocaleString('es-CO')} de salida`}
                    >
                      <div className="flex h-20 flex-col justify-end overflow-hidden">
                        <div
                          className={clsx('w-full bg-primary', outH > 0 && 'rounded-t-full')}
                          style={{ height: `${outH}%` }}
                        />
                        <div
                          className={clsx('w-full bg-sky', outH === 0 && 'rounded-t-full')}
                          style={{ height: `${Math.max(total > 0 ? 2 : 0, h - outH)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="tabular mt-1.5 flex justify-between text-micro text-ink-faint">
                <span>{tokenSeries[0]?.day}</span>
                <span>
                  {turns.toLocaleString('es-CO')} turno{turns === 1 ? '' : 's'}
                </span>
                <span>{tokenSeries[tokenSeries.length - 1]?.day}</span>
              </div>
            </>
          )}
        </Panel>

        {/* Costo estimado en Anthropic */}
        <Panel className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <CircleDollarSign className="h-3.5 w-3.5 text-emerald" />
              <span className="field-label">Costo estimado · Anthropic (USD)</span>
            </div>
            {cacheHitPct !== null && (
              <span
                className={clsx(
                  'rounded-pill border px-2.5 py-0.5 font-mono text-micro font-semibold',
                  cacheHitPct >= 70
                    ? 'border-emerald/30 bg-emerald-soft text-emerald'
                    : cacheHitPct >= 40
                      ? 'border-amber/30 bg-amber-soft text-amber'
                      : 'border-rose/30 bg-rose-soft text-rose',
                )}
                title="Porcentaje del prompt del chat servido desde el caché de Anthropic. Leer del caché cuesta el 10% de la entrada normal."
              >
                caché {cacheHitPct}%
              </span>
            )}
          </div>

          {!hasCostData ? (
            <div className="flex h-20 items-center justify-center rounded-sm border border-border bg-surface-2 px-4 text-center text-xs text-ink-muted">
              Ninguna superficie registró consumo con precio en esta ventana.
            </div>
          ) : (
            <>
              <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[
                  { label: 'Total estimado', value: formatUsd(totalCostUsd), strong: true },
                  { label: 'Chat', value: formatUsd(chatCostUsd), strong: false },
                  { label: 'Encargos', value: formatUsd(errandCost.usd), strong: false },
                  { label: 'Orquestador', value: formatUsd(orchCost.usd), strong: false },
                ].map((s) => (
                  <div key={s.label} className="rounded-sm border border-border bg-surface-2 p-3">
                    <div
                      className={clsx(
                        'stat-num text-lg leading-tight',
                        s.strong ? 'text-emerald' : 'text-ink',
                      )}
                    >
                      {s.value}
                    </div>
                    <div className="field-label mt-1">{s.label}</div>
                  </div>
                ))}
              </div>

              {chatPromptTotal > 0 && (
                <div className="rounded-sm border border-border bg-surface-2 p-3 text-xs leading-relaxed text-ink-muted">
                  El caché le ahorró al chat{' '}
                  <span className="font-mono font-semibold text-emerald">
                    {formatUsd(chatSavingsUsd)}
                  </span>{' '}
                  en esta ventana: de {formatTokens(chatPromptTotal)} tokens de prompt,{' '}
                  {formatTokens(chatCacheRead)} se leyeron del caché al 10% del precio
                  {chatCacheWritten > 0 && (
                    <> y {formatTokens(chatCacheWritten)} se escribieron al 125%</>
                  )}
                  .
                </div>
              )}
            </>
          )}

          <p className="mt-3 text-micro leading-relaxed text-ink-faint">
            Estimado con precios de lista (Sonnet 5: $2/$10 por millón hasta el 31 de agosto,
            luego $3/$15). El chat se calcula con el detalle real del caché; encargos y
            orquestador guardan solo totales, así que su cifra es techo, no piso. Las llamadas
            utilitarias (títulos, extractores, sugerencias) no registran consumo y no aparecen
            aquí — la cifra autoritativa está en la consola de Anthropic.
          </p>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* By tool */}
          <Panel className="p-4">
            <div className="field-label mb-3">Herramientas más usadas</div>
            {toolEntries.length === 0 ? (
              <p className="text-xs text-ink-muted">No hay actividad en esta ventana.</p>
            ) : (
              <ul className="space-y-2">
                {toolEntries.map(([tool, t]) => {
                  const avg = t.latencies.length
                    ? Math.round(t.latencies.reduce((a, b) => a + b, 0) / t.latencies.length)
                    : 0;
                  return (
                    <li key={tool}>
                      <div className="mb-0.5 flex items-center justify-between text-micro">
                        <span className="tabular truncate font-semibold text-ink">{tool}</span>
                        <span className="tabular shrink-0 text-ink-faint">
                          {t.count}× · {avg}ms
                          {t.errors > 0 && (
                            <span className="ml-1 text-rose">· {t.errors} con error</span>
                          )}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className={t.errors > 0 ? 'h-full rounded-full bg-amber' : 'h-full rounded-full bg-primary'}
                          style={{ width: `${Math.max(3, Math.round((t.count / maxToolCount) * 100))}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          {/* By user */}
          <Panel className="p-4">
            <div className="field-label mb-3">Por persona</div>
            {userEntries.length === 0 ? (
              <p className="text-xs text-ink-muted">No hay actividad en esta ventana.</p>
            ) : (
              <ul className="space-y-2">
                {userEntries.map(([userId, count]) => (
                  <li key={userId}>
                    <div className="mb-0.5 flex items-center justify-between text-micro">
                      <span className="truncate font-semibold text-ink">
                        {userMap[userId] ?? userId.slice(0, 8)}
                      </span>
                      <span className="tabular shrink-0 text-ink-faint">
                        {count} {count === 1 ? 'llamada' : 'llamadas'}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.max(3, Math.round((count / maxUserCount) * 100))}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <p className="flex items-start gap-1.5 text-micro leading-relaxed text-ink-faint">
          <Cpu className="mt-px h-3.5 w-3.5 shrink-0" />
          El conteo de tokens sale de los turnos de chat registrados en la auditoría. Las
          superficies que solo ejecutan herramientas no reportan consumo.
        </p>
      </div>
    </>
  );
}

/** Surfaces we know how to label; anything else is bucketed as unknown. */
function surfaceKnown(surface: string): boolean {
  return surface === 'web' || surface === 'mcp' || surface === 'schedule';
}
