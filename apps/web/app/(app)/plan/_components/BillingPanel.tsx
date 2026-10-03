import { Panel, PanelHead } from '@/components/ui/panel';
import {
  BILLING_STATUS_LABEL,
  BILLING_STATUS_TONE,
  type BillingAccessView,
  PAYMENT_STATUS_LABEL,
  PAYMENT_STATUS_TONE,
  billingDate,
  billingHeadline,
} from '@/lib/billing/billing-shape';
import type { PaymentRow } from '@/lib/billing/ledger';
import { cop, count, stamp } from '@/lib/plan-shape';
import { chipClass } from '@/lib/status-chip';
import { CreditCard } from 'lucide-react';
import { BillingControls } from './BillingControls';
import { CheckoutButton } from './CheckoutButton';

/** Lo que se le dice a quien pulsa «Pagar» sin pasarela. Igual que lib/billing/checkout.ts. */
const CHECKOUT_UNAVAILABLE =
  'Pronto podrás pagar aquí; escríbenos y lo activamos contigo mientras tanto.';

/**
 * Pago y estado: en prueba / al día / pendiente / solo lectura, qué hacer, y la
 * lista de pagos con su referencia. Los recibos son la lista misma: cada pago
 * aprobado dice cuánto, cuándo, con qué medio y qué período cubrió.
 */
export function BillingPanel({
  view,
  planName,
  planCode,
  purchasable,
  checkoutReady,
  canManage,
  hasSubscription,
  canceling,
  payments,
  amountCop,
}: {
  view: BillingAccessView | null;
  planName: string;
  planCode: string;
  purchasable: boolean;
  checkoutReady: boolean;
  canManage: boolean;
  hasSubscription: boolean;
  canceling: boolean;
  payments: PaymentRow[] | null;
  amountCop: number;
}) {
  const status = view?.status ?? 'legacy';
  const headline = view ? billingHeadline(view, planName) : null;
  const payLabel =
    status === 'active' ? `Pagar el próximo mes · ${cop(amountCop)}` : `Pagar ${cop(amountCop)}`;
  return (
    <Panel>
      <PanelHead
        title="Pago del plan"
        icon={<CreditCard className="h-4 w-4" />}
        right={
          <span className={chipClass(BILLING_STATUS_TONE[status])}>
            {BILLING_STATUS_LABEL[status]}
          </span>
        }
      />
      <div className="space-y-3 px-5 pb-5 pt-3">
        {view === null && (
          <p className="text-xs text-rose">
            No se pudo leer el estado del pago. Recarga en un momento; nada cambió en tu espacio.
          </p>
        )}
        {headline && <p className="text-sm leading-relaxed text-ink">{headline.text}</p>}
        {view?.endsAt && (view.status === 'active' || view.status === 'trialing') && (
          <p className="tabular text-xs text-ink-muted">
            {view.status === 'trialing' ? 'La prueba termina el ' : 'Pagado hasta el '}
            {billingDate(view.endsAt)}.
          </p>
        )}

        {purchasable && canManage && checkoutReady && !canceling && (
          <div className="max-w-xs">
            <CheckoutButton planCode={planCode} label={payLabel} />
          </div>
        )}
        {purchasable && canManage && !checkoutReady && (
          <p className="rounded-sm border border-border bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-ink-muted">
            {CHECKOUT_UNAVAILABLE}
          </p>
        )}
        {purchasable && !canManage && (
          <p className="text-xs text-ink-muted">El pago lo hace quien administra el espacio.</p>
        )}
        {hasSubscription && canManage && view?.access !== 'read_only' && (
          <BillingControls canceling={canceling} />
        )}
      </div>

      <div className="border-t border-border">
        <div className="px-5 pb-1 pt-3 text-xs font-semibold text-ink-muted">Pagos y recibos</div>
        {payments === null ? (
          <p className="px-5 pb-4 text-xs text-rose">No se pudo leer la lista de pagos.</p>
        ) : payments.length === 0 ? (
          <p className="px-5 pb-4 text-xs text-ink-faint">Todavía no hay pagos en este espacio.</p>
        ) : (
          <ul className="divide-y divide-border">
            {payments.map((payment) => (
              <li key={payment.id} className="px-5 py-2.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="tabular shrink-0 text-xs text-ink-faint sm:w-[120px]">
                    {stamp(payment.paid_at ?? payment.created_at)}
                  </span>
                  <span className="min-w-0 flex-1 basis-[12rem] text-sm text-ink">
                    Plan {payment.plan_code === planCode ? planName : payment.plan_code}
                    {payment.seats ? ` · ${count(payment.seats)} personas` : ''}
                    {payment.period_end ? (
                      <span className="text-xs text-ink-faint">
                        {' '}
                        · hasta el {billingDate(payment.period_end)}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular text-sm text-ink">{cop(payment.amount_cop)}</span>
                    <span className={chipClass(PAYMENT_STATUS_TONE[payment.status] ?? 'neutral')}>
                      {PAYMENT_STATUS_LABEL[payment.status] ?? payment.status}
                    </span>
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 sm:pl-[132px]">
                  <span className="font-mono text-micro text-ink-faint">
                    {payment.reference}
                    {payment.payment_method ? ` · ${payment.payment_method}` : ''}
                  </span>
                  {payment.status === 'pending' && payment.checkout_url && canManage && (
                    <a
                      href={payment.checkout_url}
                      className="text-xs font-semibold text-primary hover:underline"
                    >
                      Terminar pago
                    </a>
                  )}
                  {payment.status_note && (
                    <span className="w-full text-xs text-rose">{payment.status_note}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
