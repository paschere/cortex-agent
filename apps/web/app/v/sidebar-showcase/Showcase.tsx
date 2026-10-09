'use client';

import { CommandMenuProvider } from '@/components/nav/CommandMenuContext';
import { MobileSidebarProvider } from '@/components/nav/MobileSidebarContext';
import { MobileTabBar } from '@/components/nav/MobileTabBar';
import { SidebarBody } from '@/components/nav/Sidebar';
import { applyTheme } from '@/components/nav/ThemeToggle';
import { PanelProvider } from '@/components/panel/PanelHost';
import type { ReactNode } from 'react';
import { useEffect } from 'react';

const ORG = {
  id: 'fixture',
  name: 'Transportes Andinos',
  slug: null,
  role: 'owner',
  kind: 'company',
} as const;
const COUNTS = { approvals: 2, commitments: 1, actions: 0, errands: 3 };
const NONE = { approvals: 0, commitments: 0, actions: 0, errands: 0 };
const USER = { name: 'Mateo Ángel', email: 'mateo@transportesandinos.co' };
const RECENT = [
  { id: 'a', title: 'Cartera vencida de septiembre' },
  { id: 'b', title: 'Cotización para Frigoandes' },
  { id: 'c', title: 'Resumen de la semana' },
];

function Frame({ title, width, children }: { title: string; width: number; children: ReactNode }) {
  return (
    <figure className="shrink-0">
      <figcaption className="mb-2 text-xs font-semibold text-ink-muted">{title}</figcaption>
      <div
        style={{ width }}
        className="workspace-rail flex h-[760px] flex-col overflow-hidden rounded-card border border-rail-border bg-rail shadow-card"
      >
        {children}
      </div>
    </figure>
  );
}

const base = {
  role: 'org_admin' as const,
  organization: ORG,
  modulesOff: [],
  user: USER,
  onExpand: () => {},
  recentOverride: RECENT,
};

/** Datos inventados. Ninguna cifra de aquí sale de una base de datos. */
export function SidebarShowcase({ dark }: { dark: boolean }) {
  useEffect(() => {
    applyTheme(dark ? 'dark' : 'light');
  }, [dark]);
  return (
    <MobileSidebarProvider>
      {/* biome-ignore lint/a11y/useValidAriaRole: `role` es el rol de Cortex, no de ARIA. */}
      <CommandMenuProvider role="org_admin">
        <PanelProvider>
          <div className="cortex-workspace min-h-screen bg-canvas p-6">
            <div className="flex flex-wrap items-start gap-6">
              <Frame title="Expandido · con insignias y puesta en marcha (3 de 5)" width={264}>
                <SidebarBody
                  {...base}
                  small={false}
                  counts={COUNTS}
                  signals={{ pilot: 4, setup: { ready: 3, total: 5 } }}
                  pathOverride="/piloto"
                  onToggleCollapsed={() => {}}
                />
              </Frame>
              <Frame
                title="Expandido · «Te espera» abierto (cola activa), sin puesta en marcha"
                width={264}
              >
                <SidebarBody
                  {...base}
                  small={false}
                  counts={COUNTS}
                  signals={{ pilot: 0, setup: null }}
                  pathOverride="/commitments"
                  onToggleCollapsed={() => {}}
                />
              </Frame>
              <Frame title="Expandido · todo en calma" width={264}>
                <SidebarBody
                  {...base}
                  small={false}
                  counts={NONE}
                  signals={{ pilot: 0, setup: null }}
                  pathOverride="/chat/a"
                  onToggleCollapsed={() => {}}
                />
              </Frame>
              <Frame title="Contraído · 56px" width={56}>
                <SidebarBody
                  {...base}
                  small
                  counts={COUNTS}
                  signals={{ pilot: 4, setup: { ready: 3, total: 5 } }}
                  pathOverride="/views"
                  onToggleCollapsed={() => {}}
                  pinnedCollapsed
                />
              </Frame>
              <Frame title="Cajón del teléfono · 320px" width={320}>
                <SidebarBody
                  {...base}
                  small={false}
                  counts={COUNTS}
                  signals={{ pilot: 4, setup: { ready: 3, total: 5 } }}
                  pathOverride="/apps"
                  onNavigate={() => {}}
                />
              </Frame>
              <figure className="w-[375px] shrink-0">
                <figcaption className="mb-2 text-xs font-semibold text-ink-muted">
                  Barra de pestañas · 375px
                </figcaption>
                <div className="overflow-hidden rounded-card border border-border">
                  <div className="h-24 bg-canvas" />
                  {/* La barra es `md:hidden`: aquí se fuerza visible con un wrapper. */}
                  <div className="[&_nav]:!grid">
                    <MobileTabBar organizationId="fixture" />
                  </div>
                </div>
              </figure>
            </div>
          </div>
        </PanelProvider>
      </CommandMenuProvider>
    </MobileSidebarProvider>
  );
}
