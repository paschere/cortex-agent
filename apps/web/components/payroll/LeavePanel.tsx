'use client';

import {
  ActionNote,
  fieldClass,
  pillLink,
  pillPrimary,
  statusPill,
} from '@/components/finance/pieces';
import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Paperclip, X } from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import type { ActionResult, LeaveView, Option } from './types';

/**
 * VACACIONES Y PERMISOS: pedir (para sí; quien administra, para cualquiera),
 * aprobar o rechazar (quien administra o el jefe directo), el calendario del
 * mes y la lista. El soporte (incapacidad, registro civil) se sube al Cerebro
 * por la puerta de siempre (`/api/kb/documents`) y se ata a la solicitud.
 */

export interface LeaveActions {
  request: (input: {
    employeeId?: string | null;
    kind: string;
    start: string;
    end: string;
    reason?: string | null;
    evidenceDocumentId?: string | null;
  }) => Promise<ActionResult>;
  cancel: (id: string) => Promise<ActionResult>;
  decide: (input: {
    id: string;
    decision: 'aprobada' | 'rechazada';
    note?: string | null;
  }) => Promise<ActionResult>;
}

const TONE: Record<LeaveView['status'], 'amber' | 'emerald' | 'rose' | 'neutral'> = {
  pendiente: 'amber',
  aprobada: 'emerald',
  rechazada: 'rose',
  cancelada: 'neutral',
};

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}

