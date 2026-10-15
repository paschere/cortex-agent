import { previewAttributesOf, requireApp } from '@/lib/apps/access';
import { previewQuery } from '@/lib/apps/preview-query';
import {
  HOME_SLUG,
  PORTAL_SLUG,
  homeEnabled,
  portalActive,
  screenFor,
  tableroNav,
} from '@cortex/agent-tools';
import { notFound, redirect } from 'next/navigation';

/** La puerta de la vista del panel: lleva a la primera pantalla visible (como /apps/<id>). */
export const dynamic = 'force-dynamic';

export default async function PanelAppViewIndex({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ como?: string; atr?: string | string[]; tema?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const { access } = await requireApp(decodeURIComponent(id), {
    as: query.como,
    attributes: previewAttributesOf(query.atr),
  });
  const screen = screenFor(access, null);
  const first = portalActive(access)
    ? PORTAL_SLUG
    : homeEnabled(access.app.home)
      ? HOME_SLUG
      : (screen?.slug ?? tableroNav(access)[0]?.slug);
  if (!first) notFound();
  const como = query.como ? previewQuery(query.como, access.user.attributes) : '';
  const tema = query.tema ? `${como ? '&' : '?'}tema=${encodeURIComponent(query.tema)}` : '';
  redirect(`/panel/apps/${access.app.slug}/vista/${first}${como}${tema}`);
}
