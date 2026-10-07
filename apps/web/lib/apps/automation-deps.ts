import 'server-only';
import { askCortexForAutomation } from '@/lib/apps/automation-ask-cortex';
import { pushToAppUsers, pushToMembers } from '@/lib/apps/push';
import { sendEmail } from '@/lib/email';
import { notify } from '@/lib/notifications/notify';
import type { AutomationDeps } from '@cortex/agent-tools';

/**
 * Lo que el motor de automatizaciones necesita de la app web: el correo, la
 * campana, el push y Cortex. El motor vive en el paquete y no puede importar
 * nada de esto; aquí se le entrega.
 *
 * Sólo correo y push (decidido 2026-10-06): no hay WhatsApp saliente.
 */

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
}

export function signingSecret(): string {
  const key = (process.env.BETTER_AUTH_SECRET ?? '').trim();
  if (!key && process.env.NODE_ENV === 'production') throw new Error('BETTER_AUTH_SECRET missing');
  return key || 'dev-only-automation-secret';
}

export function buildAutomationDeps(): AutomationDeps {
  return {
    baseUrl: appBaseUrl(),
    signingSecret: signingSecret(),
    sendEmail: ({ to, subject, text }) => sendEmail({ to, subject, text }),
    notifyMembers: async (db, userIds, note) => {
      let n = 0;
      for (const userId of userIds) {
        const id = await notify(db, {
          userId,
          kind: 'view_activity',
          title: note.title,
          body: note.body,
          href: note.href.startsWith('http') ? new URL(note.href).pathname : note.href,
          dedupeKey: `${note.dedupeKey}:${userId}`,
          groupKey: `appauto:${note.appId}`,
        });
        if (id) n += 1;
      }
      // Quien activó los avisos en esta app además recibe el push (si hay llaves).
      await pushToMembers(db, note.appId, userIds, {
        title: note.title,
        body: note.body,
        url: `/a/${note.appId}`,
        tag: `appauto:${note.appId}`,
      }).catch(() => []);
      return n;
    },
    pushAppUsers: (db, appId, userIds, payload) => pushToAppUsers(db, appId, userIds, payload),
    askCortex: askCortexForAutomation,
  };
}
