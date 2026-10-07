import 'server-only';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type AppAccess,
  type AppScreenRow,
  type AppViewer,
  resolveAppAccess,
  screenFor,
  viewerFromSession,
} from '@cortex/agent-tools';
import type { SessionUser } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { notFound } from 'next/navigation';
import { NextResponse } from 'next/server';

/**
 * LA PUERTA DE UNA APLICACIÓN, DEL LADO WEB.
 *
 * Todo lo que pinta o escribe una app pasa por aquí: la sesión, el handle
 * del espacio y el acceso resuelto en el servidor (`resolveAppAccess`, en
 * packages/agent-tools/src/apps/store.ts) con el rol GUARDADO de quien mira.
 * Una app de otra empresa, una sin publicar para quien no administra, o un
 * miembro sin rol, son lo mismo: no existe (404). Y una pantalla que el rol
 * no ve tampoco existe para él (`screenFor` devuelve null → 404).
 *
 * «VER COMO…» (`?como=<rol>`): sólo un administrador de la empresa puede
 * mirar la app con otro rol y datos reales; la página lo pinta en sólo
 * lectura (`readOnly`) y las escrituras lo rechazan.
 */

export interface OpenedApp {
  user: SessionUser;
  db: SupabaseClient;
  access: AppAccess;
  viewer: AppViewer;
  /** True en «Ver como…»: nada se escribe. */
  readOnly: boolean;
}

export interface OpenedScreen extends OpenedApp {
  screen: AppScreenRow;
}

export async function openApp(
  ref: string,
  options: { as?: string | null; attributes?: Record<string, string> } = {},
): Promise<OpenedApp | null> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const viewer = viewerFromSession(user);
  const as = options.as?.trim() || null;
  const preview =
    as && viewer.companyAdmin ? { roleKey: as, attributes: options.attributes } : null;
  const access = await resolveAppAccess(db, ref, viewer, preview ? { preview } : {});
  if (!access) return null;
  return { user, db, access, viewer, readOnly: Boolean(preview) };
}

/** Para páginas: 404 de Next si no entra. */
export async function requireApp(
  ref: string,
  options: { as?: string | null } = {},
): Promise<OpenedApp> {
  const opened = await openApp(ref, options);
  if (!opened) notFound();
  return opened;
}

export async function requireScreen(
  ref: string,
  screenRef: string | null | undefined,
  options: { as?: string | null } = {},
): Promise<OpenedScreen> {
  const opened = await requireApp(ref, options);
  const screen = screenFor(opened.access, screenRef);
  if (!screen) notFound();
  return { ...opened, screen };
}

/** Para rutas /api: un JSON 404 en vez de una página. */
export async function openScreenForApi(
  ref: string,
  screenRef: string,
  options: { as?: string | null } = {},
): Promise<OpenedScreen | NextResponse> {
  const opened = await openApp(ref, options);
  const screen = opened ? screenFor(opened.access, screenRef) : null;
  if (!opened || !screen)
    return NextResponse.json({ error: 'Esa pantalla no existe.' }, { status: 404 });
  return { ...opened, screen };
}

/** Sólo quien administra la empresa edita apps, roles y miembros. */
export async function requireAppAdmin(ref: string): Promise<OpenedApp> {
  const opened = await requireApp(ref);
  if (!opened.viewer.companyAdmin) notFound();
  return opened;
}
