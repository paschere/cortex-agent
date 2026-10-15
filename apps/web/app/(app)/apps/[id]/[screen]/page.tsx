import { type AppScreenQuery, AppScreenServer } from '@/components/apps/AppScreenServer';

/**
 * Una pantalla de una aplicación. La lógica vive en `AppScreenServer`, que
 * comparte con el panel de la app al lado del chat.
 */

export const dynamic = 'force-dynamic';

export default async function AppScreenPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; screen: string }>;
  searchParams: Promise<AppScreenQuery>;
}) {
  const [{ id, screen }, query] = await Promise.all([params, searchParams]);
  return <AppScreenServer id={id} screen={screen} query={query} />;
}
