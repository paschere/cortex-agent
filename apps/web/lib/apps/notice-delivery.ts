import 'server-only';
import { appBaseUrl } from '@/lib/apps/automation-deps';
import { pushEnabled, pushToAppUsers, pushToMembers } from '@/lib/apps/push';
import { sendEmail } from '@/lib/email';
import { notify } from '@/lib/notifications/notify';
import type { NoticeDelivery } from '@cortex/agent-tools';

/**
 * Cómo salen los avisos automáticos de las apps (0231): el push, el correo y la
 * campana de siempre. El paquete decide QUIÉN y CUÁNDO (apps/notices); esto sólo
 * le presta los canales, porque un paquete no puede importar la app web. Se
 * registra en instrumentation-node.ts.
 *
 * Sin llaves VAPID el push no sale (`pushEnabled()` lo dice y el panel de la
 * app lo muestra): asignar y aprobar caen al correo, el resto queda en la
 * bandeja de la app.
 */
export function buildNoticeDelivery(): NoticeDelivery {
  return {
    pushEnabled,
    pushAppUsers: (db, appId, userIds, payload) => pushToAppUsers(db, appId, userIds, payload),
    pushMembers: (db, appId, userIds, payload) => pushToMembers(db, appId, userIds, payload),
    bell: (db, note) =>
      notify(db, {
        userId: note.userId,
        kind: 'view_activity',
        title: note.title,
        body: note.body,
        href: note.href,
        dedupeKey: note.dedupeKey,
        groupKey: note.groupKey,
      }),
    email: ({ to, subject, text }) => sendEmail({ to, subject, text }),
    baseUrl: appBaseUrl,
  };
}
