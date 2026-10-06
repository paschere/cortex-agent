import { buildToolContext } from '@/lib/agent';
import { feedFingerprint } from '@/lib/feed/fingerprint';
import { FeedCaptureError, persistFeedCapture } from '@/lib/feed/google-sheet-capture';
import { googleSpreadsheetId, readGoogleSheetFeed } from '@/lib/feed/google-sheets';
import { FEED_MAX_BYTES, FEED_MAX_TEXT, feedMime } from '@/lib/feed/shared';
import { ownedFeed } from '@/lib/feed/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { parseDocument } from '@cortex/agent-tools';
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
  const targetSourceId = String(form.get('targetSourceId') ?? '').trim() || undefined;
  if (
    targetSourceId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      targetSourceId,
    )
  )
    return NextResponse.json({ error: 'La fuente de destino no es válida.' }, { status: 400 });
  if (targetSourceId && !['file', 'text'].includes(kind))
    return NextResponse.json(
      { error: 'Sólo archivos y textos aceptan versiones manuales.' },
      { status: 409 },
    );
  if (targetSourceId) {
    const target = await db
      .from('feed_sources')
      .select('id,kind')
      .eq('id', targetSourceId)
      .eq('actor_id', user.id)
      .maybeSingle();
    if (target.error)
      return NextResponse.json(
        { error: 'No se pudo revisar la fuente de destino.' },
        { status: 503 },
      );
    if (!target.data)
      return NextResponse.json({ error: 'La fuente de destino no existe.' }, { status: 404 });
    if (target.data.kind !== kind)
      return NextResponse.json(
        { error: 'La nueva versión debe ser del mismo tipo que la fuente.' },
        { status: 409 },
      );
  }
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
  let sourceKind: 'file' | 'text' | 'url' | 'google_sheet' = kind as 'file' | 'text' | 'url';
  let sourceConfig: Record<string, unknown> = {};
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
      if (
        [...parsed.searchParams.keys()].some((key) =>
          /token|secret|password|passwd|api_?key|authorization|signature|credential/i.test(key),
        )
      )
        throw new Error(
          'El enlace parece incluir una credencial. Conecta la API como herramienta y guarda el secreto allí.',
        );
      const spreadsheetId = googleSpreadsheetId(parsed);
      const context = buildToolContext({
        organizationId: user.organization.id,
        userId: user.id,
        agentId: user.id,
        surface: 'web',
        signal: AbortSignal.timeout(25000),
      });
      if (spreadsheetId) {
        sourceKind = 'google_sheet';
        sourceConfig = { spreadsheetId };
        const result = await readGoogleSheetFeed(context, spreadsheetId);
        url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
        name = result.name.slice(0, 200);
        text = result.text;
        tables = result.tables;
        truncated = result.truncated;
        mime = 'text/markdown';
        bytes = Buffer.from(text);
      } else {
        sourceConfig = { url };
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
  // Deduplicar, topar en 100, subir el archivo y registrar la fuente vive en
  // `persistFeedCapture` (paquete de herramientas), la misma ruta que usa el chat
  // al conectar una hoja con `feed.connect_google_sheet`.
  try {
    const saved = await persistFeedCapture({
      db,
      actorId: user.id,
      count: count ?? 0,
      kind: kind as 'file' | 'text' | 'url',
      sourceKind,
      name,
      mime,
      bytes,
      text,
      tables,
      url,
      truncated,
      fingerprint,
      sourceConfig,
      targetSourceId,
    });
    return saved.deduplicated
      ? NextResponse.json({ entry: saved.entry, deduplicated: true })
      : NextResponse.json({ entry: saved.entry }, { status: 201 });
  } catch (err) {
    if (err instanceof FeedCaptureError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
