'use client';
import { Button } from '@/components/ui/button';
export default function ManagementError({ reset }: { reset: () => void }) {
  return (
    <div role="alert" className="space-y-4 p-6">
      <h1 className="text-xl font-bold">Gerencia no está disponible</h1>
      <p>
        No pudimos consultar los asuntos. Comprueba la conexión y que la migración 0130 esté
        aplicada.
      </p>
      <Button onClick={reset}>Intentar de nuevo</Button>
    </div>
  );
}
