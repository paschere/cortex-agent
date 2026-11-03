import { ensureFunctionRunner } from '@/lib/apps/function-runner';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  FN_MAX_INPUT_BYTES,
  findPublishedApp,
  getHook,
  hookTokenMatches,
  runAppFunction,
  systemAppAccess,
  touchHook,
} from '@cortex/agent-tools';
import { consumeToken } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * WEBHOOK DE ENTRADA DE UNA FUNCIÓN DE SERVIDOR (0244).
 *
 *   POST /api/apps/<app>/code/hooks/<función>
 *   Authorization: Bearer cxh_…   (o cabecera X-Cortex-Token)
 *
 * El token (que el administrador ve UNA vez al crear el webhook) se guarda con
 * hash. La función corre con el rol que el webhook tiene configurado —nunca el
 * administrador— a nombre de quien lo creó. La entrada de la función es
 * `{ body, headers, query }`: `body` es el JSON recibido (o el texto si no es
 * JSON); `headers` son las cabeceras sin credenciales (para verificar firmas de
 * terceros). Un webhook que no existe, con token malo o de una app sin publicar
 * responde el mismo 404: no se distingue.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HOOKS_PER_MINUTE = 60;
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'x-cortex-token', 'x-forwarded-for']);

const json = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
const notFound = () => json({ ok: false, error: 'No existe.' }, 404);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const { id, name } = await params;
  const token =
    /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]?.trim() ??
    req.headers.get('x-cortex-token')?.trim() ??
    '';
  if (!token) return notFound();

  const app = await findPublishedApp(getSupabaseServiceClient(), id);
  if (!app) return notFound();
  const db = getOrgScopedClient(app.organization_id);
  const hook = await getHook(db, app.id, name);
  if (!hook || !hookTokenMatches(token, hook.token_hash)) return notFound();

  const raw = await req.text();
  if (Buffer.byteLength(raw) > FN_MAX_INPUT_BYTES)
    return json({ ok: false, error: 'El cuerpo es demasiado grande.' }, 413);
  let body: unknown = raw;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  } else body = null;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (!SECRET_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v.slice(0, 500);
  });
  const query = Object.fromEntries(req.nextUrl.searchParams.entries());

  try {
    await consumeToken(db, hook.created_by, `apps.hook:${app.id}:${name}`, HOOKS_PER_MINUTE);
  } catch {
    return json({ ok: false, error: 'Demasiadas llamadas seguidas.' }, 429);
  }

  try {
    ensureFunctionRunner();
    const access = await systemAppAccess(
      db,
      app,
      hook.role_key,
      hook.created_by,
      `Webhook «${name}»`,
    );
    void touchHook(db, hook.id);
    const out = await runAppFunction(
      db,
      access,
      name,
      { body, headers, query },
      {
        trigger: 'webhook',
        organizationId: app.organization_id,
        actorLabel: `Webhook «${name}»`,
      },
    );
    if (!out.ok)
      return json(
        { ok: false, error: out.error ?? 'La función falló.' },
        out.status === 'timeout' ? 504 : 500,
      );
    return json({ ok: true, result: out.result ?? null }, 200);
  } catch (err) {
    logger.warn({ err, app: app.id, hook: name }, 'webhook: could not run function');
    const message =
      err instanceof Error && err.name === 'ValidationError' ? err.message : 'No se pudo ejecutar.';
    return json({ ok: false, error: message }, 400);
  }
}
