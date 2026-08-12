import { loadDetail } from '@/lib/errands/repository';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { notFound } from 'next/navigation';
import { ErrandView } from './_components/ErrandView';

export const dynamic = 'force-dynamic';

export default async function ErrandPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await params;

  // Scoped to the active workspace, so an errand id from another tenant is a
  // 404 rather than somebody else's research.
  const detail = await loadDetail(
    getOrgScopedClient(user.organization.id),
    id,
    user.organization.id,
  );
  if (!detail) notFound();

  return <ErrandView initial={detail} />;
}
