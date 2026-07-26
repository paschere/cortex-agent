import { CollectionView } from '../_components/CollectionView';
import { requireSession } from '@/lib/session';
import { notFound } from 'next/navigation';

export default async function GlobalKb() {
  const user = await requireSession();
  if (user.role !== 'org_admin') notFound();
  return (
    <CollectionView
      scope="global"
      scopeId={null}
      title="Global Knowledge Base"
      subtitle="Org-wide documents available to every agent and teammate"
    />
  );
}
