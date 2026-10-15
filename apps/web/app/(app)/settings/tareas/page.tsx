import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { loadIntakePrefs } from '@/lib/task-intake/create';
import { cortexAlias } from '@/lib/task-intake/shape';
import { getSyncState } from '@cortex/agent-tools';
import { Inbox } from 'lucide-react';
import { IntakeForm } from './IntakeForm';
import { saveIntakePrefsAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function TareasAjustesPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [prefs, state] = await Promise.all([
    loadIntakePrefs(db, user.id),
    getSyncState(db, user.id).catch(() => null),
  ]);
  const alias =
    (state?.emailAddress && cortexAlias(state.emailAddress)) || 'tu.correo+cortex@tudominio';
  return (
    <>
      <PageHeader
        title="Pedir tareas"
        subtitle="Mándale una tarea a Cortex desde tu correo o tu WhatsApp, sin abrir la app. Lo enciendes tú; nada se envía solo."
        icon={<Inbox className="h-5 w-5" />}
      />
      <IntakeForm
        initial={{
          emailEnabled: prefs.emailEnabled,
          whatsappEnabled: prefs.whatsappEnabled,
          whatsappKeyword: prefs.whatsappKeyword,
        }}
        alias={alias}
        save={saveIntakePrefsAction}
      />
    </>
  );
}
