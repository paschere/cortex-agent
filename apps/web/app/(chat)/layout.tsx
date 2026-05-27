import type { ReactNode } from 'react';
import { requireSession } from '@/lib/session';

export default async function ChatLayout({ children }: { children: ReactNode }) {
  await requireSession();
  return <div className="h-screen flex flex-col">{children}</div>;
}
