'use client';

import {
  ActionNote,
  fieldClass,
  pillLink,
  pillPrimary,
  statusPill,
} from '@/components/finance/pieces';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import type {
  CloseTaskView,
  WritebackKind,
  WritebackPreview,
  WritebackQueueItem,
} from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  BookOpenCheck,
  CheckCircle2,
  Circle,
  CircleSlash,
  FileDown,
  History,
  ListChecks,
  Loader2,
  Lock,
  MessageSquare,
  Send,
  Unlock,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useMemo, useState, useTransition } from 'react';
import type { CloseScreenActions, CloseScreenData, MappingRowView } from './types';

/**
 * /cierre (0192): la lista del cierre del mes, la cola de lo que Cortex
 * registra en el programa contable (con vista previa y aprobación), el plan de
 * cuentas y los meses cerrados. Todo llega calculado (close/); aquí se pinta y
 * se decide. Sólo TIPOS de @cortex/agent-tools.
 */

type Tab = 'mes' | 'registrar' | 'cuentas' | 'historial';
type Note = { ok: boolean; text: string } | null;

const TABS: Array<{ id: Tab; label: string; icon: typeof ListChecks }> = [
  { id: 'mes', label: 'Lista del mes', icon: ListChecks },
  { id: 'registrar', label: 'Registrar en el programa', icon: Send },
  { id: 'cuentas', label: 'Cuentas (PUC)', icon: BookOpenCheck },
  { id: 'historial', label: 'Historial', icon: History },
];

const KIND_LABEL: Record<WritebackKind, string> = {
  compra: 'Causar compra',
  recibo: 'Recibo de caja',
  pago_proveedor: 'Pago a proveedor',
};

const STATUS_LABEL: Record<string, string> = {
  pendiente: 'Por registrar',
  enviando: 'Enviando',
  registrada: 'Registrada',
  error: 'Con error',
  incierta: 'Revisar en el programa',
  descartada: 'Descartada',
};

const STATUS_TONE: Record<string, 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose'> = {
  pendiente: 'primary',
  enviando: 'primary',
  registrada: 'emerald',
  error: 'rose',
  incierta: 'amber',
  descartada: 'neutral',
};

const CLOSE_TONE: Record<string, 'neutral' | 'primary' | 'emerald' | 'amber'> = {
  abierto: 'neutral',
  en_cierre: 'amber',
  cerrado: 'emerald',
};

