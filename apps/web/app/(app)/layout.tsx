import type { ReactNode } from 'react';
import { Sidebar } from '@/components/nav/Sidebar';
import { Topbar } from '@/components/nav/Topbar';
import { MobileSidebarProvider } from '@/components/nav/MobileSidebarContext';
import { requireSession } from '@/lib/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Deliberately NOT wrapped in try/catch with a redirect: letting
  // requireSession throw is what keeps every page under this layout out of the
  // build-time prerender pass. Catching it made Next try to statically render
  // /agents, which then failed on env vars that only exist at runtime. The
  // middleware is what turns a signed-out visit into a redirect.
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
