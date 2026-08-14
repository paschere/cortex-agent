'use client';

import { clsx } from 'clsx';
import Link from 'next/link';
import { useState } from 'react';
import { toolLabel } from '@/lib/tool-labels';
import { relativeTime } from '@/lib/relative-time';
import type { AuditEventRow } from '@/app/api/admin/_lib/audit-filters';
import { DECISION_LABEL, DecisionTag, RiskTag, StatusTag, SurfaceTag } from './tags';
import { absoluteTime, eventDetail, formatLatency, isAgentTurn } from './format';
import { AuditDetailDrawer } from './AuditDetailDrawer';

const HEADERS = [
  'Cuándo',
  'Quién',
  'Herramienta',
  'Origen',
  'Estado',
  'Riesgo',
  'Decisión',
  'Latencia',
  'Detalle',
];

/**
 * The audit table. Rows are rendered from server-fetched data; the only client
 * state is which row has its detail drawer open.
 */
export function AuditTable({
  rows,
  userNames,
  userHrefs,
}: {
  rows: AuditEventRow[];
  userNames: Record<string, string>;
  userHrefs: Record<string, string>;
}) {
  const [selected, setSelected] = useState<AuditEventRow | null>(null);

  const nameOf = (id: string) => userNames[id] ?? (id ? `${id.slice(0, 8)}…` : 'sin identificar');

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-border-strong bg-surface-2">
            <tr className="text-left">
              {HEADERS.map((h) => (
                <th
                  key={h}
                  className={clsx('field-label px-3 py-2.5', h === 'Latencia' && 'text-right')}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const detail = eventDetail(e);
              const risky = e.risk_level === 'critical' || e.decision === 'blocked';
              return (
                <tr
                  key={e.id}
                  tabIndex={0}
                  onClick={() => setSelected(e)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      setSelected(e);
                    }
                  }}
                  className={clsx(
                    'cursor-pointer border-t border-border align-top transition-colors hover:bg-surface-2/60',
                    risky && 'bg-rose-soft/40',
                  )}
                >
                  <td
                    className="tabular whitespace-nowrap px-3 py-2 text-ink-faint"
                    title={absoluteTime(e.created_at)}
                  >
                    {relativeTime(e.created_at)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <Link
                      href={userHrefs[e.user_id] ?? '/admin/audit'}
                      onClick={(ev) => ev.stopPropagation()}
                      className="font-semibold text-ink hover:text-primary"
                    >
                      {nameOf(e.user_id)}
                    </Link>
                  </td>
                  <td className="max-w-[210px] px-3 py-2">
                    <div className="truncate font-semibold text-ink">
                      {isAgentTurn(e.tool_id) ? 'Turno de chat' : toolLabel(e.tool_id).label}
                    </div>
                    {!isAgentTurn(e.tool_id) && (
                      <div className="tabular truncate text-micro text-ink-faint">
                        {e.tool_id}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <SurfaceTag surface={e.surface} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <StatusTag status={e.status} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {e.risk_level ? (
                      <RiskTag level={e.risk_level} />
                    ) : (
                      <span className="tabular text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {e.decision && e.decision !== 'allowed' ? (
                      <DecisionTag decision={e.decision} />
                    ) : (
                      <span className="tabular text-micro text-ink-faint">
                        {e.decision ? (DECISION_LABEL[e.decision] ?? e.decision) : '—'}
                      </span>
                    )}
                  </td>
                  <td className="tabular whitespace-nowrap px-3 py-2 text-right text-ink-faint">
                    {formatLatency(e.latency_ms)}
                  </td>
                  <td className="max-w-[300px] px-3 py-2 text-ink-muted">
                    {detail ? (
                      <span className="line-clamp-2">{detail}</span>
                    ) : (
                      <span className="tabular text-ink-faint">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <AuditDetailDrawer
        event={selected}
        userName={selected ? nameOf(selected.user_id) : ''}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
