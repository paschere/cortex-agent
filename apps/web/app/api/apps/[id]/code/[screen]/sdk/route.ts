import { isSameOrigin } from '@/lib/activations/request';
import { openScreenForApi, previewAttributesOf } from '@/lib/apps/access';
import { runDocsScan, runVoiceTranscribe, uploadStore } from '@/lib/apps/code-media';
import { ensureFunctionRunner } from '@/lib/apps/function-runner';
import { uploadsByAppUser } from '@/lib/apps/rate-limit';
import { notifyViewActivity } from '@/lib/views/activity';
import { ScanError } from '@/lib/views/scan-doc';
import { UploadLimitError } from '@/lib/views/upload';
import { runSdkOp, screenView } from '@cortex/agent-tools';
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
 *
 * Tres operaciones llevan un archivo (`files.upload`, `docs.scan`, `voice.transcribe`): el marco
 * las manda como multipart (`op`, `args` en JSON y `file`); el iframe no sube nada por sí mismo.
 * Las dos últimas gastan al modelo de la empresa: no las usa un usuario externo ni «Ver como…».
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Leer un manifiesto con el modelo tarda (hasta 50 s). */
export const maxDuration = 60;

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
  if (err instanceof UploadLimitError || err instanceof ScanError) {
    const status = err instanceof ScanError ? err.status : 429;
    return { status, message };
  }
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

  // Con archivo la llamada llega como multipart; sin él, como JSON.
  const multipart = (req.headers.get('content-type') ?? '').includes('multipart/form-data');
  let file: File | null = null;
  let raw: unknown;
  if (multipart) {
    const form = await req.formData().catch(() => null);
    const f = form?.get('file');
    file = f instanceof File ? f : null;
    let args: unknown = null;
    try {
      args = JSON.parse(String(form?.get('args') ?? 'null'));
    } catch {
      return fail('La llamada no se entiende.', 400);
    }
    raw = { op: form?.get('op'), args };
  } else raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return fail('La llamada no se entiende.', 400);
  const { op, args } = parsed.data;

  // «Ver como…» no escribe: se corta aquí además de dentro de runSdkOp.
  if (
    readOnly &&
    (op === 'tables.insert' ||
      op === 'tables.update' ||
      op === 'tables.action' ||
      op === 'files.upload')
  )
    return fail('Estás viendo como otro rol: nada se guarda.', 403);

  try {
    if (op === 'functions.call') ensureFunctionRunner();
    if (op === 'docs.scan' || op === 'voice.transcribe') {
      if (readOnly || opened.external)
        return fail('Aquí Cortex no lee documentos ni voz por ti.', 403);
      if (!file) return fail('No llegó ningún archivo.', 400);
      const data =
        op === 'docs.scan'
          ? await runDocsScan(db, opened.actor.id, args, file, req.signal)
          : await runVoiceTranscribe(db, opened.actor.id, file);
      return NextResponse.json({ ok: true, data }, { headers: { 'cache-control': 'no-store' } });
    }
    let upload: Awaited<ReturnType<typeof uploadFor>> | undefined;
    if (op === 'files.upload') {
      if (!file) return fail('No llegó ningún archivo.', 400);
      // Un usuario externo sube con el tope por hora del enlace público, y además el suyo.
      if (opened.external && !uploadsByAppUser.take(opened.actor.id))
        return fail('Subiste muchos archivos en la última hora. Intenta más tarde.', 429);
      upload = await uploadFor(db, screen, file, opened.external);
    }
    const data = await runSdkOp(db, access, op, args, {
      screen,
      readOnly,
      upload,
      onActionNotice: async (n) =>
        notifyViewActivity(db, n.view, {
          title: `${n.actionLabel}: ${n.label}`,
          body: `${access.user.name} lo pidió desde «${access.app.name}».`,
          href: `/apps/${access.app.slug}/${screen.slug}?fila=${encodeURIComponent(n.rowId)}`,
        }),
    });
    return NextResponse.json({ ok: true, data }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const { status, message } = statusOf(err);
    if (status >= 500) logger.error({ err, app: access.app.id, op }, 'sdk: op failed');
    return fail(message, status);
  }
}

async function uploadFor(
  db: Parameters<typeof screenView>[0],
  screen: Parameters<typeof screenView>[1],
  file: File,
  external: boolean,
) {
  return uploadStore(db, await screenView(db, screen), file, { publicLink: external });
}
