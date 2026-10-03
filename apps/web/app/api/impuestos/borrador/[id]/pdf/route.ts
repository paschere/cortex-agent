import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  DRAFT_STATUS_LABEL,
  bogotaToday,
  buildDraftFromData,
  draftTargetFor,
  getTaxObligation,
  liveDraftFor,
  loadPoBrand,
  readTaxProfile,
  renderDraftPdf,
} from '@cortex/agent-tools';

/**
 * El PDF del borrador de una declaración (0197), con la marca de la empresa y
 * la advertencia «Borrador — tu contador revisa y presenta» en cada página.
 * Se lee con el handle de la empresa de la sesión: un id ajeno es 404.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const notFound = () =>
  new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [obligation, profile] = await Promise.all([getTaxObligation(db, id), readTaxProfile(db)]);
  if (!obligation || !profile) return notFound();
  const target = draftTargetFor(obligation);
  if (!target) return notFound();
  const today = bogotaToday();
  const saved = await liveDraftFor(db, id);
  const figures =
    saved && saved.status !== 'borrador'
      ? saved.figures
      : await buildDraftFromData(db, { profile, target, today, viewerId: user.id });
  const brand = await loadPoBrand(db, user.organization.id);
  const pdf = renderDraftPdf(figures, brand, {
    issuedOn: today,
    statusLabel: saved ? DRAFT_STATUS_LABEL[saved.status] : 'Borrador sin guardar',
    nit: `${profile.nit}${profile.dv ? `-${profile.dv}` : ''}`,
  });
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="borrador-${figures.kind}-${figures.period.from}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
