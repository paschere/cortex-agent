import { type BillingAccessView, billingHeadline } from '@/lib/billing/billing-shape';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import { listPlans, readBillingAccess } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import Link from 'next/link';

/**
 * La franja del cobro sobre todas las pantallas: días de prueba, pago
 * pendiente, solo lectura. Lee la fila de `billing_subscriptions` (0187) de la
 * empresa en sesión.
 *
 * Sin fila (toda empresa anterior al cobro) no pinta nada. Si la lectura
 * falla, tampoco: una franja que se equivoca sobre el dinero es peor que
 * ninguna, y /plan sí muestra el error.
 */
export async function BillingBanner({ organizationId }: { organizationId: string }) {
  let headline: ReturnType<typeof billingHeadline> = null;
  try {
    const db = getOrgScopedClient(organizationId);
    const { subscription, access } = await readBillingAccess(db);
    if (!subscription) return null;
    const plans = await listPlans(db);
    const planName =
      plans.find((p) => p.code === subscription.planCode)?.name ?? subscription.planCode;
    headline = billingHeadline(access as BillingAccessView, planName);
  } catch {
    return null;
  }
  if (!headline) return null;
  return <BillingBannerView headline={headline} href={workspaceHref(organizationId, '/plan')} />;
}

/** La franja sin lecturas, para la vitrina de desarrollo. */
export function BillingBannerView({
  headline,
  href,
}: {
  headline: NonNullable<ReturnType<typeof billingHeadline>>;
  href: string;
}) {
  return (
    <output
      className={clsx(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-2 text-xs leading-relaxed md:px-8',
        headline.tone === 'rose'
          ? 'border-rose/20 bg-rose-soft text-rose'
          : headline.tone === 'amber'
            ? 'border-amber/20 bg-amber-soft text-ink'
            : 'border-primary/15 bg-primary-soft text-primary-ink',
      )}
    >
      <span>{headline.text}</span>
      <Link href={href} className="shrink-0 font-semibold underline-offset-2 hover:underline">
        Ver plan y pagar
      </Link>
    </output>
  );
}