const CLOSE_LABEL: Record<string, string> = {
  abierto: 'Abierto',
  en_cierre: 'En cierre',
  cerrado: 'Cerrado',
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

function monthLabel(period: string): string {
  const [y, m] = period.split('-');
  const name = MONTHS[Number(m) - 1] ?? period;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${y}`;
}

function money(n: number, currency = 'COP'): string {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'COP' ? 0 : 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function shortDate(day: string | null): string {
  if (!day) return '';
  const [, m, d] = day.slice(0, 10).split('-');
  return `${Number(d)} ${(MONTHS[Number(m) - 1] ?? '').slice(0, 3)}`;
}

const withParam = (base: string, params: Record<string, string>) =>
  `${base}${base.includes('?') ? '&' : '?'}${new URLSearchParams(params).toString()}`;

export function CloseScreen({
  tab: initialTab,
  data,
  actions,
}: {
  tab: Tab;
  data: CloseScreenData;
  actions: CloseScreenActions;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const router = useRouter();
  const queueCount = data.queue?.items.length ?? 0;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Cierre del mes"
        subtitle="Lo que hay que cuadrar para cerrar el mes, revisado solo contra tus datos, y lo que Cortex puede registrar en tu programa contable — siempre con vista previa y tu aprobación."
        icon={<ListChecks className="h-5 w-5" aria-hidden />}
        actions={
          <>
            <select
              aria-label="Mes"
              className="min-h-9 rounded-pill border border-border-strong bg-surface px-3 text-xs font-semibold text-ink"
              value={data.period}
              onChange={(e) =>
                router.push(withParam(data.links.self, { mes: e.target.value, tab }))
              }
            >
              {data.periods.map((p) => (
                <option key={p} value={p}>
                  {monthLabel(p)}
                </option>
              ))}
            </select>
            <a href={data.links.pdf} className={pillLink} target="_blank" rel="noreferrer">
              <FileDown className="h-3.5 w-3.5" aria-hidden />
              Informe PDF
            </a>
          </>
        }
      />

      <ProgressBar data={data} actions={actions} />

      <div
        className="flex flex-wrap gap-1 border-b border-border"
        role="tablist"
        aria-label="Cierre"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={clsx(
              '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold transition-colors duration-150 motion-reduce:transition-none',
              tab === t.id
                ? 'border-primary text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            <t.icon className="h-4 w-4" aria-hidden />
            {t.label}
            {t.id === 'registrar' && queueCount > 0 && (
              <span className="rounded-pill bg-primary-soft px-1.5 text-micro font-bold text-primary-ink">
                {queueCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'mes' && <TasksTab data={data} actions={actions} />}
      {tab === 'registrar' && <QueueTab data={data} actions={actions} />}
      {tab === 'cuentas' && <MappingTab data={data} actions={actions} />}
      {tab === 'historial' && <HistoryTab data={data} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// El avance y el candado
// ---------------------------------------------------------------------------

function ProgressBar({ data, actions }: { data: CloseScreenData; actions: CloseScreenActions }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'none' | 'close' | 'reopen' | 'override'>('none');
  const v = data.view;
  if (!v)
    return (
      <Panel className="px-5 py-4 text-sm text-rose">
        No pude armar la lista del mes: {data.viewError ?? 'error desconocido'}
      </Panel>
    );
  const pct = v.progress.total ? Math.round((v.progress.done / v.progress.total) * 100) : 0;
  const allReady = v.progress.done === v.progress.total;
  const run = (fn: () => Promise<{ ok: true; note: string } | { ok: false; error: string }>) =>
    start(async () => {
      const r = await fn();
      setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
      if (r.ok) {
        setMode('none');
        setReason('');
        router.refresh();
      }
    });
  return (
    <Panel className="space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={statusPill(CLOSE_TONE[v.status] ?? 'neutral')}>
            {v.status === 'cerrado' ? <Lock className="h-3 w-3" aria-hidden /> : null}
            {CLOSE_LABEL[v.status]}
          </span>
          <div className="min-w-0">
            <p className="text-base font-extrabold text-ink">{v.label}</p>
            <p className="text-xs text-ink-muted">{v.headline}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold tabular-nums text-ink">
            {v.progress.done}/{v.progress.total}
          </span>
          <progress
            className="h-2 w-40 overflow-hidden rounded-pill accent-primary"
            max={v.progress.total || 1}
            value={v.progress.done}
            aria-label={`Tareas listas: ${pct} %`}
          />
        </div>
      </div>

      {v.status === 'cerrado' && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-surface-2 px-3 py-2 text-xs text-ink-muted">
          <span>
            Cerrado {v.closedAt ? `el ${shortDate(v.closedAt)}` : ''}. Los cambios de Cortex con
            fecha de este mes están bloqueados
            {v.overrideUntil && Date.parse(v.overrideUntil) > Date.now()
              ? ` (ventana de cambios abierta hasta las ${new Date(v.overrideUntil).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })})`
              : ''}
            .
          </span>
          {data.canManage && (
            <span className="flex gap-2">
              <button type="button" className={pillLink} onClick={() => setMode('override')}>
                <Unlock className="h-3.5 w-3.5" aria-hidden /> Permitir cambios 2 h
              </button>
              <button type="button" className={pillLink} onClick={() => setMode('reopen')}>
                Reabrir
              </button>
            </span>
          )}
        </div>
      )}

      {v.status !== 'cerrado' && data.canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={pillPrimary}
            disabled={!allReady || pending}
            onClick={() => setMode('close')}
            title={allReady ? undefined : 'Falta completar la lista'}
          >
            <Lock className="h-3.5 w-3.5" aria-hidden /> Cerrar {v.label.toLowerCase()}
          </button>
          {!allReady && (
            <span className="text-xs text-ink-muted">
              Se cierra cuando cada tarea esté al día, hecha con evidencia o marcada no aplica.
            </span>
          )}
        </div>
      )}

      {mode !== 'none' && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === 'close') run(() => actions.closePeriod(data.period, reason));
            if (mode === 'reopen') run(() => actions.reopenPeriod(data.period, reason));
            if (mode === 'override') run(() => actions.openOverride(data.period, reason));
          }}
        >
          <label className="min-w-[16rem] flex-1 text-xs font-semibold text-ink">
            {mode === 'close'
              ? 'Nota del cierre (opcional)'
              : mode === 'reopen'
                ? '¿Por qué se reabre?'
                : '¿Qué hay que cambiar en el mes cerrado?'}
            <input
              className={clsx(fieldClass, 'mt-1')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required={mode !== 'close'}
              minLength={mode !== 'close' ? 5 : undefined}
              maxLength={500}
            />
          </label>
          <button type="submit" className={pillPrimary} disabled={pending}>
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            {mode === 'close' ? 'Cerrar el mes' : mode === 'reopen' ? 'Reabrir' : 'Abrir ventana'}
          </button>
          <button type="button" className={pillLink} onClick={() => setMode('none')}>
            Cancelar
          </button>
        </form>
      )}
      <ActionNote note={note} />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// La lista
// ---------------------------------------------------------------------------

function TaskIcon({ t }: { t: CloseTaskView }) {
  if (t.ready && t.status === 'no_aplica')
    return <CircleSlash className="h-5 w-5 text-ink-faint" aria-label="No aplica" />;
  if (t.ready) return <CheckCircle2 className="h-5 w-5 text-emerald" aria-label="Lista" />;
  if (t.auto.state === 'error')
    return <AlertTriangle className="h-5 w-5 text-amber" aria-label="No pude revisar" />;
  return <Circle className="h-5 w-5 text-ink-faint" aria-label="Pendiente" />;
}

function TasksTab({ data, actions }: { data: CloseScreenData; actions: CloseScreenActions }) {
  const v = data.view;
  if (!v) return null;
  const locked = v.locked;
  return (
    <Panel className="divide-y divide-border">
      {v.tasks.map((t) => (
        <TaskRow key={t.key} t={t} data={data} actions={actions} locked={locked} />
      ))}
      {data.events.length > 0 && (
        <details className="px-5 py-3 text-xs text-ink-muted">
          <summary className="cursor-pointer font-semibold text-ink">Bitácora del mes</summary>
          <ul className="mt-2 space-y-1">
            {data.events.map((e) => (
              <li key={`${e.at}-${e.kind}`}>
                <span className="tabular-nums">{shortDate(e.at)}</span> · {e.who ?? 'Cortex'} ·{' '}
                {e.kind}
                {e.detail ? `: ${e.detail}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}

