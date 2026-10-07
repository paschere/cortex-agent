import 'server-only';
import { getAppUser } from '@/lib/apps/external-session';
import { getOptionalSession, requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type AppAccess,
  type AppScreenRow,
  type AppViewer,
  type CustomViewRow,
  canCreateIn,
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
  /**
   * Quién abre: un miembro de Cortex (`/apps/<app>`, sesión normal) o un
   * usuario externo de la app (`/a/<app>`, cookie propia, 0209). Las dos
   * puertas llegan al mismo `AppAccess`; sólo cambia el actor.
   */
  actor: { id: string; name: string; organizationId: string; organizationName: string };
  external: boolean;
  db: SupabaseClient;
  access: AppAccess;
  viewer: AppViewer;
  /** True en «Ver como…»: nada se escribe. */
  readOnly: boolean;
}

/** El que entró con sesión de Cortex: el editor y las puertas de administración. */
export interface OpenedMemberApp extends OpenedApp {
  user: SessionUser;
}

export interface OpenedScreen extends OpenedApp {
  screen: AppScreenRow;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Abre la app para quien pide, con la sesión que traiga. Primero la de Cortex
 * (si es miembro de la empresa dueña de la app, entra con su rol de siempre:
 * `/a/<app>` con sesión normal es lo mismo que `/apps/<app>`); si no, la
 * cookie de usuario externo de ESA app. Sin ninguna de las dos, null.
 */
export async function openApp(
  ref: string,
  options: { as?: string | null; attributes?: Record<string, string> } = {},
): Promise<OpenedApp | null> {
  const user = await getOptionalSession();
  if (user) {
    const member = await openMemberApp(user, ref, options);
    if (member) return member;
  }
  // Los usuarios externos entran por el id de la app (el slug sólo es único
  // dentro de una empresa, y aquí todavía no se sabe de cuál).
  if (!UUID_RE.test(ref)) return null;
  const ctx = await getAppUser(ref);
  if (!ctx) return null;
  return {
    actor: {
      id: ctx.user.id,
      name: ctx.user.name,
      organizationId: ctx.app.organization_id,
      organizationName: '',
    },
    external: true,
    db: ctx.db,
    access: ctx.access,
    viewer: { id: ctx.user.id, name: ctx.user.name, companyAdmin: false },
    readOnly: false,
  };
}

async function openMemberApp(
  user: SessionUser,
  ref: string,
  options: { as?: string | null; attributes?: Record<string, string> },
): Promise<OpenedMemberApp | null> {
  const db = getOrgScopedClient(user.organization.id);
  const viewer = viewerFromSession(user);
  const as = options.as?.trim() || null;
  const preview =
    as && viewer.companyAdmin ? { roleKey: as, attributes: options.attributes } : null;
  const access = await resolveAppAccess(db, ref, viewer, preview ? { preview } : {});
  if (!access) return null;
  return {
    user,
    actor: {
      id: user.id,
      name: viewer.name,
      organizationId: user.organization.id,
      organizationName: user.organization.name,
    },
    external: false,
    db,
    access,
    viewer,
    readOnly: Boolean(preview),
  };
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

/** Sólo quien administra la empresa edita apps, roles y miembros: siempre con sesión de Cortex. */
export async function requireAppAdmin(ref: string): Promise<OpenedMemberApp> {
  const user = await requireSession();
  const opened = await openMemberApp(user, ref, {});
  if (!opened || !opened.viewer.companyAdmin) notFound();
  return opened;
}

/**
 * La puerta de las rutas que ayudan a LLENAR un formulario (subir un archivo,
 * dictar, el turno de voz): sirven para rellenarlo, no para guardarlo, pero un
 * rol que no puede registrar en esa tabla tampoco tiene por qué subir fotos ni
 * gastar dictados en ella. Devuelve el 403 o null si pasa. El administrador
 * pasa siempre.
 */
export function formGate(
  opened: Pick<OpenedScreen, 'access'>,
  view: Pick<CustomViewRow, 'spec'>,
  blockId: string,
): NextResponse | null {
  if (opened.access.role.admin) return null;
  const block = view.spec.blocks.find((b) => b.id === blockId);
  if (!block || block.type !== 'form')
    return NextResponse.json(
      { error: 'Ese formulario no está en esta pantalla.' },
      { status: 404 },
    );
  if (!canCreateIn(opened.access.role, block.tracker))
    return NextResponse.json(
      { error: 'Tu rol en esta aplicación no registra en esta tabla.' },
      { status: 403 },
    );
  return null;
}
