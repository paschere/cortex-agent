import { GlobalChat } from '@/components/overview/GlobalChat';
import { requireSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function GlobalChatPage() {
  await requireSession();
  return <GlobalChat />;
}