function TaskRow({
  t,
  data,
  actions,
  locked,
}: {
  t: CloseTaskView;
  data: CloseScreenData;
  actions: CloseScreenActions;
  locked: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState(t.evidence ?? '');
  const mark = (status: 'pendiente' | 'hecha' | 'no_aplica') =>
    start(async () => {
      const r = await actions.markTask(data.period, t.key, status, evidence);
      setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
      if (r.ok) {
        setOpen(false);
        router.refresh();
      }
    });
  const assign = (ownerId: string) =>
    start(async () => {
      const r = await actions.assignTask(data.period, t.key, ownerId || null);
      setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return (
    <div className="flex flex-wrap items-start gap-3 px-5 py-4">
      <span className="mt-0.5 shrink-0">
        <TaskIcon t={t} />
      </span>
      <div className="min-w-[14rem] flex-1">
        <p className="text-sm font-bold text-ink">{t.title}</p>
        <p className={clsx('mt-0.5 text-xs', t.ready ? 'text-ink-muted' : 'text-ink')}>
          {t.automatic ? t.auto.detail : t.help}
        </p>
        {t.automatic && <p className="mt-0.5 text-micro text-ink-faint">{t.help}</p>}
        {t.evidence && (
          <p className="mt-1 rounded-sm bg-surface-2 px-2 py-1 text-xs text-ink">
            <span className="font-semibold">
              {t.status === 'no_aplica' ? 'No aplica: ' : 'Evidencia: '}
            </span>
            {t.evidence}
          </p>
        )}
        {open && (
          <div className="mt-2 space-y-2">
            <label className="block text-xs font-semibold text-ink">
              Evidencia o explicación
              <textarea
                className={clsx(fieldClass, 'mt-1 min-h-16')}
                value={evidence}
                maxLength={2000}
                onChange={(e) => setEvidence(e.target.value)}
                placeholder="«El abono de $1.200.000 del 14 es un préstamo del socio»"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={pillPrimary}
                disabled={pending}
                onClick={() => mark('hecha')}
              >
                {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                Dar por hecha
              </button>
              <button
                type="button"
                className={pillLink}
                disabled={pending}
                onClick={() => mark('no_aplica')}
              >
                No aplica este mes
              </button>
              {t.status !== 'pendiente' && (
                <button
                  type="button"
                  className={pillLink}
                  disabled={pending}
                  onClick={() => mark('pendiente')}
                >
                  Volver a pendiente
                </button>
              )}
            </div>
          </div>
        )}
        <ActionNote note={note} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`Responsable de ${t.title}`}
          className="min-h-8 max-w-[11rem] rounded-sm border border-border-strong bg-surface px-2 text-xs text-ink"
          value={t.ownerId ?? ''}
          disabled={locked || pending}
          onChange={(e) => assign(e.target.value)}
        >
          <option value="">Sin responsable</option>
          {data.team.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {!t.ready && (
          <>
            <Link href={data.fixHref[t.key] ?? data.links.self} className={pillLink}>
              <Wrench className="h-3.5 w-3.5" aria-hidden /> {t.fix.label}
            </Link>
            <Link href={withParam(data.links.chat, { prompt: t.fix.prompt })} className={pillLink}>
              <MessageSquare className="h-3.5 w-3.5" aria-hidden /> Pídeselo a Cortex
            </Link>
          </>
        )}
        {!locked && (
          <button type="button" className={pillLink} onClick={() => setOpen((o) => !o)}>
            {open ? 'Cerrar' : t.ready ? 'Cambiar' : 'Marcar'}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// La cola de lo que se registra en el programa
// ---------------------------------------------------------------------------

function QueueTab({ data, actions }: { data: CloseScreenData; actions: CloseScreenActions }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const q = data.queue;
  const items = q?.items ?? [];
  const keyOf = (i: WritebackQueueItem) => `${i.kind}:${i.sourceId}`;
  const chosen = items.filter((i) => selected.has(keyOf(i)));
  const total = chosen.reduce((s, i) => s + i.amount, 0);

  if (data.queueError)
    return (
      <Panel className="px-5 py-4 text-sm text-rose">No pude leer la cola: {data.queueError}</Panel>
    );
  if (!q?.provider)
    return (
      <Panel className="space-y-2 px-5 py-5 text-sm text-ink">
        <p className="font-bold">Sin programa contable conectado</p>
        <p className="text-ink-muted">{q?.guidance}</p>
        <Link href={data.links.integrations} className={pillLink}>
          Conectar Siigo, Alegra o QuickBooks
        </Link>
      </Panel>
    );

  const register = (list: WritebackQueueItem[], retry: boolean) =>
    start(async () => {
      const r = await actions.register(
        list.map((i) => ({ kind: i.kind, sourceId: i.sourceId })),
        retry,
      );
      if (!r.ok) {
        setNote({ ok: false, text: r.error });
        return;
      }
      setNote({ ok: r.results.every((x) => x.ok), text: r.note });
      setResults(Object.fromEntries(r.results.map((x) => [x.sourceId, x])));
      setSelected(new Set());
      setConfirming(false);
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <Panel className="space-y-3 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-ink">
            <span className="font-bold">{items.length}</span> por registrar en{' '}
            <span className="font-bold">{q.providerName}</span> con fecha de{' '}
            {monthLabel(data.period).toLowerCase()}. Nada se manda sin que lo apruebes aquí (o en el
            chat).
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={pillLink}
              onClick={() =>
                setSelected(selected.size === items.length ? new Set() : new Set(items.map(keyOf)))
              }
              disabled={!items.length}
            >
              {selected.size === items.length && items.length ? 'Quitar todos' : 'Elegir todos'}
            </button>
            <button
              type="button"
              className={pillPrimary}
              disabled={!chosen.length || pending || data.view?.locked}
              onClick={() => setConfirming(true)}
            >
              <Send className="h-3.5 w-3.5" aria-hidden />
              Registrar {chosen.length ? `los ${chosen.length}` : ''}
            </button>
          </div>
        </div>
        {confirming && (
          <div className="rounded-sm border border-amber/30 bg-amber-soft px-3 py-3 text-xs text-ink">
            <p>
              Vas a registrar <strong>{chosen.length}</strong> documento
              {chosen.length === 1 ? '' : 's'} en {q.providerName} por {money(total)}. Quedan en los
              libros de la empresa. Revisa la vista previa de cada uno si no lo has hecho.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className={pillPrimary}
                disabled={pending}
                onClick={() => register(chosen, false)}
              >
                {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                Aprobar y registrar
              </button>
              <button type="button" className={pillLink} onClick={() => setConfirming(false)}>
                Cancelar
              </button>
            </div>
          </div>
        )}
        {data.view?.locked && (
          <p className="text-xs text-amber">
            El mes está cerrado: no se registra nada con fecha de este mes.
          </p>
        )}
        <ActionNote note={note} />
      </Panel>

      {items.length === 0 ? (
        <Panel className="px-5 py-6 text-center text-sm text-ink-muted">
          Nada por registrar este mes.
        </Panel>
      ) : (
        <Panel className="divide-y divide-border">
          {items.map((i) => (
            <QueueRow
              key={keyOf(i)}
              item={i}
              checked={selected.has(keyOf(i))}
              onToggle={() =>
                setSelected((s) => {
                  const n = new Set(s);
                  if (n.has(keyOf(i))) n.delete(keyOf(i));
                  else n.add(keyOf(i));
                  return n;
                })
              }
              result={results[i.sourceId]}
              providerName={q.providerName ?? ''}
              actions={actions}
              onRegister={(retry) => register([i], retry)}
              busy={pending}
            />
          ))}
        </Panel>
      )}

      {q.done.length > 0 && (
        <Panel className="px-5 py-4">
          <p className="mb-2 text-sm font-bold text-ink">Ya registrado</p>
          <ul className="space-y-1 text-xs text-ink-muted">
            {q.done.map((i) => (
              <li key={keyOf(i)} className="flex flex-wrap justify-between gap-2">
                <span>
                  {KIND_LABEL[i.kind]} · {i.label}
                  {i.providerNumber ? ` → ${i.providerNumber}` : ''}
                </span>
                <span className="tabular-nums">{money(i.amount, i.currency)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function QueueRow({
  item,
  checked,
  onToggle,
  result,
  providerName,
  actions,
  onRegister,
  busy,
}: {
  item: WritebackQueueItem;
  checked: boolean;
  onToggle: () => void;
  result?: { ok: boolean; message: string };
  providerName: string;
  actions: CloseScreenActions;
  onRegister: (retry: boolean) => void;
  busy: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<WritebackPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedProgram, setCheckedProgram] = useState(false);
  const load = () =>
    start(async () => {
      if (preview) {
        setPreview(null);
        return;
      }
      const r = await actions.preview(item.kind, item.sourceId);
      if (r.ok) {
        setPreview(r.preview);
        setError(null);
      } else setError(r.error);
    });
  const discard = () =>
    start(async () => {
      const r = await actions.discard(
        item.kind,
        item.sourceId,
        'Se registra a mano en el programa',
      );
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  return (
    <div className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={checked}
          onChange={onToggle}
          aria-label={`Elegir ${item.label}`}
        />
        <span className={statusPill('neutral')}>{KIND_LABEL[item.kind]}</span>
        <div className="min-w-[12rem] flex-1">
          <p className="text-sm font-semibold text-ink">{item.label}</p>
          <p className="text-xs text-ink-muted">
            {shortDate(item.date)} · {money(item.amount, item.currency)}
          </p>
        </div>
        <span className={statusPill(STATUS_TONE[item.status] ?? 'neutral')}>
          {STATUS_LABEL[item.status] ?? item.status}
        </span>
        <button type="button" className={pillLink} onClick={load} disabled={pending}>
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          {preview ? 'Ocultar' : 'Vista previa'}
        </button>
        <button type="button" className={pillLink} onClick={discard} disabled={pending || busy}>
          Lo hago a mano
        </button>
      </div>
      {item.error && <p className="mt-1 text-xs text-rose">{item.error}</p>}
      {result && (
        <p className={clsx('mt-1 text-xs', result.ok ? 'text-emerald' : 'text-rose')}>
          {result.message}
        </p>
      )}
      {error && <p className="mt-1 text-xs text-rose">{error}</p>}
      {preview && (
        <PreviewTable
          preview={preview}
          providerName={providerName}
          footer={
            <div className="flex flex-wrap items-center gap-3">
              {item.status === 'incierta' && (
                <label className="flex items-center gap-2 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={checkedProgram}
                    onChange={(e) => setCheckedProgram(e.target.checked)}
                  />
                  Ya revisé en {providerName} y no quedó
                </label>
              )}
              <button
                type="button"
                className={pillPrimary}
                disabled={
                  busy ||
                  preview.problems.length > 0 ||
                  (item.status === 'incierta' && !checkedProgram)
                }
                onClick={() => onRegister(item.status === 'incierta')}
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                Aprobar y registrar en {providerName}
              </button>
            </div>
          }
        />
      )}
    </div>
  );
}

function PreviewTable({
  preview,
  providerName,
  footer,
}: {
  preview: WritebackPreview;
  providerName: string;
  footer: ReactNode;
}) {
  const totals = preview.entries.reduce((s, e) => ({ d: s.d + e.debit, c: s.c + e.credit }), {
    d: 0,
    c: 0,
  });
  return (
    <div className="mt-3 space-y-2 rounded-sm border border-border bg-surface-2 p-3">
      <p className="text-xs font-semibold text-ink">
        La partida que queda en {providerName} ({shortDate(preview.date)}):
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-xs">
          <thead>
            <tr className="text-left text-ink-muted">
              <th className="py-1 pr-2 font-semibold">Cuenta</th>
              <th className="py-1 pr-2 font-semibold">Detalle</th>
              <th className="py-1 pr-2 text-right font-semibold">Débito</th>
              <th className="py-1 text-right font-semibold">Crédito</th>
            </tr>
          </thead>
          <tbody>
            {preview.entries.map((e) => (
              <tr key={`${e.account}-${e.description}`} className="border-t border-border">
                <td className="py-1 pr-2 align-top">
                  <span className="font-semibold tabular-nums text-ink">{e.account}</span>{' '}
                  <span className="text-ink-muted">{e.accountName}</span>
                  {e.accountSource === 'defecto' && (
                    <span className="ml-1 text-micro text-amber">(defecto de Cortex)</span>
                  )}
                  {e.costCenter && (
                    <span className="ml-1 text-micro text-ink-faint">CC {e.costCenter}</span>
                  )}
                </td>
                <td className="py-1 pr-2 align-top text-ink-muted">{e.description}</td>
                <td className="py-1 pr-2 text-right align-top tabular-nums">
                  {e.debit ? money(e.debit) : ''}
                </td>
                <td className="py-1 text-right align-top tabular-nums">
                  {e.credit ? money(e.credit) : ''}
                </td>
              </tr>
            ))}
            <tr className="border-t border-border-strong font-bold text-ink">
              <td className="py-1 pr-2" colSpan={2}>
                Sumas
              </td>
              <td className="py-1 pr-2 text-right tabular-nums">{money(totals.d)}</td>
              <td className="py-1 text-right tabular-nums">{money(totals.c)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {preview.problems.length > 0 && (
        <ul className="space-y-1 text-xs text-rose">
          {preview.problems.map((p) => (
            <li key={p}>• {p}</li>
          ))}
        </ul>
      )}
      {preview.warnings.length > 0 && (
        <ul className="space-y-1 text-xs text-amber">
          {preview.warnings.map((p) => (
            <li key={p}>• {p}</li>
          ))}
        </ul>
      )}
      {footer}
    </div>
  );
}

// ---------------------------------------------------------------------------
// El plan de cuentas
// ---------------------------------------------------------------------------

function MappingTab({ data, actions }: { data: CloseScreenData; actions: CloseScreenActions }) {
  const groups = useMemo(
    () => [
      {
        title: 'Papeles fijos de la partida',
        rows: data.mapping.filter((r) => r.scope === 'rol' && !r.key.startsWith('banco:')),
      },
      {
        title: 'Cuentas de banco',
        rows: data.mapping.filter((r) => r.scope === 'rol' && r.key.startsWith('banco:')),
      },
      {
        title: 'Gasto por categoría del libro',
        rows: data.mapping.filter((r) => r.scope === 'categoria'),
      },
      {
        title: 'Proveedores con cuenta propia',
        rows: data.mapping.filter((r) => r.scope === 'proveedor'),
      },
    ],
    [data.mapping],
  );
  return (
    <div className="space-y-4">
      <Panel className="px-5 py-4 text-xs text-ink-muted">
        Usa los códigos de tu plan de cuentas (PUC). Lo que dice «defecto de Cortex» es una
        subcuenta sugerida: en Siigo suele hacer falta la auxiliar (8 dígitos o más). Para Alegra y
        QuickBooks, si la cuenta no se encuentra por el código, pon su id en el programa. El centro
        de costo de Siigo es su número.{' '}
        {data.canManage ? '' : 'Sólo un administrador puede cambiarlas.'}
      </Panel>
      {groups.map((g) =>
        g.rows.length || g.title.startsWith('Proveedores') ? (
          <Panel key={g.title} className="px-5 py-4">
            <p className="mb-2 text-sm font-bold text-ink">{g.title}</p>
            <div className="divide-y divide-border">
              {g.rows.map((r) => (
                <MappingRow
                  key={`${r.scope}|${r.key}`}
                  row={r}
                  canManage={data.canManage}
                  actions={actions}
                />
              ))}
            </div>
            {g.title.startsWith('Proveedores') && data.canManage && (
              <NewSupplierMapping data={data} actions={actions} />
            )}
          </Panel>
        ) : null,
      )}
    </div>
  );
}

function MappingRow({
  row,
  canManage,
  actions,
}: {
  row: MappingRowView;
  canManage: boolean;
  actions: CloseScreenActions;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const [code, setCode] = useState(row.accountCode);
  const [name, setName] = useState(row.accountName);
  const [cc, setCc] = useState(row.costCenter ?? '');
  const [refs, setRefs] = useState(row.refs);
  const dirty =
    code !== row.accountCode ||
    name !== row.accountName ||
    cc !== (row.costCenter ?? '') ||
    JSON.stringify(refs) !== JSON.stringify(row.refs);
  const save = () =>
    start(async () => {
      const r = await actions.saveMapping({
        scope: row.scope,
        key: row.key,
        accountCode: code,
        accountName: name,
        costCenter: cc,
        refs,
      });
      setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  const reset = () =>
    start(async () => {
      const r = await actions.resetMapping(row.scope, row.key);
      setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  const small = 'min-h-8 rounded-sm border border-border-strong bg-surface px-2 text-xs text-ink';
  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      <div className="w-56 min-w-[12rem]">
        <p className="text-xs font-semibold text-ink">{row.label}</p>
        {!row.custom && <p className="text-micro text-amber">Defecto de Cortex</p>}
      </div>
      <input
        aria-label={`Código PUC de ${row.label}`}
        className={clsx(small, 'w-28 tabular-nums')}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        disabled={!canManage}
        inputMode="numeric"
      />
      <input
        aria-label={`Nombre de la cuenta de ${row.label}`}
        className={clsx(small, 'w-60')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={!canManage}
      />
      <input
        aria-label={`Centro de costo de ${row.label}`}
        placeholder="Centro de costo"
        className={clsx(small, 'w-28')}
        value={cc}
        onChange={(e) => setCc(e.target.value)}
        disabled={!canManage}
      />
      {(['siigo', 'alegra', 'quickbooks'] as const).map((p) => (
        <input
          key={p}
          aria-label={`Id en ${p} de ${row.label}`}
          placeholder={
            p === 'siigo'
              ? 'Id Siigo (forma de pago)'
              : p === 'alegra'
                ? 'Id Alegra'
                : 'Id QuickBooks'
          }
          className={clsx(small, 'w-32')}
          value={refs[p] ?? ''}
          onChange={(e) => setRefs({ ...refs, [p]: e.target.value || undefined })}
          disabled={!canManage}
        />
      ))}
      {canManage && (
        <>
          <button type="button" className={pillPrimary} disabled={!dirty || pending} onClick={save}>
            Guardar
          </button>
          {row.custom && (
            <button type="button" className={pillLink} disabled={pending} onClick={reset}>
              Volver al defecto
            </button>
          )}
        </>
      )}
      <ActionNote note={note} />
    </div>
  );
}

function NewSupplierMapping({
  data,
  actions,
}: { data: CloseScreenData; actions: CloseScreenActions }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const [supplier, setSupplier] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await actions.saveMapping({
            scope: 'proveedor',
            key: supplier,
            accountCode: code,
            accountName: name,
            costCenter: '',
            refs: {},
          });
          setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
          if (r.ok) {
            setSupplier('');
            setCode('');
            setName('');
            router.refresh();
          }
        });
      }}
    >
      <label className="text-xs font-semibold text-ink">
        Proveedor
        <select
          className={clsx(fieldClass, 'mt-1 w-64')}
          value={supplier}
          onChange={(e) => setSupplier(e.target.value)}
          required
        >
          <option value="">Elige…</option>
          {data.suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-semibold text-ink">
        Código PUC
        <input
          className={clsx(fieldClass, 'mt-1 w-32')}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          inputMode="numeric"
        />
      </label>
      <label className="text-xs font-semibold text-ink">
        Nombre
        <input
          className={clsx(fieldClass, 'mt-1 w-60')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <button type="submit" className={pillPrimary} disabled={pending}>
        Agregar
      </button>
      <ActionNote note={note} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------

function HistoryTab({ data }: { data: CloseScreenData }) {
  if (!data.history.length)
    return (
      <Panel className="px-5 py-6 text-center text-sm text-ink-muted">
        Todavía no hay meses en el cierre. El primero aparece cuando abres su lista.
      </Panel>
    );
  return (
    <Panel className="divide-y divide-border">
      {data.history.map((h) => (
        <div key={h.period} className="flex flex-wrap items-center gap-3 px-5 py-3">
          <span className={statusPill(CLOSE_TONE[h.status] ?? 'neutral')}>
            {CLOSE_LABEL[h.status]}
          </span>
          <Link
            href={withParam(data.links.self, { mes: h.period })}
            className="min-w-[10rem] flex-1 text-sm font-semibold text-ink hover:underline"
          >
            {h.label}
          </Link>
          <span className="text-xs text-ink-muted">
            {h.status === 'cerrado'
              ? `Cerrado el ${shortDate(h.closedAt)} · ${h.done}/${h.total}`
              : 'Sin cerrar'}
          </span>
          <a
            href={`/api/cierre/${h.period}/pdf`}
            className={pillLink}
            target="_blank"
            rel="noreferrer"
          >
            <FileDown className="h-3.5 w-3.5" aria-hidden /> PDF
          </a>
        </div>
      ))}
    </Panel>
  );
}
