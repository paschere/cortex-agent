import { PageHeader } from '@/components/ui/page-header';
import { loadPreferencesFor } from '@/lib/notifications/preferences';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { Bell } from 'lucide-react';
import { AvisosForm } from './AvisosForm';
import { savePreferencesAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function AvisosPage() {
  const user = await requireSession();
  const prefs = await loadPreferencesFor(getOrgScopedClient(user.organization.id), user.id);
  return (
    <>
      <PageHeader
        title="Avisos"
        subtitle="Elige qué te avisa Cortex, por dónde y a qué horas. Lo que apagues deja de llegarte; lo demás sigue como siempre."
        icon={<Bell className="h-5 w-5" />}
      />
      <AvisosForm initial={prefs} save={savePreferencesAction} />
    </>
  );
}
