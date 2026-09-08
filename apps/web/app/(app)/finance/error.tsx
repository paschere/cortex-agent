'use client';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { AlertTriangle } from 'lucide-react';

export default function FinanceError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Panel className="mx-auto max-w-2xl px-6 py-12 text-center">
      <AlertTriangle className="mx-auto h-6 w-6 text-amber" aria-hidden />
      <h1 className="mt-3 text-lg font-bold text-ink">No pudimos abrir Finanzas</h1>
      <p className="mt-2 text-sm text-ink-muted">
        La lectura falló antes de poder separar las cifras disponibles. Intenta cargarla otra vez.
      </p>
      <Button className="mt-5" onClick={reset}>
        Volver a intentar
      </Button>
    </Panel>
  );
}
