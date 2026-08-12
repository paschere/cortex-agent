import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { Globe } from 'lucide-react';
import { Surface } from './_components/Surface';

/**
 * Trámites web — hacer vueltas en portales ajenos.
 *
 * WHAT THIS SCREEN IS FOR. Half of what an administrator in a Colombian
 * logistics company does all day is somebody else's website: the RUNT, the
 * SIMIT, the DIAN, the chamber of commerce, a customer's supplier portal. None
 * of them has an API worth the name. Cortex could always answer questions about
 * that work and never do any of it.
 *
 * The shape of the answer is on this page: a person does the errand ONCE while
 * sharing the tab, and from the second time on Cortex repeats it in seconds
 * with no model in the loop. What the screen has to make unmissable is which
 * trámites have actually been proven to reproduce (PROBADO) and which are still
 * a reading of a recording (PROPUESTO) — because the day somebody schedules one
 * to run unattended, that is the only distinction that matters.
 *
 * Everything is read through the workspace-scoped handle inside the API routes;
 * nothing on this page filters by organization by hand.
 */

export const dynamic = 'force-dynamic';

export default async function BrowserFlowsPage() {
  await requireSession();

  return (
    <>
      <PageHeader
        title="Trámites web"
        subtitle="Vueltas en portales ajenos: sacar un certificado, consultar un estado, radicar una solicitud. Se enseñan una vez grabando la pestaña, y de ahí en adelante Cortex las repite en segundos, sin modelo y sin costo."
        icon={<Globe className="h-5 w-5" />}
      />
      <Surface />
    </>
  );
}
