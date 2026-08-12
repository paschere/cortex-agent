import { CommandMenuProvider } from '@/components/nav/CommandMenuContext';
import { MobileSidebarProvider } from '@/components/nav/MobileSidebarContext';
import { Sidebar } from '@/components/nav/Sidebar';
import { Topbar } from '@/components/nav/Topbar';
import { countPendingApprovals } from '@/lib/nav-signals';
import { requireSession } from '@/lib/session';
import type { ReactNode } from 'react';

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Deliberately NOT wrapped in try/catch with a redirect: letting
  // requireSession throw is what keeps every page under this layout out of the
  // build-time prerender pass. Catching it made Next try to statically render
  // /agents, which then failed on env vars that only exist at runtime. The
  // middleware is what turns a signed-out visit into a redirect.
  const user = await requireSession();
  const pendingApprovals = await countPendingApprovals(user.organization.id, user.id);
  return (
    <MobileSidebarProvider>
      <CommandMenuProvider role={user.role}>
        <div className="flex h-screen overflow-hidden bg-canvas">
          <Sidebar role={user.role} pendingApprovals={pendingApprovals} />
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar email={user.email} />
            <main className="scroll-slim flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">{children}</div>
            </main>
          </div>
        </div>
      </CommandMenuProvider>
    </MobileSidebarProvider>
  );
}
