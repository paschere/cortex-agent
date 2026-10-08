import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { getWait } from '@cortex/agent-tools';
import { Globe } from 'lucide-react';
import { notFound } from 'next/navigation';
import { WaitResolver } from './WaitResolver';

export const dynamic = 'force-dynamic';

/** A donde llega el aviso de una automatización que se detuvo esperando a una persona. */
export default async function AutomationWaitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession();
  const wait = await getWait(getOrgScopedClient(session.organization.id), id);
  if (!wait || wait.notify_user_id !== session.id) notFound();
  return (
    <>
      <PageHeader
        title={`«${wait.flow_name}» necesita una persona`}
        subtitle="Una automatización consultaba un portal y se detuvo. Atiéndelo aquí y ella sigue sola."
        icon={<Globe className="h-5 w-5" />}
      />
      <WaitResolver waitId={wait.id} />
    </>
  );
}
