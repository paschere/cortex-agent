import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { listNotifications } from '@/lib/notifications/repository';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { Bell } from 'lucide-react';
import { Inbox } from './_components/Inbox';

export const dynamic = 'force-dynamic';

/**
 * Avisos: lo que pasó mientras no mirabas.
 *
 * ESTA PANTALLA NO ES UNA QUINTA COLA, y el subtítulo lo dice en voz alta
 * porque es la única manera de que no se convierta en una. Lo que sigue
 * esperando a una persona vive en Aprobaciones, Acciones, Compromisos y
 * Encargos, con su contador en el menú; aquí sólo hay hechos con hora, que se
 * leen una vez.
 *
 * La lista se pinta en el servidor —así el primer render ya trae los avisos y
 * no hay un salto de vacío a lleno— y a partir de ahí la maneja el cliente.
 * `listNotifications` revienta si la base falla, a propósito: una bandeja vacía
 * y una bandeja rota se ven idénticas y significan lo contrario.
 */
export default async function NotificationsPage() {
  const user = await requireSession();
  const notifications = await listNotifications(getOrgScopedClient(user.organization.id), user.id);

  return (
    <>
      <PageHeader
        title="Avisos"
        subtitle="Lo que pasó mientras no mirabas: un trámite que terminó, una rutina que no pudo correr, un encargo que te preguntó algo, un correo que salió. Lo que sigue esperándote está en sus colas."
        icon={<Bell className="h-5 w-5" />}
      />
      <Panel className="overflow-hidden">
        <Inbox initial={notifications} />
      </Panel>
    </>
  );
}
