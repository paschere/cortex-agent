import { MobileSidebarProvider } from '@/components/nav/MobileSidebarContext';
import { Sidebar } from '@/components/nav/Sidebar';
import { countPendingApprovals } from '@/lib/nav-signals';
import { requireSession } from '@/lib/session';
import type { ReactNode } from 'react';

export default async function ChatLayout({ children }: { children: ReactNode }) {
  const user = await requireSession();
  const pendingApprovals = await countPendingApprovals(user.id);
  return (
    <MobileSidebarProvider>
      <div className="flex flex-row h-screen overflow-hidden">
        <Sidebar role={user.role} pendingApprovals={pendingApprovals} />
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">{children}</div>
      </div>
    </MobileSidebarProvider>
  );
}
