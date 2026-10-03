'use client';

import { Button } from '@/components/ui/button';
import { Panel, PanelHead } from '@/components/ui/panel';
import { type ActionResult, PO_STEPS, type PoDetailView } from '@/lib/inventory/shape';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Download,
  History,
  LoaderCircle,
  PackageCheck,
  Send,
  ShoppingCart,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { FIELD, Feedback, Modal, NUMBER_FIELD, readNumber } from './parts';

/**
 * El detalle de una orden de compra: dónde va (borrador → facturada), qué se
 * pidió y qué llegó, y los botones del paso siguiente. Aprobar exige
 * administrar la empresa; enviar es la herramienta `purchasing.send_po` (el
 * mismo correo con PDF que sale desde el chat o desde Aprobaciones).
 */

export interface PoDetailHandlers {
  submit: (id: string) => Promise<ActionResult>;
  approve: (id: string) => Promise<ActionResult>;
  send: (id: string, to: string | null) => Promise<ActionResult>;
  receive: (
    id: string,
    quantities: Record<string, number>,
    locationId: string | null,
  ) => Promise<ActionResult>;
  cancel: (id: string, reason: string) => Promise<ActionResult>;
  editLines: (
    id: string,
    lines: Array<{ id: string; qty?: number; unitCost?: number; remove?: boolean }>,
  ) => Promise<ActionResult>;
}

