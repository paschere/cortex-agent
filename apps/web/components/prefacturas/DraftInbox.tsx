'use client';

import {
  approveDraftAction,
  discardDraftAction,
  saveDraftAction,
} from '@/app/(app)/prefacturas/actions';
import { clsx } from 'clsx';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * LA BANDEJA: una tarjeta por prefactura con sus líneas editables. Los dos
 * botones de aprobar dicen con todas sus letras qué pasa con la DIAN; el
 * principal es el seguro (queda en Siigo sin enviar).
 */

interface Line {
  description: string;
  productCode: string | null;
  quantity: number;
  unitPrice: number;
  taxRate: 'iva_19' | 'iva_5' | 'iva_0' | 'excluido';
  unit: string | null;
  discountPct: number;
  sourceUnitPrice?: number;
}

export interface DraftView {
  id: string;
  row_label: string;
  status: 'pending' | 'creating' | 'created' | 'discarded' | 'error';
  customer_tax_id: string | null;
  customer_name: string;
  currency: string;
  trm: number | null;
  lines: Line[];
  observations: string;
  payment_form: 'contado' | 'credito';
  payment_days: number;
  total: number;
  provider_number: string | null;
  provider_invoice_id: string | null;
  sent_to_dian: boolean | null;
  error: string | null;
  created_at: string;
}

const PESOS = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});
const TAX = [
  { id: 'iva_19', label: 'IVA 19 %' },
  { id: 'iva_5', label: 'IVA 5 %' },
  { id: 'iva_0', label: 'IVA 0 %' },
  { id: 'excluido', label: 'Excluido' },
];
const STATUS: Record<DraftView['status'], { text: string; tone: string }> = {
  pending: { text: 'Por revisar', tone: 'bg-amber-soft text-amber' },
  error: { text: 'Con error', tone: 'bg-rose-soft text-rose' },
  creating: { text: 'Creándose en Siigo', tone: 'bg-amber-soft text-amber' },
  created: { text: 'Creada en Siigo', tone: 'bg-emerald-soft text-emerald' },
  discarded: { text: 'Descartada', tone: 'bg-surface-2 text-ink-muted' },
};
const INPUT =
  'rounded-card border border-border bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-primary';
const BTN =
  'rounded-card px-3 py-1.5 text-xs font-semibold disabled:opacity-50 border border-border text-ink hover:bg-surface-2';
const BTN_PRIMARY =
  'rounded-card px-3 py-1.5 text-xs font-semibold disabled:opacity-50 bg-primary text-white hover:opacity-90';

