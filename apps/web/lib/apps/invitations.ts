import 'server-only';
import { readBranding } from '@/lib/branding/store';
import { sendEmail } from '@/lib/email';
import { renderAppInvitationEmail } from '@/lib/email-templates/app-access';
import {
  type CustomAppRow,
  type ExternalUserRow,
  listAppUsers,
  listRoles,
  markInvited,
  mustGetApp,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Manda el correo de invitación a /a/<app> a usuarios externos de una app.
 * Lo usan el editor (botones «Invitar» y «Reenviar») y la herramienta
 * `apps.invite_users` del chat (por `ToolContext.sendAppInvitations`). Un
 * correo que no sale no tumba a los demás: se cuenta y se devuelve.
 */
export async function sendAppInvitations(
  db: SupabaseClient,
  appRef: string,
  userIds: string[],
): Promise<{ sent: number; failed: Array<{ email: string; reason: string }> }> {
  const app: CustomAppRow = await mustGetApp(db, appRef);
  if (app.status !== 'published')
    // El enlace de una app en borrador no abre: se avisa en vez de mandar un enlace muerto.
    return {
      sent: 0,
      failed: [
        {
          email: '*',
          reason: 'La aplicación está en borrador: publícala para que el enlace abra.',
        },
      ],
    };
  const [users, roles, brand] = await Promise.all([
    listAppUsers(db, app.id),
    listRoles(db, app.id),
    readBranding(db).catch(() => null),
  ]);
  const organizationName = brand?.display_name?.trim() || 'Tu equipo';
  const out: { sent: number; failed: Array<{ email: string; reason: string }> } = {
    sent: 0,
    failed: [],
  };
  for (const user of users.filter((u: ExternalUserRow) => userIds.includes(u.id))) {
    if (user.status === 'disabled') {
      out.failed.push({ email: user.email, reason: 'Está desactivado.' });
      continue;
    }
    const mail = renderAppInvitationEmail({
      appId: app.id,
      appName: app.name,
      organizationName,
      name: user.name,
      roleName: roles.find((r) => r.key === user.role_key)?.name ?? user.role_key,
    });
    const res = await sendEmail({ to: user.email, ...mail });
    if (res.sent) {
      out.sent += 1;
      await markInvited(db, app.id, user.id).catch((err) =>
        logger.warn({ err }, 'apps: markInvited failed'),
      );
    } else out.failed.push({ email: user.email, reason: res.reason ?? 'No se pudo enviar.' });
  }
  return out;
}
