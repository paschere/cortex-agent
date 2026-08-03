import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/files/presentation/<token> — download a candidate presentation PDF.
 *
 * AUTH POSTURE (deliberate, and the trade-off is real):
 *
 * This link is created inside a Claude/MCP conversation and clicked from there,
 * from Slack, or from an email. None of those carry a Zipdev session cookie, so
 * a session check would make the deliverable unusable — the user would land on
 * a login page holding a link they cannot open. The link therefore authenticates
 * ITSELF: whoever holds the token gets the file.
 *
 * What that buys and what it costs:
 *   + The person who asked for the PDF can actually open it, and can forward it
 *     to a colleague without us building a sharing UI.
 *   - Anyone who obtains the URL can download it. This is a candidate write-up:
 *     name, work history, skills. Not a credential, but not public either.
 *
 * The compensating controls:
 *   1. UNGUESSABLE. 32 random bytes (256 bits) from crypto.randomBytes, base64url.
 *      Enumeration is not a threat model at that size.
 *   2. SHORT-LIVED. `expires_at` defaults to 7 days. After that the row stays
 *      (so we can still tell the user what happened) but the bytes are refused
 *      with 410, not 404 — "this link expired" is a better answer than "no such
 *      file", and it is not information a stranger can act on.
 *   3. ACCOUNTED. Every successful download increments `downloads`, so
 *      presentations.list_recent can show a link being used more than expected.
 *   4. NOT INDEXABLE / NOT CACHEABLE. `X-Robots-Tag: noindex` plus
 *      `Cache-Control: private, no-store`, so the file never lands in a shared
 *      cache or a search index.
 *
 * If this ever needs to be stricter, the upgrade path is to bind the token to a
 * recipient email and mail a one-time code — not to add a session check, which
 * would simply break the flow this exists to serve.
 */

export const dynamic = 'force-dynamic';

interface FileRow {
  id: string;
  storage_path: string;
  filename: string;
  candidate_name: string | null;
  expires_at: string;
  downloads: number;
}

/** Guard against a pathological path being used as a lookup key. */
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

function problem(message: string, status: number) {
  return new NextResponse(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  if (!token || !TOKEN_RE.test(token)) {
    return problem('This download link is not valid.', 404);
  }

  const sb = getSupabaseServiceClient();

  const { data, error } = await sb
    .from('presentation_files')
    .select('id, storage_path, filename, candidate_name, expires_at, downloads')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    console.error('[files/presentation] lookup failed:', error.message);
    return problem('Could not look up this download right now. Please try again.', 500);
  }
  if (!data) {
    return problem('This download link is not valid.', 404);
  }

  const row = data as unknown as FileRow;

  if (Date.parse(row.expires_at) <= Date.now()) {
    return problem(
      'This download link has expired. Ask Cortex to prepare a fresh copy of the presentation.',
      410,
    );
  }

  // Bucket declared in infra/supabase/migrations/0044_presentation_files.sql and
  // mirrored as PRESENTATION_BUCKET in agent-tools' presentations/storage.ts.
  // Kept as a literal here so a download never drags the whole tool registry
  // (and its side-effect registrations) into this route's bundle.
  const { data: file, error: downloadError } = await sb.storage
    .from('presentation-files')
    .download(row.storage_path);

  if (downloadError || !file) {
    console.error('[files/presentation] storage read failed:', downloadError?.message);
    return problem('The file behind this link is no longer available.', 404);
  }

  // Count the download before streaming. Fire-and-forget: a failed counter must
  // never cost the user their file, and the audit value is in the trend.
  void sb
    .from('presentation_files')
    .update({ downloads: row.downloads + 1 })
    .eq('id', row.id)
    .then(({ error: bumpError }) => {
      if (bumpError) console.error('[files/presentation] counter bump failed:', bumpError.message);
    });

  const bytes = await file.arrayBuffer();

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(bytes.byteLength),
      // filename is stored already reduced to ASCII word characters
      // (packages/agent-tools/src/presentations/storage.ts#safeFilename),
      // because header values are latin-1 and "José Peña" would be rejected.
      'Content-Disposition': `attachment; filename="${row.filename}"`,
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
