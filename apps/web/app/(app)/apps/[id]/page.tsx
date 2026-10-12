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
import { notFound } from 'next/navigation';
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
  const { access } = await requireApp(id, {
    as: query.como,
    attributes: previewAttributesOf(query.atr),
  });
  const screen = screenFor(access, null);
  const como = query.como ? previewQuery(query.como, access.user.attributes) : '';
  // Con «Inicio» encendido (0215), la app abre ahí.
  // Un cliente del portal y las apps de sólo tableros (0225) abren en su pantalla sintética.
  const first = portalActive(access)
    ? PORTAL_SLUG
    : homeEnabled(access.app.home)
      ? HOME_SLUG
      : (screen?.slug ?? tableroNav(access)[0]?.slug);
  if (!first) notFound();
  redirect(`/apps/${access.app.slug}/${first}${como}`);
}
