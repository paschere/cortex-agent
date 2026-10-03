import { DraftView } from '@/components/tax/DraftView';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { buildDraftScreen } from '@/lib/tax/draft-screen';
import { taxTabLinks } from '@/lib/tax/tabs';
import { workspaceHref } from '@/lib/workspace-context';
import {
  bogotaToday,
  buildDraftFromData,
  canMarkTaxObligations,
  draftTargetFor,
  getTaxObligation,
  listDirectory,
  liveDraftFor,
  personLabel,
  readTaxProfile,
} from '@cortex/agent-tools';
import { notFound, redirect } from 'next/navigation';
import {
  annulTaxDraftAction,
  presentTaxDraftAction,
  reviewTaxDraftAction,
  saveTaxDraftAction,
} from '../../actions';

export const dynamic = 'force-dynamic';

/**
 * EL BORRADOR DE UNA DECLARACIÓN (0197). Se arma al abrir, con los datos de
 * ese momento (ventas, compras, nómina, estados); si ya está revisado o
 * presentado, se muestran las cifras congeladas. Cualquiera de la empresa lo
 * ve; guardarlo y marcarlo es del responsable de impuestos o de quien
 * administra (lo revisa el store).
 */
export default async function TaxDraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const href = (path: string) => workspaceHref(user.organization.id, path);
  const [obligation, profile] = await Promise.all([getTaxObligation(db, id), readTaxProfile(db)]);
  if (!profile) redirect(href('/impuestos'));
  if (!obligation) notFound();
  const target = draftTargetFor(obligation);
  if (!target) notFound();
  const today = bogotaToday();
  const [saved, canAct, directory] = await Promise.all([
    liveDraftFor(db, id),
    canMarkTaxObligations(db, user.id, profile),
    listDirectory(db).catch(() => []),
  ]);
  const figures =
    saved && saved.status !== 'borrador'
      ? saved.figures
      : await buildDraftFromData(db, { profile, target, today, viewerId: user.id });
  const data = buildDraftScreen({
    obligation,
    figures,
    saved,
    today,
    canAct,
    href,
    tabs: taxTabLinks(href),
    people: new Map(directory.map((p) => [p.id, personLabel(p)])),
  });
  return (
    <DraftView
      data={data}
      actions={{
        save: saveTaxDraftAction.bind(null, id),
        review: reviewTaxDraftAction.bind(null, id),
        present: presentTaxDraftAction.bind(null, id),
        annul: annulTaxDraftAction.bind(null, id),
      }}
    />
  );
}