function LeaveCalendar({ leave, today }: { leave: LeaveView[]; today: string }) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (first + 6) % 7; // lunes primero
  const active = leave.filter((l) => l.status === 'aprobada' || l.status === 'pendiente');
  const cells: Array<{ day: string | null; who: LeaveView[] }> = [];
  for (let i = 0; i < offset; i++) cells.push({ day: null, who: [] });
  for (let d = 1; d <= days; d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`;
    cells.push({ day, who: active.filter((l) => l.start <= day && l.end >= day) });
  }
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          className={pillLink}
          onClick={() => setMonth(shiftMonth(month, -1))}
          aria-label="Mes anterior"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <span className="text-sm font-bold capitalize text-ink">
          {MONTHS[m - 1]} {y}
        </span>
        <button
          type="button"
          className={pillLink}
          onClick={() => setMonth(shiftMonth(month, 1))}
          aria-label="Mes siguiente"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-micro text-ink-faint">
        {['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((c, i) => (
          <div
            key={c.day ?? `x${i}`}
            className={clsx(
              'min-h-14 rounded-sm border p-1 text-left text-micro',
              c.day ? 'border-border bg-surface' : 'border-transparent',
              c.day === today && 'ring-2 ring-primary/40',
            )}
          >
            {c.day && <div className="font-semibold text-ink-muted">{Number(c.day.slice(8))}</div>}
            {c.who.slice(0, 2).map((w) => (
              <div
                key={w.id}
                title={`${w.employeeName}: ${w.kindLabel} (${w.statusLabel})`}
                className={clsx(
                  'truncate rounded px-1',
                  w.status === 'aprobada' ? 'bg-emerald/15 text-emerald' : 'bg-amber/15 text-amber',
                )}
              >
                {w.employeeName.split(' ')[0]}
              </div>
            ))}
            {c.who.length > 2 && <div className="text-ink-faint">+{c.who.length - 2}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

async function uploadEvidence(file: File): Promise<string | null> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/kb/documents', { method: 'POST', body: form });
  const body = (await res.json().catch(() => ({}))) as { document?: { id: string } };
  return res.ok ? (body.document?.id ?? null) : null;
}

export function LeavePanel({
  leave,
  kinds,
  people,
  today,
  actions,
  balance,
}: {
  leave: LeaveView[];
  kinds: Option[];
  /** Si viene, quien mira puede pedir a nombre de otros (administra). */
  people?: Option[];
  today: string;
  actions: LeaveActions;
  balance?: { days: number; explanation: string; pendingPeriods: number } | null;
}) {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [kind, setKind] = useState('vacaciones');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [who, setWho] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [filter, setFilter] = useState<'pendiente' | 'todas'>('pendiente');
  const shown = useMemo(
    () => (filter === 'pendiente' ? leave.filter((l) => l.status === 'pendiente') : leave),
    [leave, filter],
  );

  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      const r = await fn();
      setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
    });

  const submit = () =>
    run(async () => {
      if (!from || !to) return { ok: false, error: 'Elige las fechas.' };
      let evidenceDocumentId: string | null = null;
      if (file) {
        evidenceDocumentId = await uploadEvidence(file);
        if (!evidenceDocumentId) return { ok: false, error: 'No se pudo subir el soporte.' };
      }
      const r = await actions.request({
        employeeId: who || null,
        kind,
        start: from,
        end: to,
        reason: reason || null,
        evidenceDocumentId,
      });
      if (r.ok) {
        setFrom('');
        setTo('');
        setReason('');
        setFile(null);
      }
      return r;
    });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="space-y-6">
        {balance && (
          <Panel className="p-5">
            <div className="text-xs text-ink-muted">Saldo de vacaciones hoy</div>
            <div className="mt-1 text-2xl font-extrabold tabular-nums text-ink">
              {balance.days} días hábiles
            </div>
            <p className="mt-1 text-xs text-ink-muted">{balance.explanation}</p>
            {balance.pendingPeriods >= 2 && (
              <p className="mt-2 text-xs font-semibold text-amber">
                Tienes dos periodos o más sin disfrutar: la ley permite acumular hasta dos. Conviene
                programarlas.
              </p>
            )}
          </Panel>
        )}
        <Panel className="space-y-3 p-5">
          <h3 className="flex items-center gap-2 text-base font-bold text-ink">
            <CalendarDays className="h-4 w-4 text-ink-faint" aria-hidden />
            Pedir vacaciones o un permiso
          </h3>
          {people && people.length > 0 && (
            <label className="block text-xs font-semibold text-ink-muted">
              Para
              <select className={fieldClass} value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">Para mí</option>
                {people.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-xs font-semibold text-ink-muted">
            Tipo
            <select className={fieldClass} value={kind} onChange={(e) => setKind(e.target.value)}>
              {kinds.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-semibold text-ink-muted">
              Desde
              <input
                type="date"
                className={fieldClass}
                value={from}
                min={`${today.slice(0, 4)}-01-01`}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="block text-xs font-semibold text-ink-muted">
              Hasta
              <input
                type="date"
                className={fieldClass}
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
          <label className="block text-xs font-semibold text-ink-muted">
            Motivo (opcional)
            <input
              className={fieldClass}
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <Paperclip className="h-3.5 w-3.5" aria-hidden />
            <span>Soporte (incapacidad, registro civil…)</span>
            <input
              type="file"
              className="text-xs"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <div className="flex items-center gap-3">
            <button type="button" className={pillPrimary} disabled={pending} onClick={submit}>
              Enviar solicitud
            </button>
            <ActionNote note={note} />
          </div>
        </Panel>
        <Panel className="p-5">
          <LeaveCalendar leave={leave} today={today} />
        </Panel>
      </div>

      <Panel className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-bold text-ink">Solicitudes</h3>
          <div className="flex gap-1">
            {(['pendiente', 'todas'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={clsx(pillLink, filter === f && 'border-primary text-primary')}
              >
                {f === 'pendiente' ? 'Pendientes' : 'Todas'}
              </button>
            ))}
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="text-sm text-ink-muted">
            {filter === 'pendiente' ? 'Nada pendiente.' : 'Todavía no hay solicitudes.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((l) => (
              <li key={l.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div>
                  <div className="text-sm font-semibold text-ink">
                    {l.employeeName} · {l.kindLabel}
                  </div>
                  <div className="text-xs text-ink-muted">
                    {l.start} a {l.end} · {l.businessDays} días hábiles ({l.calendarDays}{' '}
                    calendario)
                    {l.reason ? ` · ${l.reason}` : ''}
                  </div>
                  {l.decisionNote && (
                    <div className="text-xs text-ink-muted">«{l.decisionNote}»</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className={statusPill(TONE[l.status])}>{l.statusLabel}</span>
                  {l.canDecide && (
                    <>
                      <button
                        type="button"
                        className={pillPrimary}
                        disabled={pending}
                        onClick={() =>
                          run(() => actions.decide({ id: l.id, decision: 'aprobada' }))
                        }
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden />
                        Aprobar
                      </button>
                      <button
                        type="button"
                        className={pillLink}
                        disabled={pending}
                        onClick={() => {
                          const why = window.prompt(
                            '¿Por qué no se aprueba? La persona lo va a leer.',
                          );
                          if (why?.trim())
                            run(() =>
                              actions.decide({ id: l.id, decision: 'rechazada', note: why }),
                            );
                        }}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                        Rechazar
                      </button>
                    </>
                  )}
                  {l.mine && l.status === 'pendiente' && (
                    <button
                      type="button"
                      className={pillLink}
                      disabled={pending}
                      onClick={() => run(() => actions.cancel(l.id))}
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
