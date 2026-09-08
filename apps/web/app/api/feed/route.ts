import { createHash, randomUUID } from 'node:crypto';
import { buildToolContext } from '@/lib/agent';
import { feedFingerprint } from '@/lib/feed/fingerprint';
import { googleSpreadsheetId, readGoogleSheetFeed } from '@/lib/feed/google-sheets';
import { FEED_MAX_BYTES, FEED_MAX_TEXT, feedMime } from '@/lib/feed/shared';
import { FEED_COLUMNS, ownedFeed } from '@/lib/feed/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { parseDocument, putFile, removeFiles } from '@cortex/agent-tools';
import type { SheetData } from '@cortex/agent-tools/src/kb/spreadsheets';
import { webScrape } from '@cortex/agent-tools/src/web/scrape';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const { data, error } = await ownedFeed(db, user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: 'No se pudo cargar Feed.' }, { status: 500 });
  return NextResponse.json({ entries: data });
}

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const form = await req.formData().catch(() => null);
  if (!form)
    return NextResponse.json({ error: 'Añade un archivo, un enlace o texto.' }, { status: 400 });
  const kind = String(form.get('kind') ?? '');
  const { count, error: countError } = await db
    .from('chat_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('created_by', user.id)
    .not('feed_kind', 'is', null)
    .gt('purge_at', new Date().toISOString());
  if (countError) return NextResponse.json({ error: 'No se pudo abrir Feed.' }, { status: 500 });

  let bytes: Buffer;
  let mime: string;
  let name: string;
  let text: string;
  let tables: SheetData[] | undefined;
  let url: string | null = null;
  let truncated = false;
  let identityText = '';
  try {
    if (kind === 'file') {
      const file = form.get('file');
      if (!(file instanceof File)) throw new Error('Elige un archivo.');
      if (file.size > FEED_MAX_BYTES) throw new Error('El archivo pasa de 10 MB.');
      const detected = feedMime(file.name, file.type);
      if (!detected) throw new Error('Usa PDF, DOCX, XLSX, CSV, TXT o Markdown.');
      mime = detected;
      name = file.name.slice(0, 240);
      bytes = Buffer.from(await file.arrayBuffer());
      const parsed = await parseDocument(bytes, mime);
      text = parsed.text;
      tables = parsed.tables;
    } else if (kind === 'text') {
      text = String(form.get('text') ?? '').trim();
      name =
        String(form.get('title') ?? '')
          .trim()
          .slice(0, 200) || 'Nota de consulta';
      mime = 'text/markdown';
      bytes = Buffer.from(text);
    } else if (kind === 'url') {
      url = String(form.get('url') ?? '').trim();
      if (url.length > 2048) throw new Error('El enlace es demasiado largo.');
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new Error('Usa un enlace público http o https, sin credenciales.');
      const spreadsheetId = googleSpreadsheetId(parsed);
      const context = buildToolContext({
        organizationId: user.organization.id,
        userId: user.id,
        agentId: user.id,
        surface: 'web',
        signal: AbortSignal.timeout(25000),
      });
      if (spreadsheetId) {
        const result = await readGoogleSheetFeed(context, spreadsheetId);
        url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
        name = result.name.slice(0, 200);
        text = result.text;
        tables = result.tables;
        truncated = result.truncated;
        mime = 'text/markdown';
        bytes = Buffer.from(text);
      } else {
        const result = await webScrape.handler({ url, maxChars: 20000 }, context);
        if (!result.content.trim())
          throw new Error('La página no tiene texto accesible. Puedes pegar su contenido.');
        text = `Fuente: ${url}\nConsultada: ${new Date().toISOString()}\n\n${result.content}`;
        identityText = result.content;
        truncated = result.truncated;
        name = parsed.hostname + (parsed.pathname === '/' ? '' : parsed.pathname.slice(0, 100));
        mime = 'text/markdown';
        bytes = Buffer.from(text);
      }
    } else {
      throw new Error('Elige archivo, enlace o texto.');
    }
    if (!text.trim())
      throw new Error('No encontré texto legible. Para un escaneo, pega la transcripción.');
    if (text.length > FEED_MAX_TEXT || JSON.stringify(tables ?? []).length > 2_000_000) {
      throw new Error('El contenido es demasiado extenso. Divídelo en archivos más pequeños.');
    }
  } catch (err) {
    const message =
      kind === 'url'
        ? 'No se pudo leer la fuente. Para Google Sheets, conecta Google en esta empresa y comprueba tu permiso sobre el archivo. Para otras URLs, usa una página pública.'
        : err instanceof Error
          ? err.message
          : 'No se pudo leer el contenido.';
    return NextResponse.json({ error: message }, { status: 422 });
  }

  const fingerprint = feedFingerprint({
    text: identityText || text,
    tables,
    sourceUrl: url,
    truncated,
  });
  const findDuplicate = () =>
    ownedFeed(db, user.id).eq('feed_content_hash', fingerprint).maybeSingle();
  const duplicate = await findDuplicate();
  if (duplicate.error)
    return NextResponse.json(
      { error: 'No se pudo comprobar si la fuente ya existe.' },
      { status: 503 },
    );
  if (duplicate.data) return NextResponse.json({ entry: duplicate.data, deduplicated: true });
  // Older entries have no semantic identity yet; exact original bytes remain a safe match.
  const rawHash = createHash('sha256').update(bytes).digest('hex');
  const legacy = await ownedFeed(db, user.id)
    .eq('sha256', rawHash)
    .eq('mime', mime)
    .is('feed_content_hash', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (legacy.error)
    return NextResponse.json(
      { error: 'No se pudo comprobar el historial de la fuente.' },
      { status: 503 },
    );
  if (legacy.data?.[0] && kind !== 'url')
    return NextResponse.json({ entry: legacy.data[0], deduplicated: true });
  if ((count ?? 0) >= 100)
    return NextResponse.json(
      { error: 'Tu Feed tiene 100 entradas. Elimina alguna para añadir una fuente nueva.' },
      { status: 409 },
    );
  const id = randomUUID();
  const path = `${user.id}/${id}/${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  try {
    await putFile(db, { bucket: 'chat-uploads', path, content: bytes, contentType: mime });
    const { data, error } = await db
      .from('chat_attachments')
      .insert({
        id,
        conversation_id: null,
        disposition: 'turn',
        filename: name,
        mime,
        byte_size: bytes.length,
        sha256: rawHash,
        feed_content_hash: fingerprint,
        extracted_text: text,
        file_path: path,
        created_by: user.id,
        feed_kind: kind,
        source_url: url,
        feed_tables: tables ?? null,
        feed_truncated: truncated,
      })
      .select(FEED_COLUMNS)
      .single();
    if (error?.code === '23505') {
      await removeFiles(db, 'chat-uploads', [path]);
      const winner = await findDuplicate();
      if (winner.error || !winner.data)
        throw new Error('No se pudo recuperar la entrada existente.');
      return NextResponse.json({ entry: winner.data, deduplicated: true });
    }
    if (error || !data) throw new Error('No se pudo guardar la entrada.');
    return NextResponse.json({ entry: data }, { status: 201 });
  } catch {
    await removeFiles(db, 'chat-uploads', [path]).catch(() => {});
    return NextResponse.json(
      { error: 'No se pudo añadir a Feed. Inténtalo otra vez.' },
      { status: 500 },
    );
  }
}
