'use client';

import {
  type AtencionActions,
  AtencionConsole,
  type SelectedConversation,
} from '@/app/(app)/integrations/whatsapp/atencion/_components/AtencionConsole';
import { PageHeader } from '@/components/ui/page-header';
import type { AtencionPerson, AtencionTracker } from '@/lib/whatsapp/atencion-shape';
import type { ConversationListItem, CustomerSettings } from '@cortex/agent-tools';
import { Headset } from 'lucide-react';
import { useEffect } from 'react';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Acciones de mentira: tardan un poco y contestan como las de verdad. */
const ACTIONS: AtencionActions = {
  saveSettings: async () => {
    await wait(600);
    return { ok: true, note: 'Guardado. El número ya le contesta a los clientes que escriban.' };
  },
  reply: async () => {
    await wait(600);
    return { ok: true, note: 'En cola: sale por WhatsApp en menos de un minuto.' };
  },
  close: async () => {
    await wait(600);
    return { ok: true, note: 'Cerrada.' };
  },
};

export function AtencionShowcase(props: {
  dark: boolean;
  now: string;
  settings: CustomerSettings;
  conversations: ConversationListItem[];
  selected: SelectedConversation | null;
  people: AtencionPerson[];
  trackers: AtencionTracker[];
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = props.dark ? 'dark' : 'light';
  }, [props.dark]);
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-4 py-6 md:px-8 md:py-8">
        <PageHeader
          title="Atención a clientes"
          subtitle="Lo que tus clientes preguntan por WhatsApp: estado de su pedido, sus facturas y su saldo. Cortex contesta con tus datos y, si no sabe, se lo pasa a una persona."
          icon={<Headset className="h-5 w-5" />}
        />
        <AtencionConsole
          now={props.now}
          settings={props.settings}
          conversations={props.conversations}
          selected={props.selected}
          people={props.people}
          trackers={props.trackers}
          canManage
          bridgeConnected
          actions={ACTIONS}
          basePath="/v/atencion-showcase"
        />
      </main>
    </div>
  );
}
