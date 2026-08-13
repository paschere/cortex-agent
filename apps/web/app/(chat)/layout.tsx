import { CommandMenuProvider } from '@/components/nav/CommandMenuContext';
import { MobileSidebarProvider } from '@/components/nav/MobileSidebarContext';
import { Sidebar } from '@/components/nav/Sidebar';
import { countNavSignals } from '@/lib/nav-signals';
import { requireSession } from '@/lib/session';
import { REPORT_CSS } from '@cortex/agent-tools';
import type { ReactNode } from 'react';

/**
 * The chart stylesheet is injected here, once, rather than by the card that
 * uses it.
 *
 * A chat turn can draw several charts and a scrolled-back conversation can hold
 * dozens; a `<style>` per card would be the same four kilobytes repeated down
 * the page. It also has to come from a SERVER component: `REPORT_CSS` is a
 * value in `@cortex/agent-tools`, and that barrel reaches `node:dns` — importing
 * a value from it inside a `'use client'` file fails the production build while
 * typecheck and tests stay green. See apps/web/lib/reports-shape.ts for the
 * time that shipped.
 *
 * Every rule in it is scoped to `.rp-doc`, so it cannot reach the app's own
 * chrome; `ChartCard` puts that class on its wrapper.
 */
export default async function ChatLayout({ children }: { children: ReactNode }) {
  const user = await requireSession();
  const counts = await countNavSignals(user.organization.id, user.id);
  return (
    <MobileSidebarProvider>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: our own stylesheet, scoped to .rp-doc; see REPORT_CSS. */}
      <style dangerouslySetInnerHTML={{ __html: REPORT_CSS }} />
      <CommandMenuProvider role={user.role}>
        <div className="flex flex-row h-screen overflow-hidden">
          <Sidebar role={user.role} counts={counts} />
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">{children}</div>
        </div>
      </CommandMenuProvider>
    </MobileSidebarProvider>
  );
}
