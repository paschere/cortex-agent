import { SURFACE_LABEL, fetchUserNames, riskSignals } from '@/app/api/admin/_lib/audit-filters';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { toolLabel } from '@/lib/tool-labels';
import { clsx } from 'clsx';
import { Ban, Flag, Lock, Radar, ShieldAlert, ShieldCheck, Users, Wrench } from 'lucide-react';
import Link from 'next/link';
import { absoluteTime } from '../audit/_components/format';
import { DecisionTag, LegendDot, RiskTag, SignalChip, SurfaceTag } from '../audit/_components/tags';

export const dynamic = 'force-dynamic';

const DAY = 86_400_000;
/** Days shown in the timeline. */
const TIMELINE_DAYS = 14;
/** How far back the breakdowns look. */
const WINDOW_DAYS = 30;

interface SecurityEvent {
  id: string;
  user_id: string | null;
  agent_id: string | null;
  tool_id: string;
  surface: string | null;
  risk_level: string;
  decision: string;
  reason: string;
  signals: unknown;
  input_digest: string | null;
  created_at: string;
}

interface PolicyRow {
  key: string;
  value: unknown;
  updated_at: string | null;
}

const POLICY_COPY: Record<string, { title: string; explain: (value: unknown) => string }> = {
  block_critical: {
    title: 'Bloquear las acciones críticas',
    explain: (v) =>
      v === true || v === 'true'
        ? 'Las acciones críticas se bloquean antes de ejecutarse.'
        : 'Las acciones críticas alcanzan a ejecutarse: solo quedan registradas, no se detienen.',
  },
  sensitive_reads_per_hour: {
    title: 'Cupo de lecturas sensibles',
    explain: (v) =>
      `Pasar de ${String(v)} lecturas sensibles en una hora le sube el nivel de riesgo a la persona y empieza a marcar sus llamadas.`,
  },
  external_send_requires_confirmation: {
    title: 'Confirmar antes de que algo salga',
    explain: (v) =>
      v === true || v === 'true'
        ? 'Todo lo que sale de la organización —correo, Slack, escrituras externas— necesita que una persona lo confirme.'
        : 'Los envíos hacia afuera se ejecutan sin pedir confirmación.',
  },
};

function policyDisplay(value: unknown): string {
  if (value === true || value === 'true') return 'Activa';
  if (value === false || value === 'false') return 'Inactiva';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return JSON.stringify(value);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="field-label mb-3">{children}</div>;
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="max-w-lg text-[12.5px] leading-relaxed text-ink-muted">{children}</p>;
}

