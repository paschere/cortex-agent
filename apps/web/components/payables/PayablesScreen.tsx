'use client';

import DataGrid from '@/components/datagrid/DataGrid';
import type { GridRow } from '@/components/datagrid/types';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import {
  INVOICE_COLUMNS,
  type InvoiceView,
  PAYABLES_ASK_CONTEXT,
  type PayablesScreenData,
  STATUS_LABEL,
  STATUS_TONE,
  SUPPLIER_COLUMNS,
  invoiceRow,
  supplierRow,
} from '@/lib/payables/view';
import { chipClass } from '@/lib/status-chip';
import type { PayableStatus } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CircleSlash,
  FileText,
  Mail,
  Plus,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useMemo, useState, useTransition } from 'react';

/**
 * «Por pagar» en el navegador: la bandeja de facturas de proveedor en la
 * grilla compartida, el programa de pagos por semana contra la caja y los
 * proveedores. Sólo dibuja y llama a las acciones del servidor; toda regla
 * (quién decide, transiciones, la fecha que sugiere la caja) vive en el
 * paquete y se vuelve a revisar allá.
 */

type Result = { ok: true; note: string } | { ok: false; error: string };

export interface PayablesActions {
  approve(ids: string[]): Promise<Result>;
  reject(ids: string[], reason: string): Promise<Result>;
  reopen(ids: string[]): Promise<Result>;
  schedule(ids: string[], date?: string | null): Promise<Result>;
  suggest(ids: string[]): Promise<
    | {
        ok: true;
        suggestions: Array<{
          id: string;
          date: string;
          lateDays: number;
          belowMinimum: boolean;
          reason: string;
        }>;
      }
    | { ok: false; error: string }
  >;
  markPaid(input: { id: string; date: string; reference: string; note?: string }): Promise<Result>;
  recheck(id: string): Promise<Result>;
  record(input: {
    supplierName: string;
    supplierNit?: string;
    number: string;
    issueDate: string;
    dueDate?: string;
    total: string;
    iva?: string;
  }): Promise<Result>;
  saveSupplier(input: {
    id: string;
    paymentTermsDays?: string;
    approverId?: string;
    retefuenteRate?: string;
    reteivaRate?: string;
    reteicaRate?: string;
    email?: string;
  }): Promise<Result>;
  checkMail(): Promise<Result>;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function day(d: string | null | undefined): string {
  if (!d) return '—';
  const [, m, dd] = d.split('-');
  return `${Number(dd)} ${MONTHS[Number(m) - 1] ?? ''}`;
}

function money(n: number | null | undefined, currency = 'COP'): string {
  if (n == null) return '—';
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'COP' ? 0 : 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(0)}`;
  }
}

function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const AWAITING: readonly PayableStatus[] = ['recibida', 'por_aprobar'];

function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const run = (fn: () => Promise<Result>) =>
    start(async () => {
      const r = await fn();
      setFlash(r.ok ? { tone: 'ok', text: r.note } : { tone: 'error', text: r.error });
      if (r.ok) router.refresh();
    });
  return { pending, flash, setFlash, run };
}

function Flash({ flash }: { flash: { tone: 'ok' | 'error'; text: string } | null }) {
  if (!flash) return null;
  return (
    <output
      className={clsx(
        'block rounded-sm px-3 py-2 text-sm',
        flash.tone === 'ok' ? 'bg-emerald-soft text-emerald' : 'bg-rose-soft text-rose',
      )}
    >
      {flash.text}
    </output>
  );
}

export function PayablesScreen({
  tab,
  data,
  actions,
}: {
  tab: 'bandeja' | 'programa' | 'proveedores';
  data: PayablesScreenData;
  actions: PayablesActions;
}) {
  const awaiting = data.invoices.filter((i) => AWAITING.includes(i.status));
  const approved = data.invoices.filter((i) => i.status === 'aprobada');
  const thisWeek =
    data.plan?.weeks[0] && data.plan.weeks[0].start <= data.today ? data.plan.weeks[0] : null;
  const overdue = data.invoices.filter(
    (i) =>
      (i.status === 'aprobada' || AWAITING.includes(i.status)) &&
      i.dueDate &&
      i.dueDate < data.today,
  );
  const tabs = [
    { id: 'bandeja', label: 'Facturas', href: '/pagar', count: awaiting.length },
    {
      id: 'programa',
      label: 'Programa de pagos',
      href: '/pagar?tab=programa',
      count: approved.length,
    },
    { id: 'proveedores', label: 'Proveedores', href: '/pagar?tab=proveedores', count: 0 },
  ] as const;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Por aprobar"
          value={money(awaiting.reduce((s, i) => s + (i.currency === 'COP' ? i.netAmount : 0), 0))}
          hint={`${awaiting.length} factura${awaiting.length === 1 ? '' : 's'}${awaiting.some((i) => i.checks.some((c) => c.severity !== 'info')) ? ' · con avisos' : ''}`}
          tone={awaiting.length ? 'primary' : 'neutral'}
        />
        <Kpi
          label="Aprobadas sin día"
          value={String(approved.length)}
          hint={approved.length ? 'Programa su pago contra la caja' : 'Nada pendiente'}
          tone={approved.length ? 'amber' : 'neutral'}
        />
        <Kpi
          label="Pagos esta semana"
          value={money(thisWeek?.total ?? 0)}
          hint={
            thisWeek?.closing != null
              ? `La caja cerraría en ${money(thisWeek.closing)}`
              : 'Sin pagos programados esta semana'
          }
          tone={thisWeek?.belowMinimum ? 'rose' : 'neutral'}
        />
        <Kpi
          label="Vencidas sin pagar"
          value={String(overdue.length)}
          hint={overdue.length ? money(overdue.reduce((s, i) => s + i.netAmount, 0)) : 'Al día'}
          tone={overdue.length ? 'rose' : 'emerald'}
        />
      </div>

      <nav
        className="flex gap-1 overflow-x-auto border-b border-border"
        aria-label="Secciones de por pagar"
      >
        {tabs.map((t) => (
          <Link
            key={t.id}
            href={t.href}
            aria-current={tab === t.id ? 'page' : undefined}
            className={clsx(
              '-mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition-colors duration-150 motion-reduce:transition-none',
              tab === t.id
                ? 'border-primary text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {t.label}
            {t.count > 0 && (
              <span className={chipClass(t.id === 'bandeja' ? 'primary' : 'amber')}>{t.count}</span>
            )}
          </Link>
        ))}
      </nav>

      {tab === 'bandeja' && <Inbox data={data} actions={actions} />}
      {tab === 'programa' && <Plan data={data} actions={actions} />}
      {tab === 'proveedores' && <Suppliers data={data} actions={actions} />}
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: 'neutral' | 'primary' | 'amber' | 'rose' | 'emerald';
}) {
  return (
    <Panel className="p-4">
      <p className="text-xs font-semibold text-ink-muted">{label}</p>
      <p
        className={clsx(
          'mt-1 text-xl font-extrabold tabular-nums',
          tone === 'rose' ? 'text-rose' : tone === 'amber' ? 'text-amber' : 'text-ink',
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 truncate text-xs text-ink-muted">{hint}</p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// La bandeja
// ---------------------------------------------------------------------------

function Inbox({ data, actions }: { data: PayablesScreenData; actions: PayablesActions }) {
  const { pending, flash, run } = useAction();
  const [recording, setRecording] = useState(false);
  const byId = useMemo(() => new Map(data.invoices.map((i) => [i.id, i])), [data.invoices]);
  const rows = useMemo(() => data.invoices.map(invoiceRow), [data.invoices]);

  const decide = async (rowIds: string[], key: string, value: unknown): Promise<void> => {
    if (key !== 'estado') throw new Error('Sólo se decide el estado desde aquí.');
    const ids = rowIds.filter((id) => byId.has(id));
    let r: Result;
    if (value === 'aprobada') r = await actions.approve(ids);
    else if (value === 'programada') r = await actions.schedule(ids, null);
    else if (value === 'rechazada') {
      const reason = window.prompt('¿Por qué no se pagan? (queda en cada factura)');
      if (!reason) throw new Error('Sin motivo no se rechaza.');
      r = await actions.reject(ids, reason);
    } else if (value === 'por_aprobar') r = await actions.reopen(ids);
    else throw new Error('Pagada se marca una por una, con su comprobante.');
    if (!r.ok) throw new Error(r.error);
    run(async () => r);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={pending} onClick={() => run(actions.checkMail)}>
          <Mail className="h-4 w-4" aria-hidden />
          Revisar el correo ahora
        </Button>
        <Button variant="ghost" onClick={() => setRecording((v) => !v)}>
          <Plus className="h-4 w-4" aria-hidden />
          Anotar una factura
        </Button>
        <p className="text-xs text-ink-muted">
          Llegan solas del correo (el ZIP de la factura electrónica), de la Bandeja y del programa
          contable.
        </p>
      </div>
      <Flash flash={flash} />
      {recording && (
        <RecordForm today={data.today} actions={actions} onDone={() => setRecording(false)} />
      )}
      <DataGrid
        columns={INVOICE_COLUMNS}
        rows={rows}
        initialView={{
          filters: [
            {
              key: 'estado',
              op: 'in',
              value: ['recibida', 'por_aprobar', 'aprobada', 'programada'],
            },
          ],
          sort: [{ key: 'vence', dir: 'asc' }],
          hidden: ['emision', 'nit', 'origen'],
        }}
        onEdit={(rowId, key, value) => decide([rowId], key, value)}
        onBulkEdit={decide}
        renderRowDetail={(row: GridRow) => {
          const inv = byId.get(row.id);
          return inv ? <InvoiceDetail inv={inv} today={data.today} actions={actions} /> : null;
        }}
        exportName="facturas-proveedor"
        noun={{ one: 'factura', many: 'facturas', gender: 'f' }}
        askCortexContext={PAYABLES_ASK_CONTEXT}
        emptyState={{
          title: 'Todavía no hay facturas de proveedor',
          body: 'Llegan solas del correo conectado, de los PDF que confirmes como «por pagar» en la Bandeja y de las compras del programa contable.',
          action: { label: 'Conectar el correo', href: '/integrations' },
        }}
        urlParam={false}
      />
    </div>
  );
}

const SEVERITY_STYLE = {
  block: { tone: 'rose' as const, icon: ShieldAlert, label: 'Detiene' },
  warn: { tone: 'amber' as const, icon: AlertTriangle, label: 'Revisar' },
  info: { tone: 'neutral' as const, icon: CheckCircle2, label: 'Nota' },
};

function InvoiceDetail({
  inv,
  today,
  actions,
}: { inv: InvoiceView; today: string; actions: PayablesActions }) {
  const { pending, flash, run } = useAction();
  const [mode, setMode] = useState<'none' | 'reject' | 'schedule' | 'paid'>('none');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const [reference, setReference] = useState('');
  const [suggestion, setSuggestion] = useState<{ date: string; reason: string } | null>(null);
  const awaiting = AWAITING.includes(inv.status);
  const withheld =
    inv.withholdings.retefuente + inv.withholdings.reteiva + inv.withholdings.reteica;

  const openSchedule = () => {
    setMode('schedule');
    setSuggestion(null);
    void actions.suggest([inv.id]).then((r) => {
      if (r.ok && r.suggestions[0]) {
        setSuggestion({ date: r.suggestions[0].date, reason: r.suggestions[0].reason });
        setDate(r.suggestions[0].date);
      }
    });
  };

  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="text-xs font-semibold text-ink-muted">
          {inv.supplierNit ? `NIT ${inv.supplierNit}` : 'Sin NIT'}
        </p>
        <h3 className="text-lg font-extrabold text-ink">
          {inv.supplierName} · {inv.docNumber}
        </h3>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className={chipClass(STATUS_TONE[inv.status])}>{STATUS_LABEL[inv.status]}</span>
          {inv.dianValidated === true && (
            <span className={chipClass('emerald')}>Validada por la DIAN</span>
          )}
          {inv.scheduledPayDate && inv.status === 'programada' && (
            <span className={chipClass('emerald')}>Pago el {day(inv.scheduledPayDate)}</span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-bold uppercase tracking-wide text-ink-muted">
          Lo que encontró la revisión
        </h4>
        {inv.checks.length === 0 ? (
          <p className="text-ink-muted">
            Sin novedad: ni doble cobro, ni NIT raro, ni precios fuera de lo normal.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {inv.checks.map((c) => {
              const s = SEVERITY_STYLE[c.severity];
              const Icon = s.icon;
              return (
                <li key={c.code} className="flex items-start gap-2">
                  <Icon
                    className={clsx(
                      'mt-0.5 h-4 w-4 shrink-0',
                      s.tone === 'rose'
                        ? 'text-rose'
                        : s.tone === 'amber'
                          ? 'text-amber'
                          : 'text-ink-faint',
                    )}
                    aria-label={s.label}
                  />
                  <span className="text-ink">{c.message}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-sm bg-surface-2 p-3">
        <Row label="Emitida" value={day(inv.issueDate)} />
        <Row label="Vence" value={day(inv.dueDate)} />
        {inv.subtotal != null && <Row label="Subtotal" value={money(inv.subtotal, inv.currency)} />}
        <Row label="IVA" value={money(inv.iva, inv.currency)} />
        <Row label="Total" value={money(inv.total, inv.currency)} />
        <Row
          label="Retenciones"
          value={withheld ? `− ${money(withheld, inv.currency)}` : 'Ninguna'}
        />
        <Row label="A pagar (neto)" value={money(inv.netAmount, inv.currency)} strong />
        {inv.orderReference && <Row label="Orden de compra" value={inv.orderReference} />}
        {inv.approverName && <Row label="Aprueba" value={inv.approverName} />}
      </dl>

      {inv.lines.length > 0 && (
        <details className="rounded-sm border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-ink-muted">
            {inv.lines.length} línea{inv.lines.length === 1 ? '' : 's'}
          </summary>
          <ul className="divide-y divide-border">
            {inv.lines.map((l) => (
              <li
                key={`${l.position}-${l.description}`}
                className="flex justify-between gap-3 px-3 py-1.5 text-xs"
              >
                <span className="min-w-0 truncate text-ink">
                  {l.quantity != null ? `${l.quantity} × ` : ''}
                  {l.description}
                </span>
                <span className="shrink-0 tabular-nums text-ink-muted">
                  {money(l.amount, inv.currency)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex items-start gap-2 text-xs text-ink-muted">
        <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <p>
          {inv.evidence.subject
            ? `Correo «${inv.evidence.subject}»${inv.evidence.from ? ` de ${inv.evidence.from}` : ''}. `
            : ''}
          {inv.evidence.files?.length ? `Adjuntos: ${inv.evidence.files.join(', ')}. ` : ''}
          {inv.evidence.note ?? ''}
          {inv.cufe ? ` CUFE ${inv.cufe.slice(0, 16)}…` : ''}
        </p>
      </div>

      {inv.status === 'rechazada' && inv.rejectionReason && (
        <p className="rounded-sm bg-rose-soft px-3 py-2 text-rose">
          Rechazada: {inv.rejectionReason}
        </p>
      )}
      {inv.status === 'pagada' && (
        <p className="rounded-sm bg-surface-2 px-3 py-2 text-ink-muted">
          Pagada el {day(inv.paidAt)}
          {inv.paidEvidence?.kind === 'bank'
            ? ' (la vi salir en el extracto del banco)'
            : inv.paidEvidence?.kind === 'accounting'
              ? ' (según el programa contable)'
              : inv.paidEvidence?.reference
                ? ` · comprobante ${inv.paidEvidence.reference}`
                : ''}
          .
        </p>
      )}

      <Flash flash={flash} />

      <div className="flex flex-wrap gap-2">
        {awaiting && (
          <Button disabled={pending} onClick={() => run(() => actions.approve([inv.id]))}>
            Aprobar
          </Button>
        )}
        {(inv.status === 'aprobada' || inv.status === 'programada') && (
          <Button disabled={pending} onClick={openSchedule}>
            <CalendarClock className="h-4 w-4" aria-hidden />
            {inv.status === 'programada' ? 'Cambiar el día' : 'Programar el pago'}
          </Button>
        )}
        {(inv.status === 'aprobada' || inv.status === 'programada' || awaiting) && (
          <Button variant="outline" disabled={pending} onClick={() => setMode('paid')}>
            Marcar pagada
          </Button>
        )}
        {inv.status !== 'pagada' && inv.status !== 'rechazada' && (
          <Button variant="ghost" disabled={pending} onClick={() => setMode('reject')}>
            Rechazar
          </Button>
        )}
        {inv.status === 'rechazada' && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => run(() => actions.reopen([inv.id]))}
          >
            Reabrir
          </Button>
        )}
        {inv.status !== 'pagada' && (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => run(() => actions.recheck(inv.id))}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Revisar otra vez
          </Button>
        )}
      </div>

      {mode === 'reject' && (
        <InlineForm
          onCancel={() => setMode('none')}
          onSubmit={() => run(() => actions.reject([inv.id], reason))}
          submit="Rechazar"
          pending={pending}
        >
          <label
            className="block text-xs font-semibold text-ink-muted"
            htmlFor={`motivo-${inv.id}`}
          >
            Por qué no se paga
          </label>
          <input
            id={`motivo-${inv.id}`}
            className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Doble cobro de la FEPA-449"
          />
        </InlineForm>
      )}
      {mode === 'schedule' && (
        <InlineForm
          onCancel={() => setMode('none')}
          onSubmit={() => run(() => actions.schedule([inv.id], date || null))}
          submit="Programar"
          pending={pending}
        >
          <p className="text-xs text-ink-muted">
            {suggestion ? suggestion.reason : 'Calculando el día contra la caja…'}
          </p>
          <label
            className="mt-2 block text-xs font-semibold text-ink-muted"
            htmlFor={`dia-${inv.id}`}
          >
            Día de pago
          </label>
          <input
            id={`dia-${inv.id}`}
            type="date"
            min={today}
            className="mt-1 rounded-sm border border-border bg-surface px-3 py-2 text-sm"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </InlineForm>
      )}
      {mode === 'paid' && (
        <InlineForm
          onCancel={() => setMode('none')}
          onSubmit={() =>
            run(() => actions.markPaid({ id: inv.id, date: date || today, reference }))
          }
          submit="Marcar pagada"
          pending={pending}
        >
          <p className="text-xs text-ink-muted">
            Si el pago sale en el extracto, Cortex la marca solo. A mano, con el comprobante.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              type="date"
              max={today}
              aria-label="Fecha del pago"
              className="rounded-sm border border-border bg-surface px-3 py-2 text-sm"
              value={date || today}
              onChange={(e) => setDate(e.target.value)}
            />
            <input
              aria-label="Número del comprobante"
              className="min-w-0 flex-1 rounded-sm border border-border bg-surface px-3 py-2 text-sm"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Comprobante de la transferencia"
            />
          </div>
        </InlineForm>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd
        className={clsx('text-right tabular-nums', strong ? 'font-extrabold text-ink' : 'text-ink')}
      >
        {value}
      </dd>
    </>
  );
}

function InlineForm({
  children,
  onSubmit,
  onCancel,
  submit,
  pending,
}: {
  children: ReactNode;
  onSubmit: () => void;
  onCancel: () => void;
  submit: string;
  pending: boolean;
}) {
  return (
    <form
      className="space-y-2 rounded-sm border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {submit}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function RecordForm({
  today,
  actions,
  onDone,
}: { today: string; actions: PayablesActions; onDone: () => void }) {
  const { pending, flash, run } = useAction();
  const [f, setF] = useState({
    supplierName: '',
    supplierNit: '',
    number: '',
    issueDate: today,
    dueDate: '',
    total: '',
    iva: '',
  });
  const field = (key: keyof typeof f, label: string, props: Record<string, unknown> = {}) => (
    <label className="block text-xs font-semibold text-ink-muted">
      {label}
      <input
        className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm font-normal text-ink"
        value={f[key]}
        onChange={(e) => setF((prev) => ({ ...prev, [key]: e.target.value }))}
        {...props}
      />
    </label>
  );
  return (
    <Panel className="p-4">
      <form
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await actions.record(f);
            if (r.ok) onDone();
            return r;
          });
        }}
      >
        {field('supplierName', 'Proveedor', { required: true })}
        {field('supplierNit', 'NIT (opcional)')}
        {field('number', 'Número de la factura', { required: true })}
        {field('issueDate', 'Emitida', { type: 'date', required: true })}
        {field('dueDate', 'Vence', { type: 'date' })}
        {field('total', 'Total con IVA', {
          inputMode: 'numeric',
          required: true,
          placeholder: '2.380.000',
        })}
        {field('iva', 'IVA (opcional)', { inputMode: 'numeric' })}
        <div className="flex items-end gap-2 sm:col-span-2">
          <Button type="submit" disabled={pending}>
            Anotar
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancelar
          </Button>
        </div>
        <div className="sm:col-span-3">
          <Flash flash={flash} />
        </div>
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// El programa de pagos
// ---------------------------------------------------------------------------

function Plan({ data, actions }: { data: PayablesScreenData; actions: PayablesActions }) {
  const { pending, flash, run } = useAction();
  const plan = data.plan;
  if (!plan) {
    return (
      <div className="flex items-start gap-3 rounded-sm bg-surface-2 px-4 py-3 text-sm text-ink-muted">
        <CircleSlash className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>
          No pude armar el programa de pagos: {data.planError ?? 'falta la proyección de caja'}.
        </p>
      </div>
    );
  }
  const unscheduledIds = plan.unscheduled.map((u) => u.id);
  return (
    <div className="space-y-4">
      <Flash flash={flash} />
      {plan.unscheduled.length > 0 && (
        <Panel className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-extrabold text-ink">
                {plan.unscheduled.length} aprobada{plan.unscheduled.length === 1 ? '' : 's'} sin día
                de pago
              </h3>
              <p className="text-xs text-ink-muted">
                Cortex propone cada día: el vencimiento, salvo que esa semana la caja quede debajo
                del mínimo
                {plan.minimumCash ? ` (${money(plan.minimumCash)})` : ''}.
              </p>
            </div>
            <Button
              disabled={pending}
              onClick={() => run(() => actions.schedule(unscheduledIds, null))}
            >
              <CalendarClock className="h-4 w-4" aria-hidden />
              Programar todas contra la caja
            </Button>
          </div>
          <ul className="mt-3 divide-y divide-border text-sm">
            {plan.unscheduled.map((u) => (
              <li key={u.id} className="flex justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate text-ink">
                  {u.supplierName} · {u.docNumber}
                </span>
                <span className="shrink-0 text-ink-muted">
                  vence {day(u.dueDate)} ·{' '}
                  <span className="tabular-nums text-ink">{money(u.amount, u.currency)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {plan.weeks.length === 0 ? (
        <p className="rounded-sm bg-surface-2 px-4 py-3 text-sm text-ink-muted">
          No hay pagos a proveedores programados. Cuando apruebes y programes, aparecen aquí por
          semana.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {plan.weeks.map((w) => {
            const isThis = w.start <= data.today && data.today <= w.end;
            const pct =
              w.opening != null && w.opening > 0
                ? Math.min(100, Math.round((w.total / w.opening) * 100))
                : null;
            return (
              <Panel key={w.start} className={clsx('p-4', w.belowMinimum && 'ring-1 ring-rose/40')}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-ink-muted">
                      {isThis ? 'Esta semana' : 'Semana'} · {day(w.start)}–
                      {day(addDays(w.start, 4))}
                    </p>
                    <p className="text-xl font-extrabold tabular-nums text-ink">{money(w.total)}</p>
                    <p className="text-xs text-ink-muted">
                      {w.items.length} pago{w.items.length === 1 ? '' : 's'} a proveedores
                    </p>
                  </div>
                  <div className="text-right text-xs">
                    <p className="text-ink-muted">Caja al cierre</p>
                    <p
                      className={clsx(
                        'text-base font-bold tabular-nums',
                        w.belowMinimum ? 'text-rose' : 'text-ink',
                      )}
                    >
                      {money(w.closing)}
                    </p>
                    {w.belowMinimum ? (
                      <span className={chipClass('rose')}>Debajo del mínimo</span>
                    ) : (
                      w.minimumCash > 0 && (
                        <p className="text-micro text-ink-muted">Mínimo {money(w.minimumCash)}</p>
                      )
                    )}
                  </div>
                </div>
                {pct != null && (
                  <div className="mt-3" aria-hidden>
                    <div className="h-1.5 overflow-hidden rounded-pill bg-surface-2">
                      <div
                        className="h-full rounded-pill bg-primary"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="mt-1 text-micro text-ink-muted">
                      {pct} % de la caja con que abre la semana ({money(w.opening)})
                    </p>
                  </div>
                )}
                <ul className="mt-3 divide-y divide-border text-sm">
                  {w.items.map((i) => (
                    <li key={i.id} className="flex justify-between gap-3 py-1.5">
                      <span className="min-w-0 truncate text-ink">
                        <span className="text-ink-muted">{day(i.date)} · </span>
                        {i.supplierName} · {i.docNumber}
                      </span>
                      <span className="shrink-0 tabular-nums text-ink">
                        {money(i.amount, i.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            );
          })}
        </div>
      )}
      <p className="text-xs text-ink-muted">
        Cortex no paga: estos son los pagos que tú haces en el banco. Cuando salen en el extracto,
        la factura queda pagada sola. La proyección de caja (Finanzas) ya cuenta cada pago el día
        programado.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proveedores
// ---------------------------------------------------------------------------

function Suppliers({ data, actions }: { data: PayablesScreenData; actions: PayablesActions }) {
  const rows = useMemo(() => data.suppliers.map(supplierRow), [data.suppliers]);
  const byId = useMemo(() => new Map(data.suppliers.map((s) => [s.id, s])), [data.suppliers]);
  const { flash, run } = useAction();
  const FIELD: Record<string, string> = {
    plazo: 'paymentTermsDays',
    retefuente: 'retefuenteRate',
    reteiva: 'reteivaRate',
    reteica: 'reteicaRate',
    aprobador: 'approverId',
  };
  const edit = async (rowId: string, key: string, value: unknown) => {
    const field = FIELD[key];
    if (!field || !data.canManage) throw new Error('Sólo un dueño o un administrador cambia esto.');
    const r = await actions.saveSupplier({
      id: rowId,
      [field]: value == null ? '' : String(value),
    });
    if (!r.ok) throw new Error(r.error);
    run(async () => r);
  };
  return (
    <div className="space-y-3">
      <Flash flash={flash} />
      <DataGrid
        columns={SUPPLIER_COLUMNS(data.team).map((c) =>
          data.canManage ? c : { ...c, editable: false },
        )}
        rows={rows}
        initialView={{ aggregates: { plazo: 'none' } }}
        onEdit={edit}
        onBulkEdit={async (ids, key, value) => {
          for (const id of ids) await edit(id, key, value);
        }}
        renderRowDetail={(row) => {
          const s = byId.get(row.id);
          if (!s) return null;
          const mine = data.invoices.filter((i) => i.supplierId === s.id).slice(0, 30);
          return (
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs font-semibold text-ink-muted">
                  {s.nit ? `NIT ${s.nit}` : 'Sin NIT'}
                </p>
                <h3 className="text-lg font-extrabold text-ink">{s.name}</h3>
                <p className="text-xs text-ink-muted">
                  Plazo{' '}
                  {s.paymentTermsDays != null
                    ? `${s.paymentTermsDays} días`
                    : 'según cada factura (o 30 días)'}{' '}
                  · Retenciones{' '}
                  {[
                    s.retefuenteRate != null ? `ReteFuente ${s.retefuenteRate} %` : null,
                    s.reteivaRate != null ? `ReteIVA ${s.reteivaRate} %` : null,
                    s.reteicaRate != null ? `ReteICA ${s.reteicaRate} %` : null,
                  ]
                    .filter(Boolean)
                    .join(', ') || 'sin definir'}
                </p>
              </div>
              <ul className="divide-y divide-border">
                {mine.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="min-w-0 truncate">
                      {i.docNumber} <span className="text-ink-muted">· {day(i.issueDate)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className={chipClass(STATUS_TONE[i.status])}>
                        {STATUS_LABEL[i.status]}
                      </span>
                      <span className="tabular-nums">{money(i.netAmount, i.currency)}</span>
                    </span>
                  </li>
                ))}
                {mine.length === 0 && (
                  <li className="py-1.5 text-ink-muted">Sin facturas todavía.</li>
                )}
              </ul>
            </div>
          );
        }}
        exportName="proveedores"
        noun={{ one: 'proveedor', many: 'proveedores', gender: 'm' }}
        emptyState={{
          title: 'Todavía no hay proveedores',
          body: 'Se crean solos con la primera factura que llega de cada uno (por su NIT).',
        }}
        urlParam={false}
      />
    </div>
  );
}
