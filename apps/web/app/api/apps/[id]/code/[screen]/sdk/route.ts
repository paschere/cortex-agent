import { ensureFunctionRunner } from '@/lib/apps/function-runner';
import { isSameOrigin } from '@/lib/activations/request';
import { openScreenForApi, previewAttributesOf } from '@/lib/apps/access';
import { runSdkOp } from '@cortex/agent-tools';
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
 * LA PUERTA DEL SDK DE UNA PANTALLA CON CÓDIGO (0243).
 *
 * El host (CodeScreen.tsx) reenvía aquí cada mensaje del iframe:
 *   POST { op, args }  →  200 { ok: true, data } | 4xx/5xx { ok: false, error }
 * con la sesión (o la cookie de usuario externo) de quien tiene la app abierta.
 * El navegador no decide nada: el rol sale del servidor (`openScreenForApi`) y
 * `runSdkOp` aplica los permisos de la app. Sólo se aceptan llamadas del mismo
 * origen (la pantalla vive en un iframe de origen nulo: nunca llama directo).
 * «Ver como…» (`?como=`) mira con otro rol y NO escribe.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  op: z.string().trim().min(1).max(40),
  args: z.unknown().optional(),
});

const fail = (error: string, status: number) =>
  NextResponse.json({ ok: false, error }, { status, headers: { 'cache-control': 'no-store' } });

/** El estado HTTP que corresponde a un error del SDK; lo demás es un 500 sin detalle técnico. */
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
  return { status: 500, message: 'No se pudo completar la operación. Intenta de nuevo.' };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; screen: string }> },
) {
  if (!isSameOrigin(req)) return fail('Solicitud no permitida.', 403);
  const { id, screen: screenRef } = await params;
  const sp = req.nextUrl.searchParams;
  const opened = await openScreenForApi(id, screenRef, {
    as: sp.get('como'),
    attributes: previewAttributesOf(sp.getAll('atr')),
  });
  if (opened instanceof NextResponse) return fail('Esa pantalla no existe.', 404);
  const { db, access, screen, readOnly } = opened;
  if (screen.kind !== 'code') return fail('Esa pantalla no existe.', 404);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail('La llamada no se entiende.', 400);
  const { op, args } = parsed.data;

  // «Ver como…» no escribe: se corta aquí además de dentro de runSdkOp.
  if (readOnly && (op === 'tables.insert' || op === 'tables.update'))
    return fail('Estás viendo como otro rol: nada se guarda.', 403);

  try {
    if (op === 'functions.call') ensureFunctionRunner();
    const data = await runSdkOp(db, access, op, args, { screen, readOnly });
    return NextResponse.json({ ok: true, data }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const { status, message } = statusOf(err);
    if (status >= 500) logger.error({ err, app: access.app.id, op }, 'sdk: op failed');
    return fail(message, status);
  }
}
