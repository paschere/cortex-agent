import { type AppScreenQuery, AppScreenServer } from '@/components/apps/AppScreenServer';

/** Una pantalla de la app, dentro del panel del chat (sin espacio de trabajo alrededor). */
export const dynamic = 'force-dynamic';

export default async function PanelAppScreen({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; screen: string }>;
  searchParams: Promise<AppScreenQuery & { tema?: string }>;
}) {
  const [{ id, screen }, query] = await Promise.all([params, searchParams]);
  return (
    <div className="px-3 py-4 md:px-5">
      <AppScreenServer
        id={id}
        screen={screen}
        query={query}
        embedBase={(slug) => `/panel/apps/${slug}/vista`}
      />
    </div>
  );
}
