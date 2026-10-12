'use client';

import { ConfirmationGroup } from '@/components/chat/ConfirmationGroup';
import { ConfirmationPrompt } from '@/components/chat/ConfirmationPrompt';
import { PlanApprovalCard } from '@/components/chat/PlanApprovalCard';
import type { PlanState } from '@/lib/plan-state';
import { useEffect } from 'react';

const PLAN: PlanState = {
  title: 'Armar la cartera de la costa',
  lastCallId: 'p1',
  steps: [
    {
      id: '1',
      label: 'Crear la tabla de clientes',
      status: 'pending',
      what: 'Crea «Clientes de la costa» con NIT, saldo y estado.',
      tools: ['trackers.define'],
    },
    {
      id: '2',
      label: 'Cargar las filas del extracto',
      status: 'pending',
      what: 'Anota 38 filas con lo que debe cada cliente.',
      tools: ['trackers.upsert'],
    },
    {
      id: '3',
      label: 'Crear la vista «Cobros de la semana»',
      status: 'pending',
      tools: ['views.create'],
    },
    {
      id: '4',
      label: 'Avisar a los clientes vencidos',
      status: 'pending',
      what: 'Un correo por cliente con su saldo.',
      tools: ['gmail.send_message'],
    },
    { id: '5', label: 'Revisar el resultado', status: 'pending' },
  ],
};

const SCOPE = {
  grantable: ['trackers.define', 'trackers.upsert', 'views.create'],
  alwaysAsk: ['gmail.send_message'],
};

const ROW_INPUT = {
  tracker: 'clientes-costa',
  rowId: '11111111-1111-4111-8111-111111111111',
  values: { estado: 'Pagado', saldo: 0, nota: 'Pagó por transferencia el 9 de octubre' },
};
const ROW_BEFORE = {
  before: { estado: 'Vencida', saldo: 12000000, nota: 'Pagó por transferencia el 9 de octubre' },
  fieldLabels: { estado: 'Estado', saldo: 'Saldo', nota: 'Nota' },
  trackerName: 'Clientes de la costa',
};

const MAIL = {
  to: 'tesoreria@coltrans.example',
  subject: 'Saldo pendiente de la factura FV-2024',
  body: 'Hola, te escribo de parte de la empresa. Tu factura FV-2024 por $ 42.350.000 vence el 3 de octubre y tiene un saldo de $ 12.000.000. ¿Nos confirmas la fecha de pago?',
};

export function ApprovalsShowcase({ dark, granted }: { dark: boolean; granted: boolean }) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return (
    <div className="mx-auto min-h-screen max-w-2xl space-y-8 bg-canvas px-4 py-8">
      <section className="space-y-2">
        <h2 className="text-micro font-semibold text-ink-faint">1 · Aprobar el plan</h2>
        <PlanApprovalCard
          conversationId="00000000-0000-4000-8000-000000000001"
          plan={PLAN}
          preset={{
            scope: SCOPE,
            grant: granted
              ? {
                  id: 'g1',
                  tools: SCOPE.grantable,
                  expiresAt: new Date(Date.now() + 28 * 60_000).toISOString(),
                  maxCalls: 20,
                }
              : null,
          }}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-micro font-semibold text-ink-faint">
          2 · Una acción: antes → después (reversible)
        </h2>
        <ConfirmationPrompt
          conversationId="00000000-0000-4000-8000-000000000001"
          toolId="trackers.upsert"
          input={ROW_INPUT}
          toolCallId="c1"
          why="Entró el pago de Coltrans en el extracto de ayer, así que dejo la factura como pagada."
          previewPreset={ROW_BEFORE}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-micro font-semibold text-ink-faint">3 · Un correo (irreversible)</h2>
        <ConfirmationPrompt
          conversationId="00000000-0000-4000-8000-000000000001"
          toolId="gmail.send_message"
          input={MAIL}
          toolCallId="c2"
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-micro font-semibold text-ink-faint">
          4 · Varias a la vez: «Aprobar las N» (la de borrar queda a mano)
        </h2>
        <ConfirmationGroup
          conversationId="00000000-0000-4000-8000-000000000001"
          items={[
            {
              toolCallId: 'g1',
              toolId: 'trackers.upsert',
              input: {
                tracker: 'clientes-costa',
                values: { cliente: 'Transportes del Sur', saldo: 5400000 },
              },
            },
            {
              toolCallId: 'g2',
              toolId: 'trackers.upsert',
              input: {
                tracker: 'clientes-costa',
                values: { cliente: 'Frutas del Caribe', saldo: 870000 },
              },
            },
            {
              toolCallId: 'g3',
              toolId: 'trackers.remove',
              input: { tracker: 'clientes-costa', rowId: '22222222-2222-4222-8222-222222222222' },
            },
          ]}
        />
      </section>
    </div>
  );
}
