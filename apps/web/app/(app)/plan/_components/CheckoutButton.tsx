'use client';

import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { checkoutPlan } from '../actions';

/**
 * «Pagar»: pide al servidor el checkout firmado y manda al pagador a la
 * pasarela. El monto lo calcula el servidor; aquí sólo viaja el código del plan.
 *
 * Si la pasarela no está configurada, el servidor responde «Pronto podrás pagar
 * aquí; escríbenos» y eso es lo que se ve — nunca un botón que finge.
 */
export function CheckoutButton({
  planCode,
  label,
  variant = 'primary',
}: {
  planCode: string;
  label: string;
  variant?: 'primary' | 'outline';
}) {
  const [state, setState] = useState<'idle' | 'opening' | 'failed'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function pay() {
    setState('opening');
    setMessage(null);
    try {
      const result = await checkoutPlan(planCode);
      if (result.ok) {
        window.location.href = result.url;
        return;
      }
      setMessage(result.message);
      setState('failed');
    } catch {
      setMessage('No se pudo abrir el pago. Inténtalo de nuevo en un momento.');
      setState('failed');
    }
  }

  return (
    <div className="mt-3">
      <Button
        type="button"
        variant={variant === 'outline' ? 'outline' : 'default'}
        onClick={pay}
        disabled={state === 'opening'}
        className="w-full py-2"
      >
        {state === 'opening' ? 'Abriendo el pago…' : label}
      </Button>
      {message && <p className="mt-2 text-xs leading-relaxed text-ink-muted">{message}</p>}
    </div>
  );
}