export default async function SecurityPage() {
  const sb = getSupabaseServiceClient();
  const now = Date.now();
  const since30 = new Date(now - WINDOW_DAYS * DAY).toISOString();
  const since7 = new Date(now - 7 * DAY).toISOString();

  const [eventsRes, riskyRes, policiesRes] = await Promise.all([
    sb
      .from('security_events')
      .select(
        'id, user_id, agent_id, tool_id, surface, risk_level, decision, reason, signals, input_digest, created_at',
      )
      .gte('created_at', since30)
      .order('created_at', { ascending: false })
      .limit(1000),
    sb
      .from('audit_events')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since7)
      .in('risk_level', ['high', 'critical']),
    sb.from('security_policies').select('key, value, updated_at').order('key'),
  ]);

  const events = ((eventsRes.data ?? []) as unknown as SecurityEvent[]) ?? [];
  const policies = ((policiesRes.data ?? []) as unknown as PolicyRow[]) ?? [];
  const riskyAudit7d = riskyRes.count ?? 0;

  const recent7 = events.filter((e) => e.created_at >= since7);
  const blocked7 = recent7.filter((e) => e.decision === 'blocked').length;
  const flagged7 = recent7.filter((e) => e.decision === 'flagged').length;
  const users7 = new Set(recent7.map((e) => e.user_id).filter(Boolean)).size;

  // Signal counts over the whole window.
  const signalCounts: Record<string, number> = {};
  for (const e of events) {
    for (const s of riskSignals(e.signals)) signalCounts[s] = (signalCounts[s] ?? 0) + 1;
  }
  const topSignals = Object.entries(signalCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const maxSignal = topSignals[0]?.[1] ?? 1;

  // Tool breakdown over the whole window.
  const byTool: Record<string, { total: number; blocked: number; worst: string }> = {};
  const SEVERITY = ['low', 'medium', 'high', 'critical'];
  for (const e of events) {
    const t = (byTool[e.tool_id] ??= { total: 0, blocked: 0, worst: 'low' });
    t.total += 1;
    if (e.decision === 'blocked') t.blocked += 1;
    if (SEVERITY.indexOf(e.risk_level) > SEVERITY.indexOf(t.worst)) t.worst = e.risk_level;
  }
  const topTools = Object.entries(byTool)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 8);
  const maxTool = topTools[0]?.[1].total ?? 1;

  // Timeline: flagged vs blocked per day.
  const byDay: Record<string, { flagged: number; blocked: number }> = {};
  for (const e of events) {
    const day = e.created_at.slice(0, 10);
    const d = (byDay[day] ??= { flagged: 0, blocked: 0 });
    if (e.decision === 'blocked') d.blocked += 1;
    else if (e.decision === 'flagged') d.flagged += 1;
  }
  const timeline: Array<{ day: string; flagged: number; blocked: number }> = [];
  for (let i = TIMELINE_DAYS - 1; i >= 0; i--) {
    const day = new Date(now - i * DAY).toISOString().slice(0, 10);
    timeline.push({ day, flagged: byDay[day]?.flagged ?? 0, blocked: byDay[day]?.blocked ?? 0 });
  }
  const maxDay = Math.max(1, ...timeline.map((d) => d.flagged + d.blocked));
  const timelineTotal = timeline.reduce((n, d) => n + d.flagged + d.blocked, 0);

  const recent = events.slice(0, 25);
  const userNames = await fetchUserNames(sb, recent.map((e) => e.user_id ?? '').filter(Boolean));

  const tiles = [
    {
      label: 'Bloqueadas · 7d',
      value: String(blocked7),
      icon: Ban,
      tone: blocked7 > 0 ? 'text-rose' : 'text-emerald',
    },
    {
      label: 'Marcadas · 7d',
      value: String(flagged7),
      icon: Flag,
      tone: flagged7 > 0 ? 'text-amber' : 'text-emerald',
    },
    {
      label: 'Riesgo alto o crítico · 7d',
      value: String(riskyAudit7d),
      icon: ShieldAlert,
      tone: riskyAudit7d > 0 ? 'text-amber' : 'text-emerald',
    },
    { label: 'Personas involucradas', value: String(users7), icon: Users, tone: 'text-ink' },
    {
      label: 'Señal más frecuente',
      value: topSignals[0]?.[0] ?? '—',
      icon: Radar,
      tone: 'text-ink',
    },
  ];

  return (
    <>
      <PageHeader
        title="Seguridad"
        subtitle="Qué se le impidió hacer al agente, qué se vio riesgoso y con qué reglas se decidió"
        icon={<ShieldCheck className="h-5 w-5" />}
        actions={
          <Link
            href="/admin/audit?risk=high"
            className="inline-flex items-center gap-2 rounded-card border border-border-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2"
          >
            <ShieldAlert className="h-4 w-4" />
            Ver los eventos riesgosos
          </Link>
        }
      />

      <div className="space-y-4">
        {/* Hairlines come from the gap showing the border colour through, so the
            rules stay correct at every breakpoint the grid reflows to. */}
        <Panel className="overflow-hidden">
          <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-5">
            {tiles.map((t) => (
              <div key={t.label} className="bg-surface p-4">
                <div className="flex items-center gap-1.5">
                  <t.icon className={clsx('h-3.5 w-3.5', t.tone)} />
                  <span className="field-label">{t.label}</span>
                </div>
                <div
                  className={clsx('stat-num mt-1.5 truncate text-[24px] leading-none', t.tone)}
                  title={t.value}
                >
                  {t.value}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        {/* Timeline */}
        <Panel className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="field-label">
              Marcadas frente a bloqueadas · últimos {TIMELINE_DAYS} días
            </div>
            <div className="flex items-center gap-3">
              <LegendDot color="bg-amber" label="marcadas" />
              <LegendDot color="bg-rose" label="bloqueadas" />
            </div>
          </div>
          {timelineTotal === 0 ? (
            <div className="flex h-28 items-center justify-center rounded-card border border-border bg-surface-2 px-4 text-center text-[12.5px] text-ink-muted">
              No se marcó ni se bloqueó nada en esta ventana.
            </div>
          ) : (
            <div className="flex h-28 items-end gap-1">
              {timeline.map((d) => {
                const total = d.flagged + d.blocked;
                const h = Math.round((total / maxDay) * 100);
                const blockedH = total > 0 ? Math.round((d.blocked / total) * h) : 0;
                return (
                  <div
                    key={d.day}
                    className="flex-1"
                    title={`${d.day}: ${d.flagged} marcadas, ${d.blocked} bloqueadas`}
                  >
                    <div className="flex h-28 flex-col justify-end overflow-hidden">
                      <div className="w-full bg-rose" style={{ height: `${blockedH}%` }} />
                      <div
                        className="w-full bg-amber"
                        style={{ height: `${Math.max(total > 0 ? 2 : 0, h - blockedH)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="tabular mt-1.5 flex justify-between text-[10px] text-ink-faint">
            <span>{timeline[0]?.day}</span>
            <span>{timeline[timeline.length - 1]?.day}</span>
          </div>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Top risky tools */}
          <Panel className="p-4">
            <SectionLabel>Herramientas más riesgosas · {WINDOW_DAYS}d</SectionLabel>
            {topTools.length === 0 ? (
              <EmptyNote>Ninguna herramienta ha activado la capa de seguridad todavía.</EmptyNote>
            ) : (
              <ul className="space-y-2.5">
                {topTools.map(([toolId, t]) => (
                  <li key={toolId}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-[11.5px]">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Wrench className="h-3 w-3 shrink-0 text-ink-faint" />
                        <span className="truncate font-semibold text-ink">
                          {toolLabel(toolId).label}
                        </span>
                        <RiskTag level={t.worst} />
                      </span>
                      <span className="tabular shrink-0 text-ink-faint">
                        {t.total}×
                        {t.blocked > 0 && (
                          <span className="ml-1 text-rose">· {t.blocked} bloqueadas</span>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-card bg-surface-2">
                      <div
                        className={t.blocked > 0 ? 'h-full bg-rose' : 'h-full bg-amber'}
                        style={{ width: `${Math.max(3, Math.round((t.total / maxTool) * 100))}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* Top signals */}
          <Panel className="p-4">
            <SectionLabel>Señales más frecuentes · {WINDOW_DAYS}d</SectionLabel>
            {topSignals.length === 0 ? (
              <EmptyNote>Todavía no se ha disparado ninguna señal de riesgo.</EmptyNote>
            ) : (
              <ul className="space-y-2.5">
                {topSignals.map(([signal, count]) => (
                  <li key={signal}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-[11.5px]">
                      <span className="tabular truncate text-ink">{signal}</span>
                      <span className="tabular shrink-0 text-ink-faint">{count}×</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-card bg-surface-2">
                      <div
                        className="h-full bg-sky"
                        style={{ width: `${Math.max(3, Math.round((count / maxSignal) * 100))}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* Recent security events */}
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="field-label">Eventos de seguridad recientes</div>
            <span className="text-[11px] text-ink-faint">
              {events.length === 0
                ? 'nada todavía'
                : `${events.length} en los últimos ${WINDOW_DAYS} días`}
            </span>
          </div>
          {recent.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <ShieldCheck className="mx-auto mb-3 h-6 w-6 text-emerald" />
              <p className="text-[13px] font-semibold text-ink">Nada por revisar</p>
              <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-ink-muted">
                No se ha marcado ni bloqueado ninguna llamada. Apenas pase una, aparece aquí.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="border-b border-border-strong bg-surface-2">
                  <tr className="text-left">
                    <th className="field-label px-4 py-2.5">Cuándo</th>
                    <th className="field-label px-4 py-2.5">Quién</th>
                    <th className="field-label px-4 py-2.5">Herramienta</th>
                    <th className="field-label px-4 py-2.5">Superficie</th>
                    <th className="field-label px-4 py-2.5">Nivel</th>
                    <th className="field-label px-4 py-2.5">Decisión</th>
                    <th className="field-label px-4 py-2.5">Motivo</th>
                    <th className="field-label px-4 py-2.5">Señales</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((e) => {
                    const signals = riskSignals(e.signals);
                    return (
                      <tr key={e.id} className="border-t border-border align-top">
                        <td
                          className="tabular whitespace-nowrap px-4 py-2 text-ink-faint"
                          title={absoluteTime(e.created_at)}
                        >
                          {relativeTime(e.created_at)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 font-semibold text-ink">
                          {e.user_id ? (
                            <Link
                              href={`/admin/audit?user=${e.user_id}&range=30d`}
                              className="hover:text-primary"
                            >
                              {userNames[e.user_id] ?? `${e.user_id.slice(0, 8)}…`}
                            </Link>
                          ) : (
                            <span className="text-ink-faint">el sistema</span>
                          )}
                        </td>
                        <td className="max-w-[190px] px-4 py-2">
                          <div className="truncate font-semibold text-ink">
                            {toolLabel(e.tool_id).label}
                          </div>
                          <div className="tabular truncate text-[10.5px] text-ink-faint">
                            {e.tool_id}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <SurfaceTag surface={e.surface} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <RiskTag level={e.risk_level} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <DecisionTag decision={e.decision} />
                        </td>
                        <td className="max-w-[260px] px-4 py-2 text-ink-muted">
                          <span className="line-clamp-2">{e.reason}</span>
                        </td>
                        <td className="px-4 py-2">
                          {signals.length === 0 ? (
                            <span className="tabular text-ink-faint">—</span>
                          ) : (
                            <span className="flex flex-wrap gap-1">
                              {signals.slice(0, 4).map((s) => (
                                <SignalChip key={s}>{s}</SignalChip>
                              ))}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Policies */}
        <Panel className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="field-label">Políticas activas</div>
            <span className="inline-flex items-center gap-1.5 rounded-card border border-border bg-surface-2 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              <Lock className="h-3 w-3" />
              Solo lectura
            </span>
          </div>
          {policies.length === 0 ? (
            <EmptyNote>Todavía no hay políticas configuradas.</EmptyNote>
          ) : (
            <ul className="grid gap-3 md:grid-cols-3">
              {policies.map((p) => {
                const copy = POLICY_COPY[p.key];
                return (
                  <li key={p.key} className="rounded-card border border-border bg-surface-2 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[12.5px] font-bold text-ink">
                        {copy?.title ?? p.key.replaceAll('_', ' ')}
                      </span>
                      <span className="tabular shrink-0 rounded-card border border-border bg-surface px-2 py-0.5 text-[10.5px] font-semibold text-ink">
                        {policyDisplay(p.value)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-muted">
                      {copy?.explain(p.value) ?? `Guardada como ${JSON.stringify(p.value)}.`}
                    </p>
                    <p className="tabular mt-1.5 text-[10px] text-ink-faint">{p.key}</p>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
            Las políticas se muestran tal como están guardadas. Todavía no se pueden editar desde
            aquí: cambia los valores en <span className="tabular">security_policies</span> y toman
            efecto en la siguiente llamada.
          </p>
        </Panel>

        <p className="text-[11px] leading-relaxed text-ink-faint">
          Superficies:{' '}
          {Object.entries(SURFACE_LABEL)
            .filter(([key]) => key !== 'unknown')
            .map(([, label]) => label)
            .join(' · ')}
          . Las llamadas marcadas y bloqueadas también se ven en la{' '}
          <Link
            href="/admin/audit?decision=blocked"
            className="font-semibold text-primary hover:underline"
          >
            auditoría
          </Link>
          .
        </p>
      </div>
    </>
  );
}