export function PurchaseOrderDetail({
  view,
  handlers,
}: { view: PoDetailView; handlers: PoDetailHandlers }) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const [dialog, setDialog] = useState<'receive' | 'send' | 'cancel' | null>(null);
  const [editing, setEditing] = useState(false);

  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) {
        setDialog(null);
        setEditing(false);
        router.refresh();
      }
    });

  return (
    <div className="mx-auto max-w-[1240px] px-4 py-6 sm:px-6 sm:py-8">
      <Link
        href="/inventario?tab=ordenes"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted transition-colors duration-150 hover:text-ink motion-reduce:transition-none"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Órdenes de compra
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-card bg-primary-soft text-primary ring-1 ring-inset ring-primary/10">
            <ShoppingCart className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="tabular text-xl font-extrabold tracking-[-0.02em] text-ink sm:text-2xl">
                {view.label}
              </h1>
              <span className={chipClass(view.tone)}>{view.statusLabel}</span>
            </div>
            <p className="mt-1 text-sm font-semibold text-ink">{view.supplierName}</p>
            <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-muted">
              {view.supplierTaxId && <span className="tabular">NIT {view.supplierTaxId}</span>}
              <span>{view.supplierEmail ?? 'Sin correo del proveedor'}</span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={view.pdfHref}
            className="inline-flex min-h-10 items-center gap-2 rounded-pill border border-border-strong bg-surface px-4 text-sm font-bold text-ink hover:bg-surface-2"
          >
            <Download className="h-4 w-4" aria-hidden />
            PDF
          </a>
          {view.can.cancel && (
            <Button variant="ghost" onClick={() => setDialog('cancel')}>
              <XCircle className="h-4 w-4" aria-hidden />
              Cancelar
            </Button>
          )}
          {view.can.submit && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => run(() => handlers.submit(view.id))}
            >
              Pedir aprobación
            </Button>
          )}
          {view.can.approve && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => run(() => handlers.approve(view.id))}
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Aprobar
            </Button>
          )}
          {view.can.send && (
            <Button
              variant={view.can.receive ? 'outline' : 'default'}
              disabled={pending}
              onClick={() => setDialog('send')}
            >
              <Send className="h-4 w-4" aria-hidden />
              {view.status === 'borrador' || view.status === 'por_aprobar'
                ? 'Aprobar y enviar'
                : 'Enviar al proveedor'}
            </Button>
          )}
          {view.can.receive && (
            <Button disabled={pending} onClick={() => setDialog('receive')}>
              <PackageCheck className="h-4 w-4" aria-hidden />
              Recibir mercancía
            </Button>
          )}
        </div>
      </div>

      <Stepper step={view.step} />
      <div className="mt-3">
        <Feedback result={result} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Panel className="overflow-hidden">
          <PanelHead
            title="Productos"
            right={
              view.can.edit && !editing ? (
                <button
                  type="button"
                  className="font-bold text-primary hover:text-primary-strong"
                  onClick={() => setEditing(true)}
                >
                  Editar cantidades
                </button>
              ) : undefined
            }
          />
          {editing ? (
            <EditLines
              view={view}
              pending={pending}
              onCancel={() => setEditing(false)}
              onSave={(lines) => run(() => handlers.editLines(view.id, lines))}
            />
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead className="border-y border-border bg-surface-2/60 text-left text-xs font-semibold text-ink-muted">
                <tr>
                  <th className="px-6 py-2.5">Descripción</th>
                  <th className="px-3 py-2.5 text-right">Pedido</th>
                  <th className="hidden px-3 py-2.5 text-right sm:table-cell">Llegó</th>
                  <th className="hidden px-3 py-2.5 text-right md:table-cell">Costo</th>
                  <th className="px-6 py-2.5 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {view.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-6 py-2.5">
                      {l.productHref ? (
                        <Link
                          href={l.productHref}
                          className="font-medium text-ink hover:text-primary"
                        >
                          {l.description}
                        </Link>
                      ) : (
                        <span className="font-medium text-ink">{l.description}</span>
                      )}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right text-ink">{l.qtyLabel}</td>
                    <td className="hidden px-3 py-2.5 text-right sm:table-cell">
                      <span
                        className={clsx(
                          'tabular inline-flex items-center gap-1',
                          l.done ? 'text-emerald' : 'text-ink-muted',
                        )}
                      >
                        {l.done && <Check className="h-3.5 w-3.5" aria-hidden />}
                        {l.receivedLabel}
                      </span>
                    </td>
                    <td className="tabular hidden px-3 py-2.5 text-right text-ink-muted md:table-cell">
                      {l.costLabel}
                    </td>
                    <td className="tabular px-6 py-2.5 text-right font-semibold text-ink">
                      {l.totalLabel}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <dl className="ml-auto max-w-xs space-y-1.5 px-6 py-4 text-sm">
            <div className="flex justify-between text-ink-muted">
              <dt>Subtotal</dt>
              <dd className="tabular">{view.totals.subtotal}</dd>
            </div>
            {view.totals.tax && (
              <div className="flex justify-between text-ink-muted">
                <dt>IVA</dt>
                <dd className="tabular">{view.totals.tax}</dd>
              </div>
            )}
            <div className="flex justify-between border-t border-border pt-2 text-base font-bold text-ink">
              <dt>Total</dt>
              <dd className="stat-num">{view.totals.total}</dd>
            </div>
          </dl>
          {view.notes && (
            <p className="border-t border-border px-6 py-3 text-xs leading-relaxed text-ink-muted">
              {view.notes}
            </p>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel>
            <PanelHead title="Entrega y pago" />
            <dl className="space-y-2.5 px-6 pb-5 pt-3 text-sm">
              {view.facts.map((f) => (
                <div key={f.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-ink-muted">{f.label}</dt>
                  <dd className="text-right font-semibold text-ink">{f.value}</dd>
                </div>
              ))}
            </dl>
          </Panel>
          <Panel>
            <PanelHead icon={<History className="h-4 w-4" aria-hidden />} title="Historia" />
            <ol className="space-y-2.5 px-6 pb-5 pt-3">
              {view.history.map((h) => (
                <li
                  key={`${h.label}${h.when}`}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <span className="text-ink">{h.label}</span>
                  <span className="tabular shrink-0 text-xs text-ink-faint">{h.when}</span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>

      {dialog === 'receive' && (
        <ReceiveDialog
          view={view}
          pending={pending}
          result={result}
          onClose={() => setDialog(null)}
          onSubmit={(q, loc) => run(() => handlers.receive(view.id, q, loc))}
        />
      )}
      {dialog === 'send' && (
        <SendDialog
          view={view}
          pending={pending}
          result={result}
          onClose={() => setDialog(null)}
          onSubmit={(to) => run(() => handlers.send(view.id, to))}
        />
      )}
      {dialog === 'cancel' && (
        <CancelDialog
          pending={pending}
          result={result}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => run(() => handlers.cancel(view.id, reason))}
        />
      )}
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  if (step < 0)
    return (
      <p className="mt-5 rounded-sm bg-rose-soft px-4 py-2.5 text-sm font-semibold text-rose">
        Esta orden está cancelada.
      </p>
    );
  return (
    <ol className="mt-6 grid grid-cols-6 gap-1.5" aria-label="Avance de la orden">
      {PO_STEPS.map((s, i) => (
        <li key={s.id} className="min-w-0">
          <span
            className={clsx('block h-1.5 rounded-pill', i <= step ? 'bg-primary' : 'bg-surface-2')}
          />
          <span
            className={clsx(
              'mt-1.5 block truncate text-micro font-semibold',
              i === step ? 'text-ink' : i < step ? 'text-ink-muted' : 'text-ink-faint',
            )}
            aria-current={i === step ? 'step' : undefined}
          >
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function EditLines({
  view,
  pending,
  onCancel,
  onSave,
}: {
  view: PoDetailView;
  pending: boolean;
  onCancel: () => void;
  onSave: (lines: Array<{ id: string; qty?: number; remove?: boolean }>) => void;
}) {
  const [qty, setQty] = useState<Record<string, string>>(
    Object.fromEntries(view.lines.map((l) => [l.id, String(l.qty)])),
  );
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  return (
    <div className="mt-3 border-t border-border">
      <ul className="divide-y divide-border">
        {view.lines.map((l) => (
          <li
            key={l.id}
            className={clsx(
              'flex items-center gap-3 px-6 py-2.5',
              removed.has(l.id) && 'opacity-40',
            )}
          >
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{l.description}</span>
            <input
              inputMode="decimal"
              value={qty[l.id] ?? ''}
              disabled={removed.has(l.id)}
              onChange={(e) => setQty((p) => ({ ...p, [l.id]: e.target.value }))}
              aria-label={`Cantidad de ${l.description}`}
              className={clsx(NUMBER_FIELD, 'w-28')}
            />
            <button
              type="button"
              className="text-xs font-semibold text-rose hover:underline"
              onClick={() =>
                setRemoved((p) => {
                  const n = new Set(p);
                  n.has(l.id) ? n.delete(l.id) : n.add(l.id);
                  return n;
                })
              }
            >
              {removed.has(l.id) ? 'Volver' : 'Quitar'}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2 px-6 py-3">
        <Button variant="ghost" onClick={onCancel}>
          Descartar
        </Button>
        <Button
          disabled={pending}
          onClick={() =>
            onSave(
              view.lines.map((l) =>
                removed.has(l.id)
                  ? { id: l.id, remove: true }
                  : { id: l.id, qty: readNumber(qty[l.id] ?? '') ?? l.qty },
              ),
            )
          }
        >
          Guardar cambios
        </Button>
      </div>
    </div>
  );
}

function ReceiveDialog({
  view,
  pending,
  result,
  onClose,
  onSubmit,
}: {
  view: PoDetailView;
  pending: boolean;
  result: ActionResult | null;
  onClose: () => void;
  onSubmit: (quantities: Record<string, number>, locationId: string | null) => void;
}) {
  const open = view.lines.filter((l) => l.pending > 0);
  const [qty, setQty] = useState<Record<string, string>>(
    Object.fromEntries(open.map((l) => [l.id, String(l.pending)])),
  );
  const [locationId, setLocationId] = useState(
    view.defaultLocationId ?? view.locations[0]?.id ?? '',
  );
  return (
    <Modal
      title={`Recibir mercancía · ${view.label}`}
      subtitle="Escribe lo que llegó. Entra al inventario al costo de la orden y mueve el costo promedio; lo que falte queda pendiente."
      onClose={onClose}
      wide
    >
      <div className="space-y-4">
        <label className="flex max-w-xs flex-col gap-1 text-xs font-semibold text-ink-muted">
          Bodega
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className={FIELD}
          >
            {view.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <ul className="divide-y divide-border rounded-sm border border-border">
          {open.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{l.description}</p>
                <p className="text-xs text-ink-faint">
                  Pedido {l.qtyLabel} · llegó {l.receivedLabel} · faltan{' '}
                  {l.pending.toLocaleString('es-CO')}
                </p>
              </div>
              <input
                inputMode="decimal"
                value={qty[l.id] ?? ''}
                onChange={(e) => setQty((p) => ({ ...p, [l.id]: e.target.value }))}
                aria-label={`Recibido de ${l.description}`}
                className={clsx(NUMBER_FIELD, 'w-28')}
              />
            </li>
          ))}
        </ul>
        <Feedback result={result} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              onSubmit(
                Object.fromEntries(open.map((l) => [l.id, readNumber(qty[l.id] ?? '') ?? 0])),
                locationId || null,
              )
            }
          >
            {pending ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <PackageCheck className="h-4 w-4" aria-hidden />
            )}
            Registrar lo recibido
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SendDialog({
  view,
  pending,
  result,
  onClose,
  onSubmit,
}: {
  view: PoDetailView;
  pending: boolean;
  result: ActionResult | null;
  onClose: () => void;
  onSubmit: (to: string | null) => void;
}) {
  const [to, setTo] = useState(view.supplierEmail ?? '');
  const approving = view.status === 'borrador' || view.status === 'por_aprobar';
  return (
    <Modal
      title={approving ? `Aprobar y enviar ${view.label}` : `Enviar ${view.label}`}
      subtitle={`Sale un correo desde tu Gmail a ${view.supplierName} con el PDF de la orden (con la marca de la empresa) por ${view.totals.total}.${approving ? ' Al aprobarla, entra a la proyección de caja como compra comprometida.' : ''}`}
      onClose={onClose}
    >
      <div className="space-y-3">
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          Correo del proveedor
          <input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="compras@proveedor.com"
            className={FIELD}
          />
        </label>
        <Feedback result={result} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
          <Button
            disabled={pending || !to.includes('@')}
            onClick={() => onSubmit(to.trim() || null)}
          >
            {pending ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Send className="h-4 w-4" aria-hidden />
            )}
            {approving ? 'Aprobar y enviar' : 'Enviar'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CancelDialog({
  pending,
  result,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  result: ActionResult | null;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      title="Cancelar la orden"
      subtitle="Sale de la proyección de caja y su aprobación pendiente se retira. No se le avisa al proveedor."
      onClose={onClose}
    >
      <div className="space-y-3">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Motivo (opcional)"
          aria-label="Motivo"
          className={FIELD}
        />
        <Feedback result={result} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Volver
          </Button>
          <Button variant="danger" disabled={pending} onClick={() => onSubmit(reason)}>
            Cancelar orden
          </Button>
        </div>
      </div>
    </Modal>
  );
}
