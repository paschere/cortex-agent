import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import type { SetupItem } from '@/lib/guided-setup-shape';
import { latestSession, listItems } from '@/lib/guided-setup/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import { GuidedSetup } from './_components/GuidedSetup';

export const dynamic = 'force-dynamic';

/**
 * /onboarding/entrevista — configurar el producto contándole cómo funciona la
 * empresa.
 *
 * ===========================================================================
 * CONVIVE CON /onboarding, NO LO REEMPLAZA
 * ===========================================================================
 * La guía de primeros pasos resuelve un problema distinto y lo resuelve bien:
 * el cerebro está vacío, y hasta que no entre una fuente y un documento, todo
 * lo que se le pregunte a Cortex se responde con "no tengo nada sobre eso".
 * Su arco — objetivo, fuente, conocimiento, primera respuesta, equipo — es
 * sobre DARLE DE DÓNDE RESPONDER, y su progreso se deriva de los datos.
 *
 * Esta pantalla resuelve el siguiente problema, el que aparece cuando el
 * anterior ya está resuelto: el producto puede hacer muchas cosas y nadie sabe
 * cuál configurar primero. Son dos preguntas distintas —«¿de dónde saca lo que
 * sabe?» y «¿qué debería estar haciendo por mí?»— y meterlas en la misma lista
 * las habría empeorado a las dos.
 *
 * Por eso la entrevista NO es un sexto paso de `readOnboarding`. Aquel estado
 * se deriva de los datos y no guarda casillas, y "hizo la entrevista" es
 * exactamente el tipo de casilla que esa función se niega, con razón, a tener.
 * Se entra desde un panel en /onboarding, después de la primera respuesta, que
 * es el momento en que la pregunta de esta pantalla empieza a tener sentido.
 */

export default async function EntrevistaPage({
  searchParams,
}: {
  searchParams: Promise<{ nueva?: string }>;
}) {
  const user = await requireSession();
  const sp = await searchParams;
  const db = getOrgScopedClient(user.organization.id);

  const fresh = sp.nueva === '1';
  const session = fresh ? null : await latestSession(db);
  const items: SetupItem[] = session ? await listItems(db, session.id) : [];

  const phase =
    session?.status === 'proposed' ? 'plan' : session?.status === 'applied' ? 'done' : 'talking';

  // Una sesión descartada no se continúa: se empieza otra. El hilo viejo se
  // queda guardado porque un plan rechazado entero es la señal más útil que
  // produce esta pantalla, pero no tiene por qué volver a la cara de nadie.
  const continuing = session && session.status !== 'discarded' ? session : null;

  const firstName = (user.name ?? '').trim().split(' ')[0] || 'Hola';

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Cuéntale cómo trabajan"
        subtitle="Hablas, Cortex pregunta lo que le falte, y al final te propone qué dejar configurado. Tú decides qué se crea."
        icon={<MessagesSquare className="h-4 w-4" />}
        actions={
          <Link
            href="/onboarding"
            className="text-[12.5px] font-semibold text-ink-muted hover:text-ink"
          >
            Primeros pasos
          </Link>
        }
      />

      <GuidedSetup
        sessionId={continuing?.id ?? null}
        phase={continuing ? phase : 'talking'}
        transcript={continuing?.transcript ?? []}
        askedCount={continuing?.askedCount ?? 0}
        summary={continuing?.summary ?? null}
        items={continuing ? items : []}
        handoffs={continuing?.handoffs ?? []}
        outOfScope={continuing?.outOfScope ?? []}
        firstName={firstName}
      />

      <Panel className="p-4">
        <p className="text-[12px] leading-relaxed text-ink-muted">
          Nada de lo que cuentes aquí sale de tu empresa, y nada se crea sin que lo apruebes en
          pantalla. Lo que se cree queda en su módulo de siempre y lo puedes deshacer.
        </p>
      </Panel>
    </div>
  );
}