function Card({ d, focus }: { d: DraftView; focus: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [lines, setLines] = useState<Line[]>(d.lines);
  const [obs, setObs] = useState(d.observations);
  const [nit, setNit] = useState(d.customer_tax_id ?? '');
  const [name, setName] = useState(d.customer_name);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const editable = d.status === 'pending' || d.status === 'error';
  const dirty =
    JSON.stringify(lines) !== JSON.stringify(d.lines) ||
    obs !== d.observations ||
    nit !== (d.customer_tax_id ?? '') ||
    name !== d.customer_name;
  const setLine = (i: number, p: Partial<Line>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const run = (fn: () => Promise<{ ok: boolean; note?: string; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.note ?? 'Listo.') : (r.error ?? 'No se pudo.') });
      router.refresh();
    });
  const save = () =>
    saveDraftAction(d.id, {
      customerTaxId: nit,
      customerName: name,
      observations: obs,
      lines: lines.map((l) => ({
        description: l.description,
        productCode: l.productCode,
        quantity: Number(l.quantity),
        unitPrice: Number(l.unitPrice),
        taxRate: l.taxRate,
        unit: l.unit,
        discountPct: l.discountPct,
      })),
    });
  const status = STATUS[d.status];
  const missingCode = lines.some((l) => !l.productCode);

  return (
    <article
      id={`prefactura-${d.id}`}
      className={clsx(
        'space-y-3 rounded-card border bg-surface p-4',
        focus ? 'border-primary' : 'border-border',
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-bold text-ink">
          {d.customer_name || `NIT ${d.customer_tax_id ?? '—'}`}
        </h3>
        <span className={clsx('rounded-pill px-2 py-0.5 text-micro font-semibold', status.tone)}>
          {status.text}
        </span>
        {d.row_label && <span className="text-xs text-ink-muted">de «{d.row_label}»</span>}
        <span className="ml-auto text-sm font-semibold tabular-nums text-ink">
          {PESOS.format(d.total)} <span className="text-micro font-normal text-ink-muted">con IVA, estimado</span>
        </span>
      </header>
      {d.error && <p className="rounded-sm bg-rose-soft px-3 py-2 text-xs text-rose">{d.error}</p>}
      {d.status === 'created' && (
        <p className="text-xs text-ink">
          Factura <strong>{d.provider_number ?? d.provider_invoice_id}</strong> en Siigo
          {d.sent_to_dian ? ', enviada a la DIAN.' : ', sin enviar a la DIAN (se envía desde Siigo).'}
        </p>
      )}
      <div className="flex flex-wrap gap-2 text-xs text-ink">
        <label className="flex items-center gap-1">
          NIT
          <input value={nit} onChange={(e) => setNit(e.target.value)} disabled={!editable} className={clsx(INPUT, 'w-32')} />
        </label>
        <label className="flex items-center gap-1">
          Cliente
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} className={clsx(INPUT, 'w-56')} />
        </label>
        {d.currency !== 'COP' && d.trm && (
          <span className="self-center text-ink-muted">
            Precios de {d.currency} pasados a pesos con TRM {d.trm}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-ink-muted">
              <th className="py-1 pr-2 font-semibold">Descripción</th>
              <th className="px-2 font-semibold">Código Siigo</th>
              <th className="px-2 text-right font-semibold">Cantidad</th>
              <th className="px-2 text-right font-semibold">Precio (COP)</th>
              <th className="px-2 font-semibold">IVA</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: líneas sin id propio
              <tr key={i} className="border-t border-border/60">
                <td className="py-1 pr-2">
                  <input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} disabled={!editable} className={clsx(INPUT, 'w-full min-w-[220px]')} />
                </td>
                <td className="px-2">
                  <input value={l.productCode ?? ''} onChange={(e) => setLine(i, { productCode: e.target.value })} disabled={!editable} placeholder="falta" className={clsx(INPUT, 'w-28', !l.productCode && editable && 'border-amber')} />
                </td>
                <td className="px-2">
                  <input type="number" step="any" value={l.quantity} onChange={(e) => setLine(i, { quantity: Number(e.target.value) })} disabled={!editable} className={clsx(INPUT, 'w-24 text-right')} />
                </td>
                <td className="px-2">
                  <input type="number" step="any" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) })} disabled={!editable} className={clsx(INPUT, 'w-28 text-right')} />
                </td>
                <td className="px-2">
                  <select value={l.taxRate} onChange={(e) => setLine(i, { taxRate: e.target.value as Line['taxRate'] })} disabled={!editable} className={INPUT}>
                    {TAX.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <textarea value={obs} onChange={(e) => setObs(e.target.value)} disabled={!editable} rows={2} placeholder="Observaciones de la factura" className={clsx(INPUT, 'w-full')} />
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
            disabled={pending || dirty || missingCode}
            title={dirty ? 'Guarda los cambios primero' : missingCode ? 'Falta el código de Siigo de una línea' : undefined}
            onClick={() => {
              if (window.confirm('Se creará la factura en Siigo SIN enviarla a la DIAN (la envías desde Siigo). ¿Aprobar?'))
                run(() => approveDraftAction(d.id, false));
            }}
          >
            Aprobar y crear en Siigo (sin enviar a la DIAN)
          </button>
          <button
            type="button"
            className={BTN}
            disabled={pending || dirty || missingCode}
            onClick={() => {
              if (window.confirm('Se creará la factura en Siigo Y SE ENVIARÁ A LA DIAN. Una factura electrónica enviada no se borra. ¿Aprobar y enviar?'))
                run(() => approveDraftAction(d.id, true));
            }}
          >
            Aprobar y enviar a la DIAN
          </button>
          <button
            type="button"
            className={clsx(BTN, 'ml-auto text-rose')}
            disabled={pending}
            onClick={() => {
              if (window.confirm('¿Descartar esta prefactura? No se creará nada en Siigo y esa fila no generará otra.'))
                run(() => discardDraftAction(d.id));
            }}
          >
            Descartar
          </button>
        </footer>
      )}
    </article>
  );
}

export function DraftInbox({
  open,
  done,
  focusId,
}: {
  open: DraftView[];
  done: DraftView[];
  focusId: string | null;
}) {
  return (
    <div className="space-y-4">
      {open.length === 0 ? (
        <p className="rounded-card border border-dashed border-border px-4 py-8 text-center text-sm text-ink-muted">
          No hay prefacturas por revisar. Cuando una regla de una app cierre una atención y arme una, aparece aquí.
        </p>
      ) : (
        open.map((d) => <Card key={`${d.id}:${d.created_at}:${d.total}`} d={d} focus={d.id === focusId} />)
      )}
      {done.length > 0 && (
        <details className="space-y-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink-muted">
            Ya resueltas ({done.length})
          </summary>
          <div className="mt-3 space-y-3">
            {done.map((d) => (
              <Card key={d.id} d={d} focus={false} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
