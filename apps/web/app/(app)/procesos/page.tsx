import { ProcessesPanel } from '@/app/(app)/dashboard/_components/ProcessesPanel';
import { ProcessCatalog } from '@/components/self-service/ProcessCatalog';
import { PageHeader } from '@/components/ui/page-header';
import { modulesOffFor } from '@/lib/modules/server';
import { requireSession } from '@/lib/session';
import { Sparkles } from 'lucide-react';
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
  // Los procesos de un módulo apagado (0186) no se ofrecen.
  const modulesOff = await modulesOffFor(user.organization.id);
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 pb-10">
      {/* La misma cabecera que el resto de pantallas: Procesos es una puerta
          principal y no puede verse más chica que Pagos o Aprobaciones. */}
      <div className="-mb-6">
        <PageHeader
          title="Procesos"
          subtitle="Lo que Cortex hace solo, sin que se lo pidas. Activa uno listo o describe el tuyo: Cortex pregunta lo justo y queda andando. Los que corren a una hora fija se llaman rutinas."
          icon={<Sparkles className="h-5 w-5" aria-hidden />}
        />
      </div>

      <Suspense fallback={null}>
        <ProcessesPanel organizationId={user.organization.id} userId={user.id} />
      </Suspense>

      <section aria-labelledby="listos" className="flex flex-col gap-4">
        <h2 id="listos" className="text-lg font-extrabold tracking-tight text-ink">
          Listos para activar
        </h2>
        <ProcessCatalog modulesOff={modulesOff} />
      </section>
    </div>
  );
}
