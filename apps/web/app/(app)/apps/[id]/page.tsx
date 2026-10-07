import { previewAttributesOf, requireScreen } from '@/lib/apps/access';
import { previewQuery } from '@/lib/apps/preview-query';
import { redirect } from 'next/navigation';

/**
 * La puerta de una aplicación: lleva a su primera pantalla visible para el
 * rol de quien entra (`screenFor` con null resuelve la de inicio). Conserva
 * `?como=` para que «Ver como…» no se pierda en el salto.
 */

export const dynamic = 'force-dynamic';

export default async function AppIndexPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ como?: string; atr?: string | string[] }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const { access, screen } = await requireScreen(id, null, {
    as: query.como,
    attributes: previewAttributesOf(query.atr),
  });
  const como = query.como ? previewQuery(query.como, access.user.attributes) : '';
  redirect(`/apps/${access.app.slug}/${screen.slug}${como}`);
}
