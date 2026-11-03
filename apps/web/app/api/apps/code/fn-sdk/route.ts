import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  accessFromClaims,
  runSdkOp,
  verifyFnToken,
  withAutomationOrigin,
} from '@cortex/agent-tools';
import {
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  logger,
} from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * EL SDK PARA UNA FUNCIÓN DE SERVIDOR EN EJECUCIÓN (0244).
 *
 * `ctx.cortex.*` dentro de una función (corre en Vercel Sandbox, sin cookie)
 * llega aquí:
 *   POST { op, args }  con  Authorization: Bearer <token de la corrida>
 * El token lo firmó Cortex al lanzar la función (HMAC, 5 minutos) con la
 * empresa, la app, el actor y la CLAVE DEL ROL con que corre. Aquí se vuelve a
 * armar el acceso con los permisos de ESE rol, leídos de la base ahora, y se
 * llama `runSdkOp`: una función nunca puede más que el rol de quien la disparó.
 * Sin cookie ni «mismo origen» (es de servidor a servidor); el token es la credencial.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  op: z.string().trim().min(1).max(40),
  args: z.unknown().optional(),
});

const fail = (error: string, status: number) =>
  NextResponse.json({ ok: false, error }, { status, headers: { 'cache-control': 'no-store' } });

function statusOf(err: unknown): { status: number; message: string } {
  const message = err instanceof Error ? err.message : '';
  if (err instanceof ValidationError) return { status: 400, message };
  if (err instanceof ForbiddenError) return { status: 403, message };
  if (err instanceof NotFoundError) return { status: 404, message };
  if (err instanceof RateLimitError)
    return { status: 429, message: 'Demasiadas llamadas seguidas. Espera un momento.' };
  const name = err instanceof Error ? err.name : '';
  if (name === 'SubmissionLimitError' || name === 'ViewWriteLimitError')
    return { status: 429, message };
  return { status: 500, message: 'No se pudo completar la operación.' };
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? '';
  const claims = token ? verifyFnToken(token) : null;
  if (!claims) return fail('Token inválido o vencido.', 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail('La llamada no se entiende.', 400);
  const { op, args } = parsed.data;
  if (op === 'functions.call') return fail('Una función de servidor no llama a otra función.', 400);

  try {
    const db = getOrgScopedClient(claims.org);
    const access = await accessFromClaims(db, claims);
    if (!access) return fail('La app o el rol de esta corrida ya no existen.', 403);
    const screen = claims.screen
      ? (access.screens.find((s) => s.id === claims.screen) ?? null)
      : null;
    const run = () =>
      runSdkOp(db, access, op, args, {
        screen: screen ? { id: screen.id, slug: screen.slug, view_id: screen.view_id } : null,
        readOnly: claims.readOnly,
        via: 'function',
      });
    // Si una regla disparó la función, su cadena anti-bucle cruza este HTTP de vuelta
    // (viene firmada en el token): lo que escriba emite eventos con la misma cadena y profundidad.
    const data =
      claims.depth || claims.chain?.length
        ? await withAutomationOrigin({ chain: claims.chain ?? [], depth: claims.depth ?? 0 }, run)
        : await run();
    return NextResponse.json({ ok: true, data }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const { status, message } = statusOf(err);
    if (status >= 500) logger.error({ err, app: claims.app, op }, 'fn-sdk: op failed');
    return fail(message, status);
  }
}
