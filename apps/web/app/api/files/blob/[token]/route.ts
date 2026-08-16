import { verifyBlobToken } from '@/lib/blob-token';
import { getFileDirect } from '@/lib/files-db';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/files/blob/<token> — descarga un archivo de app_files con una URL
 * firmada. El reemplazo de las signed URLs de Supabase Storage (migración 0109).
 *
 * AUTORIZACIÓN: el token ES la autorización. Lo firma el servidor con
 * JOBS_SECRET (lib/blob-token.ts), lleva bucket, ruta y expiración dentro de la
 * firma, y vive poco. No hay sesión que pedir: el consumidor típico es Deepgram
 * bajando el audio de una reunión para transcribirlo, y Deepgram no tiene
 * cookies. La misma postura que /api/files/presentation/[token], con la firma
 * HMAC en lugar de una fila con token aleatorio.
 *
 * POR QUÉ LEE POR pg DIRECTO Y NO POR PostgREST: esta ruta sirve el archivo más
 * grande que existe en el producto — audio de reuniones de hasta 200 MB, que en
 * la representación hex de PostgREST serían 400 MB de JSON. lib/files-db.ts
 * tiene el argumento completo. No hay cliente scopeado porque el token ya nombra
 * (bucket, path) — la identidad completa del archivo — y la firma prueba que lo
 * emitió este servidor.
 *
 * 404 GENÉRICO A PROPÓSITO: firma mala, token expirado, payload roto y archivo
 * inexistente responden lo mismo. Distinguirlos sólo le serviría a quien está
 * probando tokens.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** base64url.base64url — cualquier otra forma ni siquiera toca la base. */
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function notFound() {
  return new NextResponse('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token || token.length > 2048 || !TOKEN_RE.test(token)) return notFound();

  const payload = verifyBlobToken(token);
  if (!payload) return notFound();

  const file = await getFileDirect(payload.bucket, payload.path);
  if (!file) return notFound();

  return new NextResponse(new Uint8Array(file.content), {
    status: 200,
    headers: {
      'Content-Type': file.contentType ?? 'application/octet-stream',
      'Content-Length': String(file.content.byteLength),
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
