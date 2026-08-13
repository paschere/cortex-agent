'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel, PanelHead } from '@/components/ui/panel';
import {
  CURRENCIES,
  PAYMENT_STATE_LABEL,
  PAYMENT_STATE_NOTE,
  PAYMENT_STATE_TONE,
} from '@/lib/payments-shape';
import { chipClass } from '@/lib/status-chip';
import clsx from 'clsx';
import { Banknote, Loader2, Quote, Scale } from 'lucide-react';
import { useState, useTransition } from 'react';
import { recordPayment, resolveDispute } from '../actions';
import { plural } from './format';
import type {
  ActionResult,
  ClientOption,
  DisputeView,
  PaymentView,
  ReceivablesView,
} from './types';

/**
 * La pantalla de pagos, del lado del navegador.
 *
 * No calcula ni una cifra: todo lo que muestra viene ya resuelto del servidor,
 * y las dos únicas escrituras que ofrece pasan por las acciones, que a su vez
 * pasan por las mismas funciones que usan el chat y el importador. Un componente
 * de cliente que sumara dinero sería un segundo sitio donde el dinero se suma.
 */

interface Props {
  receivables: ReceivablesView;
  disputes: DisputeView[];
  payments: PaymentView[];
  clients: ClientOption[];
  today: string;
}

