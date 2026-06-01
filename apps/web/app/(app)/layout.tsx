import type { ReactNode } from 'react';
import { Sidebar } from '@/components/nav/Sidebar';
import { Topbar } from '@/components/nav/Topbar';
import { MobileSidebarProvider } from '@/components/nav/MobileSidebarContext';
import { requireSession } from '@/lib/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireSession();
  return (
    <MobileSidebarProvider>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar role={user.role} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar email={user.email} />
          <main className="scroll-slim flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">{children}</div>
          </main>
        </div>
      </div>
    </MobileSidebarProvider>
  );
}
