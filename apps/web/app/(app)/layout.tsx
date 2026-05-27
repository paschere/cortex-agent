import type { ReactNode } from 'react';
import { Sidebar } from '@/components/nav/Sidebar';
import { requireSession } from '@/lib/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireSession();
  return (
    <div className="grid grid-cols-[240px_1fr] min-h-screen">
      <Sidebar role={user.role} />
      <main className="p-6 max-w-5xl">{children}</main>
    </div>
  );
}
