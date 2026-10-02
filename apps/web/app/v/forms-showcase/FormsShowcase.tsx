'use client';

import { type ApiWizardClient, ConnectApiWizard } from '@/app/(app)/feed/ConnectApiWizard';
import { EditRoutineDialog } from '@/app/(app)/schedules/_components/EditRoutineDialog';
import type { ScheduledJob } from '@/app/(app)/schedules/_components/types';
import { SchedulePickerField } from '@/components/forms/SchedulePickerField';
import { Panel, PanelHead } from '@/components/ui/panel';
import type { FeedEntry } from '@/lib/feed/shared';
import { type ScheduleDraft, draftFromSchedule } from '@/lib/schedule-picker';
import { AlarmClock, Plug } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

/** Datos inventados. Nada de aquí sale de una base de datos ni de una API real. */
const JOB: ScheduledJob = {
  id: 'fixture-job',
  name: 'Cartera vencida del lunes',
  kind: 'agent',
  toolId: null,
  instruction: 'Resume la cartera vencida y avísame de los clientes nuevos en mora.',
  scheduleKind: 'cron',
  cron: '0 8 * * 1-5',
  timezone: 'America/Bogota',
  runAt: null,
  status: 'active',
  nextRunAt: null,
  lastRunAt: null,
  allowUnattendedWrites: false,
  notifyEmail: true,
  conversationId: null,
  recipients: ['gerencia@example.com'],
  isGlobal: false,
  ownerId: 'fixture-user',
  runs: [],
};

const RESPONSE = {
  meta: { total: 128, next_cursor: 'eyJwYWdlIjoyfQ' },
  data: {
    orders: [
      {
        id: 'PED-1042',
        cliente: { nombre: 'Ferretería El Tornillo', ciudad: 'Medellín' },
        total: 1840000,
        estado: 'pagado',
        creado: '2026-10-01',
      },
      {
        id: 'PED-1043',
        cliente: { nombre: 'Distribuidora Andina', ciudad: 'Bogotá' },
        total: 920500,
        estado: 'pendiente',
        creado: '2026-10-01',
      },
      {
        id: 'PED-1044',
        cliente: { nombre: 'Café La Montaña', ciudad: 'Manizales' },
        total: 312000,
        estado: 'pagado',
        creado: '2026-10-02',
      },
      {
        id: 'PED-1045',
        cliente: { nombre: 'Textiles del Valle', ciudad: 'Cali' },
        total: 2450000,
        estado: 'enviado',
        creado: '2026-10-02',
      },
      {
        id: 'PED-1046',
        cliente: { nombre: 'Panadería Santa Fe', ciudad: 'Bogotá' },
        total: 87000,
        estado: 'pendiente',
        creado: '2026-10-02',
      },
      {
        id: 'PED-1047',
        cliente: { nombre: 'Agro Llanos', ciudad: 'Villavicencio' },
        total: 1290000,
        estado: 'pagado',
        creado: '2026-10-02',
      },
      {
        id: 'PED-1048',
        cliente: { nombre: 'Óptica Visión', ciudad: 'Pereira' },
        total: 455000,
        estado: 'enviado',
        creado: '2026-10-02',
      },
    ],
    warehouses: [{ id: 'BOD-1' }, { id: 'BOD-2' }],
  },
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeClient(admin: boolean, failing: boolean): ApiWizardClient {
  const entry: FeedEntry = {
    id: 'fixture-entry',
    filename: 'API · Pedidos',
    feed_kind: 'api',
    source_url: null,
    created_at: new Date().toISOString(),
    purge_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    byte_size: 2048,
    conversation_id: null,
    promoted_document_id: null,
    feed_truncated: false,
  };
  return {
    async listApis() {
      await wait(150);
      return {
        canConfigure: admin,
        tools: [
          {
            id: 'fixture-tool',
            name: 'Pedidos de la tienda',
            description: 'Lista los pedidos de la tienda en línea, filtrables por estado.',
            fields: [
              { name: 'estado', required: false, description: 'pagado, pendiente o enviado' },
            ],
          },
        ],
      };
    },
    async saveTool(draft) {
      await wait(400);
      return {
        ok: true,
        warning: null,
        tool: {
          id: 'fixture-new',
          toolId: 'custom.fixture',
          name: draft.name,
          description: draft.description,
          requiresConfirmation: false,
          enabled: draft.enabled,
          authConfigured: draft.authType !== 'none',
        },
      };
    },
    async deleteTool() {},
    async testTool() {
      await wait(900);
      if (failing)
        return {
          ok: false,
          response: {
            status: 401,
            statusText: 'Unauthorized',
            headers: {},
            body: '{"error":"invalid key"}',
            truncated: false,
          },
          modelResult: { ok: false, status: 401 },
        };
      return {
        ok: true,
        elapsedMs: 342,
        response: {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: JSON.stringify(RESPONSE),
          truncated: false,
        },
        modelResult: { ok: true, status: 200, data: RESPONSE },
      };
    },
    async capture() {
      await wait(700);
      return { entry, sourceId: 'fixture-source' };
    },
    async readTables() {
      return {
        text: '',
        rows: [
          ['id', 'cliente.nombre', 'total', 'estado'],
          ...RESPONSE.data.orders.map((o) => [o.id, o.cliente.nombre, o.total, o.estado]),
        ],
      };
    },
    async updateSource() {
      await wait(200);
    },
  };
}

export function FormsShowcase({
  dark,
  panel,
  dialog,
  admin,
  failing,
}: {
  dark: boolean;
  panel: string | null;
  dialog: boolean;
  admin: boolean;
  failing: boolean;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  const [schedule, setSchedule] = useState<ScheduleDraft>(() =>
    draftFromSchedule({ scheduleKind: 'cron', cron: '0 8 * * 1-5', timezone: 'America/Bogota' }),
  );
  const [editing, setEditing] = useState<ScheduledJob | null>(dialog ? JOB : null);
  const client = useMemo(() => fakeClient(admin, failing), [admin, failing]);
  const showRoutine = panel !== 'api';
  const showApi = panel !== 'rutina';

  return (
    <div className="min-h-screen bg-canvas px-4 py-8 md:px-8">
      <div className="mx-auto grid w-full max-w-[1100px] gap-6 lg:grid-cols-2">
        {showRoutine && (
          <Panel className="min-w-0 pb-6">
            <PanelHead
              icon={<AlarmClock className="h-4 w-4" />}
              title="Horario de una rutina"
              right={
                <button
                  type="button"
                  onClick={() => setEditing(JOB)}
                  className="font-semibold text-primary"
                >
                  Abrir el diálogo
                </button>
              }
            />
            <div className="px-6 pt-4">
              <SchedulePickerField value={schedule} onChange={setSchedule} idPrefix="showcase" />
            </div>
          </Panel>
        )}
        {showApi && (
          <Panel className={panel === 'api' ? 'min-w-0 pb-6 lg:col-span-2' : 'min-w-0 pb-6'}>
            <PanelHead icon={<Plug className="h-4 w-4" />} title="Conectar una API" />
            <div className="px-6 pt-4">
              <ConnectApiWizard client={client} onAdded={() => undefined} showAdminEditor={false} />
            </div>
          </Panel>
        )}
      </div>
      <EditRoutineDialog
        job={editing}
        onClose={() => setEditing(null)}
        onSaved={() => setEditing(null)}
      />
    </div>
  );
}