export function PaymentsBoard({ receivables, disputes, payments, clients, today }: Props) {
  return (
    <div className="space-y-6">
      <Receivables view={receivables} />
      <Disputes disputes={disputes} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <RecordForm clients={clients} today={today} />
        <Ledger payments={payments} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Receivables({ view }: { view: ReceivablesView }) {
  return (
    <Panel className="overflow-hidden">
      <PanelHead
        icon={<Banknote className="h-4 w-4" aria-hidden />}
        title="Cartera"
        right={<span className="text-[12px] text-ink-faint">al {view.today}</span>}
      />
      {view.byCurrency.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-[14px] font-semibold text-ink">Todavía no hay cartera que calcular</p>
          <p className="mt-1 text-[13px] text-ink-muted">
            {view.pendingExcluded > 0
              ? `Hay ${plural(view.pendingExcluded, 'factura')} leída(s) que nadie ha confirmado. Ninguna entra en una cifra hasta que alguien las revise — y esa revisión es justo lo que convierte lo leído en algo que se puede sumar.`
              : 'No hay ninguna factura confirmada con saldo pendiente.'}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {view.byCurrency.map((c) => (
            <li
              key={c.currency}
              className="flex flex-wrap items-baseline gap-x-6 gap-y-2 px-5 py-4"
            >
              <span className="stat-num text-[22px] font-semibold text-ink">{c.outstanding}</span>
              <span className="text-[13px] text-ink-muted">
                {c.ageDays != null ? `a ${c.ageDays} días` : 'sin edad calculable'} ·{' '}
                {plural(c.openInvoices, 'factura abierta', 'facturas abiertas')}
              </span>
              {c.overdueInvoices > 0 ? (
                <span className={chipClass('rose')}>
                  {c.overdue} vencido en {plural(c.overdueInvoices, 'factura')}
                </span>
              ) : null}
              <span className="ml-auto text-[12px] text-ink-faint tabular">
                facturado {c.invoiced} · abonado {c.paid}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/*
        LA CONFESIÓN, ENTERA Y AL LADO DE LA CIFRA. Enseñar el número sin ella
        enseñaría a leer un total incompleto como si fuera completo, y eso es
        peor que no dar el número: se cita en una reunión y nadie lo audita.
      */}
      <p className="border-t border-border bg-surface-2 px-5 py-3 text-[12.5px] leading-relaxed text-ink-muted">
        {view.sentence}
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function Disputes({ disputes }: { disputes: DisputeView[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  function run(key: string, fn: () => Promise<ActionResult>) {
    setBusy(key);
    setError(null);
    setNote(null);
    startTransition(async () => {
      const result = await fn();
      setBusy(null);
      if (!result.ok) setError(result.error ?? 'No se pudo.');
      else if (result.note) setNote(result.note);
    });
  }

  return (
    <Panel className="overflow-hidden">
      <PanelHead
        icon={<Scale className="h-4 w-4" aria-hidden />}
        title="Pagos en disputa"
        right={
          disputes.length > 0 ? (
            <span className={chipClass('amber')}>{plural(disputes.length, 'pendiente')}</span>
          ) : null
        }
      />

      {error || note ? (
        <div
          className={clsx(
            'mx-5 mt-3 rounded-sm px-3 py-2 text-[12.5px]',
            error ? 'bg-rose-soft text-rose' : 'bg-emerald-soft text-emerald',
          )}
        >
          {error ?? note}
        </div>
      ) : null}

      {disputes.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-[14px] font-semibold text-ink">Ninguna fuente se contradice</p>
          <p className="mt-1 text-[13px] text-ink-muted">
            Cuando dos fuentes cuenten un mismo pago de forma distinta, aparecerá aquí y saldrá de
            todas las cifras hasta que alguien decida cuál vale.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {disputes.map((d) => {
            const selected = chosen[d.paymentId] ?? String(d.suggested ?? d.standingValue);
            return (
              <li key={d.paymentId} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[14px] font-semibold text-ink">
                    {d.client ?? 'Sin cliente identificado'}
                  </span>
                  <span className="text-[13px] text-ink-muted">{d.paidOn}</span>
                  {d.invoiceNumber ? (
                    <span className="text-[13px] text-ink-muted tabular">{d.invoiceNumber}</span>
                  ) : null}
                  <span className={clsx(chipClass('amber'), 'ml-auto')}>Fuera de las cifras</span>
                </div>

                <p className="mt-1 text-[12.5px] text-ink-muted">
                  Este pago no está en la cartera ni en ningún total mientras siga aquí. No es una
                  cifra menor: no está en la cifra.
                </p>

                {/*
                  Cada versión con su fuente y, cuando la hay, la frase literal
                  de la que salió. Es lo que permite comprobar la afirmación de
                  un vistazo en vez de creer que se leyó bien.
                */}
                <ul className="mt-3 space-y-2">
                  {d.versions.map((v, i) => (
                    <li
                      key={`${d.paymentId}-${i}`}
                      className="rounded-sm border border-border bg-surface-2 px-3 py-2"
                    >
                      <label className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <input
                          type="radio"
                          name={`v-${d.paymentId}`}
                          checked={selected === String(v.amountValue)}
                          onChange={() =>
                            setChosen((prev) => ({
                              ...prev,
                              [d.paymentId]: String(v.amountValue),
                            }))
                          }
                          aria-label={`Dar por bueno ${v.amount} según ${v.source}`}
                        />
                        <span className="stat-num text-[14px] font-semibold text-ink">
                          {v.amount}
                        </span>
                        <span className="text-[12.5px] text-ink-muted">
                          según {v.source} · {v.paidOn}
                        </span>
                        {i === 0 ? (
                          <span className="ml-auto text-[11px] text-ink-faint">
                            marcado por defecto — sugerencia, no veredicto
                          </span>
                        ) : null}
                      </label>
                      {v.quote ? (
                        <p className="mt-1.5 flex gap-1.5 text-[12px] italic text-ink-muted">
                          <Quote className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                          {v.quote}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    onClick={() =>
                      run(`${d.paymentId}-settle`, () =>
                        resolveDispute({
                          paymentId: d.paymentId,
                          decision: 'settle',
                          amount: Number(selected),
                          currency: d.currency,
                          paidOn: null,
                          note: null,
                        }),
                      )
                    }
                    disabled={pending}
                  >
                    {busy === `${d.paymentId}-settle` ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : null}
                    Dar por bueno este importe
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      run(`${d.paymentId}-discard`, () =>
                        resolveDispute({
                          paymentId: d.paymentId,
                          decision: 'discard',
                          amount: null,
                          currency: null,
                          paidOn: null,
                          note: null,
                        }),
                      )
                    }
                    disabled={pending}
                  >
                    {busy === `${d.paymentId}-discard` ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : null}
                    El pago no era real
                  </Button>
                  <span className="text-[11.5px] text-ink-faint">
                    Queda con tu nombre. Lo que dijo cada fuente se guarda igual, sin tocar.
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function RecordForm({ clients, today }: { clients: ClientOption[]; today: string }) {
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<string>('');
  const [paidOn, setPaidOn] = useState(today);
  const [kind, setKind] = useState<'payment' | 'reversal' | 'adjustment'>('payment');
  const [clientId, setClientId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const result = await recordPayment({
        amount: Number(amount),
        currency,
        paidOn,
        kind,
        clientId: clientId || null,
        invoiceNumber: invoiceNumber.trim() || null,
        reference: reference.trim() || null,
        note: null,
      });
      if (!result.ok) setError(result.error ?? 'No se pudo.');
      else {
        setNote(result.note ?? 'Registrado.');
        setAmount('');
        setInvoiceNumber('');
        setReference('');
      }
    });
  }

  return (
    <Panel className="overflow-hidden">
      <PanelHead
        icon={<Banknote className="h-4 w-4" aria-hidden />}
        title="Anotar un pago"
        right={<span className="text-[12px] text-ink-faint">queda con tu nombre</span>}
      />
      <div className="space-y-3 px-5 py-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block" htmlFor="pago-importe">
            <span className="field-label">Importe</span>
            <Input
              id="pago-importe"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="4200000"
              aria-label="Importe del pago"
            />
          </label>
          <label className="block">
            <span className="field-label">Moneda</span>
            {/*
              SIN OPCIÓN POR DEFECTO, A PROPÓSITO. Es un clic más y es el clic
              más barato del producto: un abono contra una factura de
              importación en dólares, guardado como pesos, está mal por un
              factor de cuatro mil y sigue pareciendo una cifra normal.
            */}
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              aria-label="Moneda del pago"
              className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-[13.5px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
            >
              <option value="">Elige la moneda</option>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block" htmlFor="pago-fecha">
            <span className="field-label">Fecha del pago</span>
            <Input
              id="pago-fecha"
              type="date"
              value={paidOn}
              onChange={(e) => setPaidOn(e.target.value)}
              aria-label="Día en que se pagó"
            />
          </label>
          <label className="block">
            <span className="field-label">Qué fue</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
              aria-label="Clase de movimiento"
              className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-[13.5px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
            >
              <option value="payment">Un abono</option>
              <option value="reversal">Una anulación o devolución</option>
              <option value="adjustment">Un ajuste</option>
            </select>
          </label>
        </div>

        <label className="block">
          <span className="field-label">Cliente</span>
          <select
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            aria-label="Cliente que pagó"
            className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-[13.5px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
          >
            <option value="">Sin cliente identificado</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block" htmlFor="pago-factura">
            <span className="field-label">Factura que paga</span>
            <Input
              id="pago-factura"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="FE-4471"
              aria-label="Número de la factura que paga"
            />
          </label>
          <label className="block" htmlFor="pago-referencia">
            <span className="field-label">Referencia</span>
            <Input
              id="pago-referencia"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Número de la transferencia"
              aria-label="Referencia de la transacción"
            />
          </label>
        </div>

        {error || note ? (
          <div
            className={clsx(
              'rounded-sm px-3 py-2 text-[12.5px]',
              error ? 'bg-rose-soft text-rose' : 'bg-emerald-soft text-emerald',
            )}
          >
            {error ?? note}
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <Button onClick={submit} disabled={pending || !amount || !currency || !paidOn}>
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Registrar
          </Button>
          <span className="text-[11.5px] text-ink-faint">
            Si otra fuente ya lo había dicho, no se duplica: se enlaza.
          </span>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function Ledger({ payments }: { payments: PaymentView[] }) {
  return (
    <Panel className="overflow-hidden">
      <PanelHead title="Lo que hay registrado" />
      {payments.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-[14px] font-semibold text-ink">Todavía no hay ningún pago</p>
          <p className="mt-1 text-[13px] text-ink-muted">
            Anota el primero a la izquierda, o sube un comprobante de pago a Brain Knowledge: al
            confirmarlo, el pago se registra solo con la frase de la que se leyó el importe.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3">
              <span className="stat-num text-[14px] font-semibold text-ink">
                {p.kind === 'reversal' ? `− ${p.amount}` : p.amount}
              </span>
              <span className="text-[13px] text-ink-muted">
                {p.client ?? 'sin cliente'} · {p.paidOn}
              </span>
              {p.invoiceNumber ? (
                <span className="text-[12px] text-ink-faint tabular">{p.invoiceNumber}</span>
              ) : null}
              <span
                className={clsx(chipClass(PAYMENT_STATE_TONE[p.state]), 'ml-auto')}
                title={PAYMENT_STATE_NOTE[p.state]}
              >
                {PAYMENT_STATE_LABEL[p.state]}
              </span>
              <span className="text-[11.5px] text-ink-faint">
                {plural(p.sourceCount, 'fuente')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
