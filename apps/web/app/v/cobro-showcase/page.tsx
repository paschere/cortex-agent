import { BillingPanel } from '@/app/(app)/plan/_components/BillingPanel';
import { AuthExperience } from '@/app/(auth)/_components/AuthExperience';
import { AccessRequestForm } from '@/app/(auth)/acceso/AccessRequestForm';
import { SignupForm } from '@/app/(auth)/signup/SignupForm';
import { BillingBannerView } from '@/components/billing/BillingBanner';
import { type BillingAccessView, billingHeadline } from '@/lib/billing/billing-shape';
import type { PaymentRow } from '@/lib/billing/ledger';
import { notFound } from 'next/navigation';

/**
 * EL COBRO CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /plan y /acceso dependen de la sesión y de SIGNUP_MODE; aquí se pintan los
 * mismos componentes sin base de datos para mirarlos. Vive bajo `/v` porque el
 * prefijo ya es público (como /v/centro-de-mando).
 *
 *   ?vista=plan      la franja y el panel «Pago del plan» (por defecto)
 *   ?vista=acceso    el formulario «Pide tu acceso»
 *   ?vista=registro  /signup en modo abierto
 *   ?estado=prueba|lectura|aldia|cancelado|sinpasarela
 *
 * En producción responde 404.
 */
export const dynamic = 'force-dynamic';

const DAY = 86_400_000;
const now = Date.now();
const iso = (days: number) => new Date(now + days * DAY).toISOString();

const PAYMENTS: PaymentRow[] = [
  {
    id: 'p3',
    organization_id: 'demo',
    plan_code: 'team',
    reference: 'CTX-7KQ2M9XA-PL4R8TZE',
    amount_cop: 150000,
    currency: 'COP',
    seats: 5,
    months: 1,
    status: 'pending',
    provider: 'wompi',
    provider_tx_id: null,
    payment_method: null,
    checkout_url: 'https://checkout.wompi.co/p/?reference=demo',
    period_start: null,
    period_end: null,
    status_note: null,
    paid_at: null,
    created_at: iso(-1),
  },
  {
    id: 'p2',
    organization_id: 'demo',
    plan_code: 'team',
    reference: 'CTX-H3D9W2NB-QY6C5VJU',
    amount_cop: 150000,
    currency: 'COP',
    seats: 5,
    months: 1,
    status: 'approved',
    provider: 'wompi',
    provider_tx_id: '1234-1700000000-11111',
    payment_method: 'PSE',
    checkout_url: null,
    period_start: iso(-20),
    period_end: iso(10),
    status_note: null,
    paid_at: iso(-20),
    created_at: iso(-20),
  },
  {
    id: 'p1',
    organization_id: 'demo',
    plan_code: 'team',
    reference: 'CTX-Z8B4N6TP-MK2X7RCA',
    amount_cop: 150000,
    currency: 'COP',
    seats: 5,
    months: 1,
    status: 'declined',
    provider: 'wompi',
    provider_tx_id: '1234-1699990000-22222',
    payment_method: 'CARD',
    checkout_url: null,
    period_start: null,
    period_end: null,
    status_note: null,
    paid_at: null,
    created_at: iso(-21),
  },
];

const VIEWS: Record<string, BillingAccessView> = {
  prueba: { status: 'trialing', access: 'full', reason: 'trial', endsAt: iso(3), daysLeft: 3 },
  lectura: {
    status: 'grace',
    access: 'read_only',
    reason: 'trial_ended',
    endsAt: null,
    daysLeft: null,
  },
  aldia: { status: 'active', access: 'full', reason: 'paid', endsAt: iso(10), daysLeft: 10 },
  cancelado: {
    status: 'canceled',
    access: 'full',
    reason: 'canceling',
    endsAt: iso(10),
    daysLeft: 10,
  },
};

export default async function CobroShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const vista = one('vista') ?? 'plan';

  if (vista === 'acceso') {
    return (
      <AuthExperience>
        <AccessRequestForm />
      </AuthExperience>
    );
  }
  if (vista === 'registro') {
    return (
      <AuthExperience>
        <SignupForm
          mode="open"
          needsCode={false}
          trialDays={14}
          defaultPlan="team"
          consent={null}
        />
      </AuthExperience>
    );
  }

  const estado = one('estado') ?? 'prueba';
  const view = VIEWS[estado] ?? VIEWS.prueba;
  const headline = view ? billingHeadline(view, 'Equipo') : null;
  return (
    <div className="min-h-screen bg-canvas">
      {headline && <BillingBannerView headline={headline} href="#" />}
      <div className="mx-auto w-full max-w-[960px] space-y-5 px-4 py-6 md:px-8 md:py-8">
        <BillingPanel
          view={view ?? null}
          planName="Equipo"
          planCode="team"
          purchasable
          checkoutReady={estado !== 'sinpasarela'}
          canManage
          hasSubscription
          canceling={view?.reason === 'canceling'}
          payments={estado === 'prueba' ? [] : PAYMENTS}
          amountCop={150000}
        />
      </div>
    </div>
  );
}
