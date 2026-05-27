import { CollectionView } from '../_components/CollectionView';
import { requireSession } from '@/lib/session';

export default async function MyKb() {
  const user = await requireSession();
  return (
    <CollectionView scope="user" scopeId={user.id} title="My Knowledge Base" />
  );
}
