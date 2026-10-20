'use client';

import {
  approveDraftAction,
  discardDraftAction,
  saveOutboxDraftAction,
} from '@/app/(app)/prefacturas/actions';
import { clsx } from 'clsx';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { DraftView } from './DraftInbox';

/**
 * LA TARJETA DE UN RECIBO DE CAJA, UNA NOTA CRÉDITO O UN CLIENTE (0232).
 * Misma regla que la prefactura: nada llega a Siigo hasta que una persona
 * aprueba; lo que falta se ve arriba en ámbar y se corrige aquí mismo.
 */

const INPUT =
  'rounded-card border border-border bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-primary';
const BTN =
  'rounded-card px-3 py-1.5 text-xs font-semibold disabled:opacity-50 border border-border text-ink hover:bg-surface-2';
const BTN_PRIMARY =
  'rounded-card px-3 py-1.5 text-xs font-semibold disabled:opacity-50 bg-primary text-white hover:opacity-90';
const PESOS = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const KIND_LABEL = { receipt: 'Recibo de caja', credit_note: 'Nota crédito', customer: 'Cliente', invoice: 'Factura' } as const;
const STATUS_TEXT: Record<DraftView['status'], string> = {
  pending: 'Por revisar',
  error: 'Con error',
  creating: 'Enviándose a Siigo',
  created: 'Ya está en Siigo',
  discarded: 'Descartado',
};
const REASONS: Array<[number, string]> = [
  [1, 'Devolución parcial de bienes o servicio'],
  [2, 'Anulación de la factura electrónica'],
  [3, 'Rebaja o descuento'],
  [4, 'Ajuste de precio'],
  [6, 'Descuento por pronto pago'],
  [7, 'Descuento por volumen'],
];

