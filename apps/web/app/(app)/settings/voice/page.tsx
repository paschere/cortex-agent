import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { Mic2 } from 'lucide-react';
import { VoiceSettings } from './VoiceSettings';

export const dynamic = 'force-dynamic';

export default async function VoiceSettingsPage() {
  const user = await requireSession();

  return (
    <>
      <PageHeader
        title="Voz de Cortex"
        subtitle={`La voz que escuchará el equipo de ${user.organization.name} en sus próximas llamadas`}
        icon={<Mic2 className="h-5 w-5" />}
      />
      <VoiceSettings
        key={user.organization.id}
        workspaceId={user.organization.id}
        workspaceName={user.organization.name}
      />
    </>
  );
}
