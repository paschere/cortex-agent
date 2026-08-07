'use client';

import { Button } from '@/components/ui/button';
import { useState } from 'react';

/**
 * "Quiero este plan."
 *
 * Deliberately not a checkout. Nothing in this product collects money yet —
 * see the billing note in packages/agent-tools/src/billing/plans.ts for why a
 * gateway integration written before the price and the collection method are
 * decided is work that gets thrown away.
 *
 * What this does instead is the honest minimum: it writes the request into the
 * workspace's own audit log, with who asked and when, so a blocked customer has
 * an action to take and there is a record of it on both sides. When a gateway
 * exists, this button changes and nothing else has to.
 *
 * Imports nothing from `@cortex/agent-tools`: this is a `'use client'` module,
 * and that barrel drags `node:dns` into the browser bundle. See
 * lib/plan-shape.ts.
 */
export function PlanInterest({ planCode, planName }: { planCode: string; planName: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  async function ask() {
    setState('sending');
    try {
      const res = await fetch('/api/plan/interest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planCode }),
      });
      setState(res.ok ? 'sent' : 'failed');
    } catch {
      setState('failed');
    }
  }

  if (state === 'sent') {
    return (
      <p className="mt-3 text-[12px] font-semibold text-emerald">
        Anotado. Te buscamos para activar {planName}.
      </p>
    );
  }

  return (
    <div className="mt-3">
      <Button
        type="button"
        variant="outline"
        onClick={ask}
        disabled={state === 'sending'}
        className="w-full py-2"
      >
        {state === 'sending' ? 'Anotando…' : `Quiero ${planName}`}
      </Button>
      {state === 'failed' && (
        <p className="mt-2 text-[12px] text-rose">
          No se pudo anotar. Vuelve a intentarlo en un momento.
        </p>
      )}
    </div>
  );
}