type P = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export function OtherDraftCard({ d, focus }: { d: DraftView; focus: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const p = d.payload as P;
  const [f, setF] = useState<Record<string, string>>((): Record<string, string> => {
    if (d.kind === 'customer')
      return {
        taxId: s(p.taxId),
        name: s(p.name),
        email: s(p.email),
        phone: s(p.phone),
        address: s(p.address),
        city: s((p.city as P | null)?.name ?? ''),
        regime: p.vatResponsible ? 'responsable_iva' : 'no_responsable',
      };
    if (d.kind === 'receipt') return { date: s(p.date), reference: s(p.reference), bankAccount: s(p.bankAccount), paymentTypeId: s(d.choices?.paymentTypeId) };
    return { date: s(p.date), invoiceNumber: s(p.invoiceNumber), reason: s(p.reason), observations: s(p.observations) };
  });
  const [apps, setApps] = useState<Array<{ invoiceNumber: string; amount: number }>>(
    ((p.applications as Array<{ invoiceNumber: string; amount: number }> | undefined) ?? []).map((a) => ({
      invoiceNumber: a.invoiceNumber,
      amount: a.amount,
    })),
  );
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const editable = d.status === 'pending' || d.status === 'error';
  const set = (k: string, v: string) => {
    setF({ ...f, [k]: v });
    setDirty(true);
  };
  const run = (fn: () => Promise<{ ok: boolean; note?: string; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.note ?? 'Listo.') : (r.error ?? 'No se pudo.') });
      if (r.ok) setDirty(false);
      router.refresh();
    });
  const save = () => {
    const edit =
      d.kind === 'customer'
        ? { customer: { taxId: f.taxId, name: f.name, email: f.email, phone: f.phone, address: f.address, city: f.city, regime: f.regime } }
        : d.kind === 'receipt'
          ? {
              receipt: { date: f.date, reference: f.reference, bankAccount: f.bankAccount, applications: apps },
              choices: f.paymentTypeId ? { paymentTypeId: f.paymentTypeId } : undefined,
            }
          : { creditNote: { date: f.date, invoiceNumber: f.invoiceNumber, reason: Number(f.reason), observations: f.observations } };
    return saveOutboxDraftAction(d.id, edit);
  };
  const apply = apps.reduce((a, x) => a + (Number(x.amount) || 0), 0);
  const isNote = d.kind === 'credit_note';

  return (
    <article id={`prefactura-${d.id}`} className={clsx('space-y-3 rounded-card border bg-surface p-4', focus ? 'border-primary' : 'border-border')}>
      <header className="flex flex-wrap items-center gap-2">
        <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-micro font-semibold text-ink">{KIND_LABEL[d.kind]}</span>
        <h3 className="text-sm font-bold text-ink">{d.customer_name || (d.customer_tax_id ? `NIT ${d.customer_tax_id}` : KIND_LABEL[d.kind])}</h3>
        <span className={clsx('rounded-pill px-2 py-0.5 text-micro font-semibold', d.status === 'error' ? 'bg-rose-soft text-rose' : d.status === 'created' ? 'bg-emerald-soft text-emerald' : 'bg-amber-soft text-amber')}>
          {STATUS_TEXT[d.status]}
        </span>
        {d.row_label && <span className="text-xs text-ink-muted">de «{d.row_label}»</span>}
        {d.kind === 'receipt' && <span className="ml-auto text-sm font-semibold tabular-nums text-ink">{PESOS.format(apply || d.total)}</span>}
      </header>
      {d.error && <p className="rounded-sm bg-rose-soft px-3 py-2 text-xs text-rose">{d.error}</p>}
      {editable && d.problems.length > 0 && (
        <ul className="list-disc space-y-0.5 rounded-sm bg-amber-soft px-6 py-2 text-xs text-amber">
          {d.problems.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      {d.status === 'created' && (
        <p className="text-xs text-ink">
          {d.provider_number ? <>Quedó como <strong>{d.provider_number}</strong> en Siigo.</> : 'Quedó en Siigo.'}
        </p>
      )}
      {d.kind === 'customer' && (
        <div className="flex flex-wrap gap-2 text-xs text-ink">
          {(
            [
              ['taxId', 'NIT / cédula', 'w-36'],
              ['name', 'Nombre o razón social', 'w-64'],
              ['email', 'Correo', 'w-52'],
              ['phone', 'Teléfono', 'w-32'],
              ['address', 'Dirección', 'w-64'],
              ['city', 'Ciudad (o código DANE)', 'w-40'],
            ] as const
          ).map(([k, label, w]) => (
            <label key={k} className="flex flex-col gap-0.5">
              <span className="text-micro text-ink-muted">{label}</span>
              <input value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)} disabled={!editable} className={clsx(INPUT, w)} />
            </label>
          ))}
          <label className="flex flex-col gap-0.5">
            <span className="text-micro text-ink-muted">Régimen</span>
            <select value={f.regime} onChange={(e) => set('regime', e.target.value)} disabled={!editable} className={INPUT}>
              <option value="no_responsable">No responsable de IVA</option>
              <option value="responsable_iva">Responsable de IVA</option>
            </select>
          </label>
          {typeof p.dv === 'string' && <span className="self-end text-ink-muted">Dígito de verificación calculado: {p.dv}</span>}
        </div>
      )}
      {d.kind === 'receipt' && (
        <>
          <div className="flex flex-wrap gap-2 text-xs text-ink">
            <label className="flex flex-col gap-0.5">
              <span className="text-micro text-ink-muted">Fecha</span>
              <input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} disabled={!editable} className={INPUT} />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-micro text-ink-muted">Referencia</span>
              <input value={f.reference} onChange={(e) => set('reference', e.target.value)} disabled={!editable} className={clsx(INPUT, 'w-44')} />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-micro text-ink-muted">Cuenta / banco</span>
              <input value={f.bankAccount} onChange={(e) => set('bankAccount', e.target.value)} disabled={!editable} className={clsx(INPUT, 'w-44')} />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-micro text-ink-muted">Forma de pago (id de Siigo)</span>
              <input value={f.paymentTypeId} onChange={(e) => set('paymentTypeId', e.target.value)} disabled={!editable} placeholder="automática" className={clsx(INPUT, 'w-32')} />
            </label>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-ink-muted">
                <th className="py-1 font-semibold">Factura que cruza</th>
                <th className="text-right font-semibold">Valor</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((a, i) => (
                <tr key={a.invoiceNumber} className="border-t border-border/60">
                  <td className="py-1">{a.invoiceNumber}</td>
                  <td className="text-right">
                    <input
                      type="number"
                      step="any"
                      value={a.amount}
                      disabled={!editable}
                      onChange={(e) => {
                        setApps(apps.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) } : x)));
                        setDirty(true);
                      }}
                      className={clsx(INPUT, 'w-32 text-right')}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {isNote && (
        <div className="flex flex-wrap gap-2 text-xs text-ink">
          <label className="flex flex-col gap-0.5">
            <span className="text-micro text-ink-muted">Factura que afecta</span>
            <input value={f.invoiceNumber} onChange={(e) => set('invoiceNumber', e.target.value)} disabled={!editable} className={clsx(INPUT, 'w-36')} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-micro text-ink-muted">Fecha</span>
            <input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} disabled={!editable} className={INPUT} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-micro text-ink-muted">Motivo (DIAN)</span>
            <select value={f.reason} onChange={(e) => set('reason', e.target.value)} disabled={!editable} className={INPUT}>
              {REASONS.map(([n, t]) => (
                <option key={n} value={n}>
                  {n} · {t}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[260px] flex-1 flex-col gap-0.5">
            <span className="text-micro text-ink-muted">Observaciones</span>
            <input value={f.observations} onChange={(e) => set('observations', e.target.value)} disabled={!editable} className={clsx(INPUT, 'w-full')} />
          </label>
          <span className="self-end text-ink-muted">
            {p.mode === 'total' ? 'Copia todas las líneas de la factura.' : `${(p.items as unknown[] | undefined)?.length ?? 0} línea(s) propias.`}
          </span>
        </div>
      )}
      {msg && (
        <p role="status" className={clsx('text-xs', msg.ok ? 'text-emerald' : 'text-rose')}>
          {msg.text}
        </p>
      )}
      {editable && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <button type="button" className={BTN} disabled={pending || !dirty} onClick={() => run(save)}>
            Guardar cambios
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={pending || dirty || d.problems.length > 0}
            title={dirty ? 'Guarda los cambios primero' : d.problems.length ? 'Falta algo: mira lo marcado arriba' : undefined}
            onClick={() => {
              const what =
                d.kind === 'customer'
                  ? 'Se creará el cliente en Siigo si no existe (nunca se pisa uno existente).'
                  : d.kind === 'receipt'
                    ? 'Se registrará el recibo de caja en Siigo contra esas facturas.'
                    : 'Se creará la nota crédito en Siigo SIN enviarla a la DIAN (la envías desde Siigo).';
              if (window.confirm(`${what} ¿Aprobar?`)) run(() => approveDraftAction(d.id, false));
            }}
          >
            {isNote ? 'Aprobar y crear en Siigo (sin enviar a la DIAN)' : 'Aprobar y enviar a Siigo'}
          </button>
          {isNote && (
            <button
              type="button"
              className={BTN}
              disabled={pending || dirty || d.problems.length > 0}
              onClick={() => {
                if (window.confirm('Se creará la nota crédito en Siigo Y SE ENVIARÁ A LA DIAN. Un documento electrónico enviado no se borra. ¿Aprobar y enviar?'))
                  run(() => approveDraftAction(d.id, true));
              }}
            >
              Aprobar y enviar a la DIAN
            </button>
          )}
          <button
            type="button"
            className={clsx(BTN, 'ml-auto text-rose')}
            disabled={pending}
            onClick={() => {
              if (window.confirm('¿Descartar este borrador? No se enviará nada a Siigo y esa fila no generará otro.')) run(() => discardDraftAction(d.id));
            }}
          >
            Descartar
          </button>
        </footer>
      )}
    </article>
  );
}
