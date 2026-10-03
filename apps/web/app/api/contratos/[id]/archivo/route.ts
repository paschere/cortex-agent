import { readBranding, readLogo } from '@/lib/branding/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  bogotaToday,
  canSeeContract,
  getContract,
  isCompanyManager,
  renderContractDocx,
  renderContractPdf,
} from '@cortex/agent-tools';
import type { NextRequest } from 'next/server';

/**
 * El borrador de un contrato como archivo (0195): PDF con la marca de la
 * empresa o Word (.docx) editable. Los dos llevan la marca «Borrador para
 * revisión de un abogado». Con sesión, y un contrato laboral sólo para quien
 * lo puede ver.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession().catch(() => null);
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const db = getOrgScopedClient(user.organization.id);
  const row = await getContract(db, id);
  if (!row || !row.body_text) return new Response('Not found', { status: 404 });
  const manager = await isCompanyManager(db, user.id);
  if (!canSeeContract(row, { userId: user.id, manager }))
    return new Response('Not found', { status: 404 });
  const branding = await readBranding(db);
  const name = branding?.display_name?.trim() || user.organization.name || 'Cortex';
  const base =
    row.title
      .replace(/[^\p{L}\p{N} _-]+/gu, '')
      .trim()
      .slice(0, 80) || 'contrato';
  const ascii = base
    .normalize('NFD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, '_');
  const headers = {
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.nextUrl.searchParams.get('formato') === 'docx') {
    const bytes = renderContractDocx({ title: row.title, text: row.body_text, companyName: name });
    return new Response(new Uint8Array(bytes), {
      headers: {
        ...headers,
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${ascii}_borrador.docx"`,
      },
    });
  }
  const logo = await readLogo(db).catch(() => null);
  const bytes = renderContractPdf({
    title: row.title,
    text: row.body_text,
    brand: { name, primary: branding?.primary_color ?? null, logo: logo?.content ?? null },
    generatedOn: bogotaToday(),
  });
  return new Response(new Uint8Array(bytes), {
    headers: {
      ...headers,
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${ascii}_borrador.pdf"`,
    },
  });
}
