import { AppEditor, type AppEditorData } from '@/components/apps/editor/AppEditor';
import { ScreenEditor } from '@/components/apps/editor/ScreenEditor';
import { ViewBrandProvider } from '@/components/views/blocks/brand';
import { requireAppAdmin } from '@/lib/apps/access';
import { loadSessionBrand } from '@/lib/branding/store';
import {
  computeView,
  listDirectory,
  listMembers,
  listRoles,
  listScreens,
  listTrackers,
  loadViewSources,
  personLabel,
  screenViews,
  trackersOf,
} from '@cortex/agent-tools';
import { notFound } from 'next/navigation';

/**
 * El editor de una aplicación (sólo quien administra la empresa).
 *
 * Sin `?pantalla=` es el panel con pestañas (pantallas, roles, miembros, «ver
 * como»). Con `?pantalla=<id>` es el lienzo de vistas en pantalla completa
 * sobre esa pantalla: una pantalla ES una vista, y se guarda con el mismo
 * contrato. La vista previa se calcula aquí con los datos reales de quien
 * edita y nunca es escribible: un borrador no debe escribir filas de verdad.
 */

export const dynamic = 'force-dynamic';

export default async function EditAppPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pantalla?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const { user, db, access } = await requireAppAdmin(decodeURIComponent(id));
  const app = access.app;

  const screens = await listScreens(db, app.id);
  const views = await screenViews(db, screens);

  if (query.pantalla) {
    const screen = screens.find((s) => s.id === query.pantalla);
    const view = screen ? views.get(screen.view_id) : null;
    if (!screen || !view) notFound();
    const [sources, brand] = await Promise.all([
      loadViewSources(db, view.spec, { viewerId: user.id }),
      loadSessionBrand(db, user.organization.name),
    ]);
    const preview = computeView(view.spec, sources, new Date(), { writable: false });
    return (
      <ViewBrandProvider brand={brand}>
        <ScreenEditor
          appId={app.id}
          view={{
            id: view.id,
            version: view.version,
            name: view.name,
            description: view.description,
            spec: view.spec,
          }}
          preview={preview}
        />
      </ViewBrandProvider>
    );
  }

  const [roles, members, directory, trackers] = await Promise.all([
    listRoles(db, app.id),
    listMembers(db, app.id),
    listDirectory(db),
    listTrackers(db, 40),
  ]);

  // Las tablas que alguna pantalla lee y los botones de fila que declara cada una:
  // sin esto la matriz de permisos no sabría qué ofrecer.
  const used = new Set<string>();
  const actionsByTracker: Record<string, Array<{ id: string; label: string }>> = {};
  for (const view of views.values()) {
    for (const slug of trackersOf(view.spec)) used.add(slug);
    for (const block of view.spec.blocks) {
      if (!('tracker' in block) || !('actions' in block)) continue;
      const list = actionsByTracker[block.tracker] ?? [];
      actionsByTracker[block.tracker] = list;
      for (const a of block.actions as Array<{ id: string; label: string }>)
        if (!list.some((x) => x.id === a.id)) list.push({ id: a.id, label: a.label });
    }
  }

  const people = new Map(directory.map((p) => [p.id, { name: personLabel(p), email: p.email }]));
  const data: AppEditorData = {
    app: {
      id: app.id,
      slug: app.slug,
      name: app.name,
      description: app.description,
      icon: app.icon,
      status: app.status,
      homeScreen: app.home_screen,
    },
    screens: screens.map((s) => ({
      id: s.id,
      slug: s.slug,
      title: s.title,
      icon: s.icon,
      roles: s.roles,
      viewName: views.get(s.view_id)?.name ?? s.title,
    })),
    roles: roles.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
    })),
    members: members.map((m) => ({
      userId: m.user_id,
      name: people.get(m.user_id)?.name ?? 'Persona que ya no está',
      email: people.get(m.user_id)?.email ?? '',
      roleKey: m.role_key,
      attributes: m.attributes,
    })),
    directory: directory.map((p) => ({ id: p.id, name: personLabel(p), email: p.email })),
    trackers: trackers
      .filter((t) => used.has(t.slug))
      .map((t) => ({
        slug: t.slug,
        name: t.name,
        fields: t.fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          ...(f.options ? { options: f.options } : {}),
        })),
        actions: actionsByTracker[t.slug] ?? [],
      })),
    // Una tabla usada que no es propia (plataforma/Feed) no sale en la matriz con campos,
    // pero sí con su nombre: el permiso se da por clave.
    unknownTrackers: [...used].filter((slug) => !trackers.some((t) => t.slug === slug)),
  };

  return <AppEditor data={data} />;
}
