import { type AppSummary, AppsLibrary } from '@/components/apps/AppsLibrary';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { APP_TEMPLATES, listApps, listScreens, viewerFromSession } from '@cortex/agent-tools';

/**
 * Aplicaciones: varias pantallas con roles, para quien no es «del equipo».
 *
 * Todos los miembros ven la estantería de lo que pueden abrir; crear y editar
 * es sólo de quien administra la empresa (`canManage`, resuelto aquí: el
 * navegador nunca decide quién es admin). Las plantillas viajan como datos
 * planos para que el componente de cliente no arrastre el barril de
 * agent-tools (node:dns) al bundle.
 */

export const dynamic = 'force-dynamic';

export default async function AppsPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const canManage = viewerFromSession(user).companyAdmin;
  const apps = await listApps(db);
  const screens = await Promise.all(apps.map((a) => listScreens(db, a.id)));

  const summaries: AppSummary[] = apps
    .map((a, i) => ({
      id: a.id,
      slug: a.slug,
      name: a.name,
      description: a.description,
      icon: a.icon,
      status: a.status,
      screens: screens[i]?.length ?? 0,
    }))
    // Quien no administra sólo ve lo publicado; el servidor lo vuelve a exigir al abrir.
    .filter((a) => canManage || a.status === 'published');

  return (
    <AppsLibrary
      apps={summaries}
      canManage={canManage}
      templates={APP_TEMPLATES.map((t) => ({ id: t.id, name: t.name, icon: t.icon, body: t.body }))}
    />
  );
}
