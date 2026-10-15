import { AppEditor } from '@/components/apps/editor/AppEditor';
import { ScreenEditor } from '@/components/apps/editor/ScreenEditor';
import { ViewBrandProvider } from '@/components/views/blocks/brand';
import { requireAppAdmin } from '@/lib/apps/access';
import { loadAppEditorData } from '@/lib/apps/editor-data';
import { loadSessionBrand } from '@/lib/branding/store';
import { computeView, listScreens, loadViewSources, screenViews } from '@cortex/agent-tools';
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
  const opened = await requireAppAdmin(decodeURIComponent(id));
  const { user, db, access } = opened;
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

  const data = await loadAppEditorData(opened, screens, views);

  return <AppEditor data={data} />;
}
