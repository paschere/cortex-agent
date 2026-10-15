import { AppEditor } from '@/components/apps/editor/AppEditor';
import { EmbedBridge } from '@/components/apps/panel/EmbedChrome';
import { requireAppAdmin } from '@/lib/apps/access';
import { loadAppEditorData } from '@/lib/apps/editor-data';
import { listScreens, screenViews } from '@cortex/agent-tools';

/**
 * El editor de la app dentro del panel del chat: el MISMO `AppEditor` y las
 * mismas acciones de servidor de /apps/<id>/edit, en su diseño compacto. Sólo
 * quien administra (`requireAppAdmin`). Cada vez que algo guardado cambia, el
 * sello cambia y `EmbedBridge` se lo dice al panel para que refresque la vista.
 */
export const dynamic = 'force-dynamic';

function stampOf(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

export default async function PanelAppEditor({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const opened = await requireAppAdmin(decodeURIComponent(id));
  const screens = await listScreens(opened.db, opened.access.app.id);
  const views = await screenViews(opened.db, screens);
  const data = await loadAppEditorData(opened, screens, views);
  const stamp = stampOf({
    app: data.app,
    screens: data.screens,
    roles: data.roles,
    members: data.members.length,
    home: data.home,
    brand: data.brand,
    dashboards: data.dashboards,
    portal: data.portal,
    views: [...views.values()].map((v) => `${v.id}:${v.version}`),
    updated: opened.access.app.updated_at,
  });
  return (
    <div className="px-3 py-4">
      <EmbedBridge appId={data.app.id} stamp={stamp} />
      <AppEditor data={data} compact {...(query.tab ? { initialTab: query.tab } : {})} />
    </div>
  );
}
