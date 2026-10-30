import { BillingBanner } from '@/components/billing/BillingBanner';
import { GridUserProvider } from '@/components/datagrid/prefs-context';
import { ConsentGate } from '@/components/legal/ConsentGate';
import { AppShell } from '@/components/nav/AppShell';
import { AreaTabs } from '@/components/nav/AreaTabs';
import { MobileTabBar } from '@/components/nav/MobileTabBar';
import { Topbar } from '@/components/nav/Topbar';
import { modulesOffFor } from '@/lib/modules/server';
import { readAreaTabCounts } from '@/lib/nav-signals';
import { requireSession } from '@/lib/session';
import type { ReactNode } from 'react';

/**
 * Todo lo que no es el chat: una barra superior y una columna centrada con su
 * propio scroll. Es la única diferencia que queda con `app/(chat)/layout.tsx`
 * — el resto del shell está en `AppShell`.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  // Deliberately NOT wrapped in try/catch with a redirect: letting
  // requireSession throw is what keeps every page under this layout out of the
  // build-time prerender pass. Catching it made Next try to statically render
  // /agents, which then failed on env vars that only exist at runtime. The
  // middleware is what turns a signed-out visit into a redirect.
  const user = await requireSession();
  // La misma lectura que hace el shell, servida por `cache` (lib/modules/server).
  const [modulesOff, tabCounts] = await Promise.all([
    modulesOffFor(user.organization.id),
    readAreaTabCounts(user.organization.id, user.id),
  ]);
  return (
    <AppShell user={user}>
      <div className="cortex-sheet flex min-w-0 flex-1 flex-col">
        <Topbar email={user.email} />
        <BillingBanner organizationId={user.organization.id} />
        <main className="scroll-slim flex-1 overflow-y-auto print:overflow-visible">
          <div className="app-shell-main mx-auto w-full max-w-[1440px] px-4 py-6 md:px-8 md:py-8">
            <AreaTabs
              admin={user.role === 'org_admin'}
              modulesOff={modulesOff}
              organizationId={user.organization.id}
              userKey={user.email}
              counts={tabCounts}
            />
            <GridUserProvider userKey={user.email}>{children}</GridUserProvider>
          </div>
        </main>
        <MobileTabBar organizationId={user.organization.id} modulesOff={modulesOff} />
      </div>
      <ConsentGate organizationId={user.organization.id} />
    </AppShell>
  );
}
