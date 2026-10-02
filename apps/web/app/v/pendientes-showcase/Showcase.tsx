'use client';

import { WaitingIndex } from '@/app/(app)/dashboard/_components/WaitingIndex';
import { ProposedActionCard } from '@/components/actions/ProposedActionCard';
import { ApprovalGroup } from '@/components/approvals/ApprovalGroup';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import type { ActionView } from '@/lib/actions-shape';
import type { GroupView } from '@/lib/follow-through/pending-groups';
import type { WaitingIndex as WaitingIndexData } from '@/lib/waiting';
import { Send } from 'lucide-react';
import { useEffect } from 'react';

/**
 * Lo pendiente con datos inventados: Acciones agrupadas, «Te espera» con lo
 * viejo marcado y la revisión semanal con «Lo que recomendé y qué pasó». Los
 * botones llaman a las rutas de verdad; en esta página no hay sesión y
 * contestan que no.
 */
export function PendientesFixture({
  dark,
  pantalla,
  actions,
  weekly,
  waiting,
}: {
  dark: boolean;
  pantalla: 'acciones' | 'semana' | 'espera';
  actions: { stale: GroupView | null; groups: GroupView[]; views: Record<string, ActionView> };
  weekly: { markdown: string };
  waiting: WaitingIndexData;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  const cards = (ids: readonly string[]) =>
    ids.map((id) => {
      const view = actions.views[id];
      return view ? <ProposedActionCard key={id} action={view} /> : null;
    });

  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 md:py-7">
        {pantalla === 'acciones' && (
          <>
            <PageHeader
              title="Acciones"
              subtitle="Lo que Cortex ya redactó y espera tu visto bueno"
              icon={<Send className="h-5 w-5" />}
            />
            <div className="space-y-3">
              {actions.stale && (
                <ApprovalGroup
                  queue="actions"
                  mode="discard"
                  title={actions.stale.title}
                  subtitle={actions.stale.subtitle}
                  actionLabel={actions.stale.actionLabel}
                  items={actions.stale.items}
                >
                  {cards(actions.stale.ids)}
                </ApprovalGroup>
              )}
              {actions.groups.map((g) => (
                <ApprovalGroup
                  key={g.key}
                  queue="actions"
                  title={g.title}
                  subtitle={g.subtitle}
                  actionLabel={g.actionLabel}
                  items={g.items}
                >
                  {cards(g.ids)}
                </ApprovalGroup>
              ))}
            </div>
          </>
        )}
        {pantalla === 'semana' && (
          <Panel className="p-6">
            <ChatMarkdown content={weekly.markdown} />
          </Panel>
        )}
        {pantalla === 'espera' && <WaitingIndex index={waiting} />}
      </main>
    </div>
  );
}
