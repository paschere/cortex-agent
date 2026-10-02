'use client';
import { Button } from '@/components/ui/button';
export default function ManagementError({ reset }: { reset: () => void }) {
  return (
    <div role="alert" className="space-y-4 p-6">
      <h1 className="text-xl font-bold">Gerencia no está disponible</h1>
      <p>
        No pudimos consultar los asuntos ahora mismo. Revisa tu conexión e inténtalo de nuevo; si
        sigue igual, cuéntaselo a Cortex en el chat para que quede registrado.
      </p>
      <Button onClick={reset}>Intentar de nuevo</Button>
    </div>
  );
}
