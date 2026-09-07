import { auth } from '@/lib/auth';
import {
  GLOBAL_ATTACHMENT_MAX_BYTES,
  GLOBAL_ATTACHMENT_MIMES,
  createGlobalAttachment,
  createGlobalAttachmentConversation,
  deleteGlobalAttachment,
  listGlobalAttachments,
} from '@/lib/global-chat/attachments';
import { headers } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
export const runtime = 'nodejs';
export const maxDuration = 60;
async function account() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) throw new Error('Sin sesión.');
  return session.user.id;
}
const cleanMime = (value: string) => (value.split(';')[0] ?? '').trim().toLowerCase();
const uploadMime = (file: File) => {
  const mime = cleanMime(file.type);
  if ((!mime || mime === 'text/x-markdown') && file.name.toLowerCase().endsWith('.md'))
    return 'text/markdown';
  return mime;
};
export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get('conversationId');
  if (!conversationId) return NextResponse.json({ attachments: [] });
  if (!z.string().uuid().safeParse(conversationId).success)
    return NextResponse.json({ error: 'Conversación inválida.' }, { status: 400 });
  try {
    return NextResponse.json({
      attachments: await listGlobalAttachments(await account(), conversationId),
    });
  } catch {
    return NextResponse.json({ error: 'No se pudieron abrir los adjuntos.' }, { status: 403 });
  }
}
export async function DELETE(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get('conversationId');
  const attachmentId = req.nextUrl.searchParams.get('attachmentId');
  if (
    !z.string().uuid().safeParse(conversationId).success ||
    !z.string().uuid().safeParse(attachmentId).success
  )
    return NextResponse.json({ error: 'Adjunto inválido.' }, { status: 400 });
  try {
    const deleted = await deleteGlobalAttachment(
      await account(),
      conversationId as string,
      attachmentId as string,
    );
    return deleted
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: 'Adjunto no encontrado.' }, { status: 404 });
  } catch {
    return NextResponse.json({ error: 'No se pudo retirar el adjunto.' }, { status: 403 });
  }
}
export async function POST(req: NextRequest) {
  try {
    const accountId = await account();
    const declaredLength = Number(req.headers.get('content-length') ?? 0);
    if (declaredLength > GLOBAL_ATTACHMENT_MAX_BYTES + 256 * 1024)
      return NextResponse.json({ error: 'El archivo debe pesar máximo 4 MB.' }, { status: 413 });
    const form = await req.formData();
    const file = form.get('file');
    let conversationId = String(form.get('conversationId') ?? '');
    if (!(file instanceof File))
      return NextResponse.json({ error: 'Falta un archivo.' }, { status: 422 });
    const mime = uploadMime(file);
    if (!GLOBAL_ATTACHMENT_MIMES.has(mime))
      return NextResponse.json(
        { error: 'Por ahora Cortex sólo lee PDF, DOCX, TXT y MD.' },
        { status: 415 },
      );
    if (file.size === 0 || file.size > GLOBAL_ATTACHMENT_MAX_BYTES)
      return NextResponse.json(
        { error: 'El archivo debe pesar entre 1 byte y 4 MB.' },
        { status: 413 },
      );
    if (!conversationId) {
      const parsed = z
        .array(z.string().min(1).max(200))
        .max(30)
        .safeParse(JSON.parse(String(form.get('workspaceIds') ?? '[]')));
      if (!parsed.success)
        return NextResponse.json({ error: 'Selecciona espacios válidos.' }, { status: 422 });
      conversationId = await createGlobalAttachmentConversation(accountId, parsed.data);
    }
    if (!z.string().uuid().safeParse(conversationId).success)
      return NextResponse.json({ error: 'Conversación inválida.' }, { status: 422 });
    return NextResponse.json(
      {
        conversationId,
        attachment: await createGlobalAttachment({
          accountId,
          conversationId,
          filename: file.name || 'archivo',
          mime,
          bytes: Buffer.from(await file.arrayBuffer()),
        }),
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'No se pudo leer el archivo.' },
      { status: 422 },
    );
  }
}
