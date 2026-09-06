import { BrowserWorkspace } from '@/components/browser/BrowserWorkspace';
import { PageHeader } from '@/components/ui/page-header';
import { MODULE } from '@/lib/browser-shape';
import { requireSession } from '@/lib/session';
import { Globe } from 'lucide-react';
import { Surface } from './_components/Surface';

export const dynamic = 'force-dynamic';

export default async function BrowserFlowsPage() {
  await requireSession();

  return (
    <>
      {/* The subtitle says what this SCREEN is for. How a trámite is taught is
          explained where somebody is about to teach one, not three times over
          — it used to appear here, in the teaching panel and in the empty
          state, all within one viewport. */}
      <PageHeader
        title={MODULE.label}
        subtitle="Enseña trámites dentro de Cortex, revisa los pasos aprendidos y comprueba cuáles están listos para repetir."
        icon={<Globe className="h-5 w-5" />}
      />
      <BrowserWorkspace />
      <Surface />
    </>
  );
}
