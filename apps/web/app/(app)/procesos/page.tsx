import { ProcessesPanel } from '@/app/(app)/dashboard/_components/ProcessesPanel';
import { ProcessCatalog } from '@/components/self-service/ProcessCatalog';
import { requireSession } from '@/lib/session';
import { Suspense } from 'react';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Procesos · Cortex' };

/**
 * PROCESOS: LO QUE CORTEX HACE SOLO, Y LO QUE PUEDE EMPEZAR A HACER.
 *
 * Arriba, lo que ya está andando (carpetas que llenan tablas, sincronizaciones,
 * rutinas) con su estado; abajo, el catálogo de procesos listos para activar.
 * Las dos mitades salen de las mismas piezas que usan el Inicio y los primeros
 * 10 minutos, así que las tres pantallas dicen lo mismo con las mismas palabras.
 */
export default async function ProcessesPage() {
  const user = await requireSession();
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 pb-10">
      <header>
        <h1 className="text-balance text-2xl font-extrabold leading-tight tracking-tight text-ink sm:text-3xl">
          Procesos
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted sm:text-base">
          Lo que Cortex hace solo, sin que se lo pidas. Activa uno listo o describe el tuyo: Cortex
          pregunta lo justo y queda andando.
        </p>
      </header>

      <Suspense fallback={null}>
        <ProcessesPanel organizationId={user.organization.id} userId={user.id} />
      </Suspense>

      <section aria-labelledby="listos" className="flex flex-col gap-4">
        <h2 id="listos" className="text-lg font-extrabold tracking-tight text-ink">
          Listos para activar
        </h2>
        <ProcessCatalog />
      </section>
    </div>
  );
}
