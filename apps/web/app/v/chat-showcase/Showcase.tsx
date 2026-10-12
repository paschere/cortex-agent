'use client';

import {
  ArtifactPanel,
  type ChatArtifact,
  ChatArtifactsProvider,
  type PanelTab,
} from '@/components/chat/ChatArtifacts';
import { BackgroundBanner } from '@/components/chat/BackgroundBanner';
import { ChatComposeProvider } from '@/components/chat/ChatCompose';
import { ChatErrorCard } from '@/components/chat/ChatErrorCard';
import { ConversationHeader } from '@/components/chat/ConversationHeader';
import { FollowUps } from '@/components/chat/FollowUps';
import { InputBar } from '@/components/chat/InputBar';
import { MessageList } from '@/components/chat/MessageList';
import { ThreadAside, ThreadHistory } from '@/components/chat/ThreadHistory';
import { DeclaredTable } from '@/components/chat/results/DeclaredTable';
import { TABLE as DECLARED } from '@/components/chat/results/registry';
import { FIXTURE_FILES, FIXTURE_TASKS } from '@/lib/background-tasks/fixtures';
import { type BrowserStep, browserSteps } from '@/lib/browser-live-steps';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Message } from 'ai';
import { useEffect, useState } from 'react';

const ago = (days: number, h = 10) =>
  new Date(Date.now() - days * 86_400_000 - h * 0).toISOString();
const THREADS = [
  { id: 'c1', title: '¿Qué tengo pendiente hoy?', updated_at: ago(0) },
  {
    id: 'c2',
    title:
      'Revisa esta carpeta de Drive y dime cuánto nos deben los clientes de la costa con todo el detalle posible',
    updated_at: ago(0.2),
  },
  { id: 'c3', title: 'Resumen de la plata de la semana', updated_at: ago(1) },
  { id: 'c4', title: 'Crear tabla de proveedores', updated_at: ago(4) },
  { id: 'c5', title: null, updated_at: ago(12) },
  { id: 'c6', title: 'Conectar hoja de Google', updated_at: ago(70) },
];

const DRIVE = 'https://drive.google.com/drive/folders/12ZKgFFQW5jZ4rTxK97b43QQvXV4tG-AI';
const SHEET =
  'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij/edit?gid=0#gid=0';

const COLS = ['Cliente', 'NIT', 'Factura', 'Emitida', 'Vence', 'Valor', 'Saldo', 'Estado'];
const ROWS = Array.from({ length: 4 }, (_, i) =>
  [
    `Transportes Coltrans del Caribe S.A.S. ${i + 1}`,
    `900.123.45${i}-1`,
    `FV-20${i}4`,
    `2026-09-0${i + 1}`,
    `2026-10-0${i + 1}`,
    '$ 42.350.000',
    '$ 12.000.000',
    'Vencida hace 12 días',
  ].join(' | '),
);

const TABLE = `| ${COLS.join(' | ')} |\n|${COLS.map(() => '---').join('|')}|\n${ROWS.map((r) => `| ${r} |`).join('\n')}`;

const CODE = `const resumen = await cortex.finanzas.cuentasPorCobrar({ cliente: 'Coltrans', desde: '2026-01-01', hasta: '2026-09-30', incluirVencidas: true, agruparPor: 'mes' });`;

const ANSWER = `Revisé la carpeta ${DRIVE} y la hoja ${SHEET}. Te dejo el resumen:

1. Primer punto con una lista anidada
   - Sub punto con enlace [abre la carpeta de soportes de la cartera vencida del tercer trimestre](${DRIVE})
   - Otro sub punto con una palabra larguísima: supercalifragilisticoespialidosoabcdefghijklmnopqrstuvwxyz0123456789
     - Tercer nivel de sangría que no debe salirse de la burbuja por ningún motivo
2. Segundo punto

> Una cita larga: ${SHEET}

${TABLE}

\`\`\`ts
${CODE}
\`\`\`

Inline: \`cortex.finanzas.cuentasPorCobrar({ cliente: 'Coltrans', desde: '2026-01-01', hasta: '2026-09-30' })\` y listo.`;

/** El plan por adelantado de la tarea: cinco pasos, tres ya cerrados o en curso y dos por venir. */
const PLAN_STEPS = [
  { id: '1', label: 'Leer la carpeta de Drive' },
  { id: '2', label: 'Leer la hoja de cartera' },
  { id: '3', label: 'Consultar el RUT en la DIAN' },
  { id: '4', label: 'Cruzar saldos por cliente' },
  { id: '5', label: 'Armar la tabla y avisar al equipo' },
];
const PLAN_INVS = [
  {
    state: 'result',
    toolCallId: 'p1',
    toolName: 'cortex_plan',
    args: {},
    result: {
      title: 'Cobrar a los clientes de la costa',
      steps: PLAN_STEPS.map((x) => ({ ...x, status: 'pending' })),
    },
  },
  {
    state: 'result',
    toolCallId: 'p2',
    toolName: 'cortex_plan_update',
    args: {},
    result: {
      updates: [
        { id: '1', status: 'done' },
        { id: '2', status: 'done' },
        { id: '3', status: 'in_progress', note: 'Esperando el código de verificación' },
      ],
    },
  },
];

const MESSAGES: Message[] = [
  {
    id: 'u1',
    role: 'user',
    content: `Revisa esta carpeta ${DRIVE} y también ${SHEET} y dime cuánto nos deben los clientes de la costa, por favor, con todo el detalle que puedas.`,
    createdAt: new Date('2026-10-08T10:00:00'),
  },
  {
    id: 'a1',
    role: 'assistant',
    content: ANSWER,
    createdAt: new Date('2026-10-08T10:00:20'),
    toolInvocations: [
      ...PLAN_INVS,
      {
        state: 'result',
        toolCallId: 't1',
        toolName: 'drive_list_folder',
        args: { folder: DRIVE, query: 'cartera vencida tercer trimestre soportes firmados' },
        result: { files: 12 },
      },
      {
        state: 'result',
        toolCallId: 't2',
        toolName: 'sheets_read_range',
        args: { spreadsheet: SHEET, range: 'Hoja 1!A1:Z500' },
        result: { rows: 38 },
      },
      {
        state: 'result',
        toolCallId: 't3',
        toolName: 'payments_list',
        args: { limit: 4 },
        result: {
          guidance: 'Pagos de los últimos 30 días.',
          payments: [
            {
              paidOn: '2026-10-02',
              client: 'Frigoandes',
              invoiceNumber: 'FE-2231',
              amount: 4800000,
              currency: 'COP',
              state: 'Conciliado',
            },
            {
              paidOn: '2026-10-05',
              client: 'Transmar',
              invoiceNumber: 'FE-2240',
              amount: 2150000,
              currency: 'COP',
              state: 'Por conciliar',
            },
          ],
        },
      },
    ],
  } as Message,
];

const APPROVAL: Message = {
  id: 'a2',
  role: 'assistant',
  content: 'Te dejo el correo listo para Frigoandes. Apruébalo y sale.',
  createdAt: new Date('2026-10-08T10:02:00'),
  toolInvocations: [
    {
      state: 'result',
      toolCallId: 't9',
      toolName: 'gmail_send_email',
      args: {},
      result: {
        __requires_confirmation: true,
        toolId: 'gmail.send_email',
        input: {
          to: 'camila@frigoandes.co',
          subject: 'Factura FE-2231 de $ 4.800.000',
          body: 'Hola Camila, te escribo por la factura FE-2231.',
        },
      },
    },
  ],
} as Message;

/** Una página de mentira, dibujada, para ver el panel «Navegador» sin abrir una sesión real. */
const FRAME = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800"><rect width="1280" height="800" fill="#f4f6f8"/><rect width="1280" height="84" fill="#0b3d6b"/><text x="48" y="54" font-family="Arial" font-size="28" fill="#fff" font-weight="700">Muisca · Consulta de RUT</text><rect x="48" y="132" width="620" height="420" rx="14" fill="#fff" stroke="#d5dbe1"/><text x="80" y="188" font-family="Arial" font-size="24" fill="#1c2733" font-weight="700">Consultar estado del RUT</text><text x="80" y="250" font-family="Arial" font-size="17" fill="#5b6773">NIT sin dígito de verificación</text><rect x="80" y="266" width="400" height="48" rx="8" fill="#fff" stroke="#8a97a4"/><text x="96" y="298" font-family="Arial" font-size="20" fill="#1c2733">900123456</text><rect x="80" y="352" width="190" height="52" rx="8" fill="#0b6bcb"/><text x="116" y="386" font-family="Arial" font-size="20" fill="#fff" font-weight="700">Consultar</text><rect x="720" y="132" width="512" height="300" rx="14" fill="#fff" stroke="#d5dbe1"/><text x="752" y="188" font-family="Arial" font-size="20" fill="#1c2733" font-weight="700">Resultado</text><text x="752" y="236" font-family="Arial" font-size="18" fill="#5b6773">Razón social: Distribuciones del Caribe S.A.S.</text><text x="752" y="276" font-family="Arial" font-size="18" fill="#5b6773">Estado: Activo · Responsabilidades: 05, 07, 48</text></svg>`,
)}`;

/** Fotos chicas de mentira, una por paso, para ver la repetición con cuadros reales. */
const SHOT = {
  a: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAABLCAIAAAA06NSGAAAAn0lEQVR42u3bsQ0AIAgAQXtnciLXN8ZOtyASjvwA5GpofUwF1BCABi3QoEFTiIFe+ygg0KBBC3Qq6JtkftscNGjQoEGDBg0aNGjQoEGDBg0aNGjQoEGDBg0aNGjQoEGDBg0aNGjQNaCdhIEGDRo0aNCgQYP2WuGHRaBBg0YAGrRAgwZNATRogQYNmgJo0AINGrRAgxZo0KAFGrRAg67cA1h2cKaHfwMRAAAAAElFTkSuQmCC',
  b: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAABLCAIAAAA06NSGAAAAn0lEQVR42u3bsQ0AIAgAQXtHdVTXMcZOtyASjvwA5GpofUwF1BCABi3QoEFTiIFe+ygg0KBBC3Qq6JtkftscNGjQoEGDBg0aNGjQoEGDBg0aNGjQoEGDBg0aNGjQoEGDBg0aNGjQNaCdhIEGDRo0aNCgQYP2WuGHRaBBg0YAGrRAgwZNATRogQYNmgJo0AINGrRAgxZo0KAFGrRAg67cA5ByQrQ4/jtvAAAAAElFTkSuQmCC',
  c: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAABLCAIAAAA06NSGAAAAoElEQVR42u3b0QkAIAhAwaZoqhZq6QgaoLaQxJM3gNy3tj6HAmoIQIMWaNCgKcRAr7MVEGjQoAU6FfRNMr9tDho0aNCgQYMGDRo0aNCgQYMGDRo0aNCgQYMGDRo0aNCgQYMGDRo06BrQTsJAgwYNGjRo0KBBe63wwyLQoEEjAA1aoEGDpgAatECDBk0BNGiBBg1aoEELNGjQAg1aoEFX7gGvxJzrbhfdEgAAAABJRU5ErkJggg==',
  d: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAABLCAIAAAA06NSGAAAAn0lEQVR42u3bsQ0AIAgAQXdxC+d2MVob3YJIOPIDkKth7LmU0EAAGrRAgwZNIQf6RCgh0KBBC3Qp6FtkftscNGjQoEGDBg0aNGjQoEGDBg0aNGjQoEGDBg0aNGjQoEGDBg0aNGjQPaCdhIEGDRo0aNCgQYP2WuGHRaBBg0YAGrRAgwZNATRogQYNmgJo0AINGrRAgxZo0KAFGrRAg+7cA3MvLB3KHnO+AAAAAElFTkSuQmCC',
};

const LIVE_INVS = (() => {
  const t = (name: string, args: unknown, result: unknown, n: number, state = 'result') => ({
    toolCallId: `nav${n}`,
    toolName: name,
    state,
    args,
    ...(state === 'result' ? { result } : {}),
  });
  return [
    t(
      'browser_open_page',
      { url: 'https://muisca.dian.gov.co/WebRutMuisca' },
      { sessionId: 'demo', thumbnail: SHOT.a },
      1,
    ),
    t(
      'browser_act',
      { sessionId: 'demo', action: 'fill', name: 'NIT' },
      { ok: true, thumbnail: SHOT.b },
      2,
    ),
    t(
      'browser_act',
      { sessionId: 'demo', action: 'click', name: 'Consultar' },
      { ok: true, thumbnail: SHOT.b },
      3,
    ),
    t(
      'browser_read_page',
      { sessionId: 'demo' },
      {
        page: { title: 'Estado del RUT' },
        thumbnail: SHOT.c,
      },
      4,
    ),
    t(
      'browser_act',
      { sessionId: 'demo', action: 'click', name: 'Descargar certificado' },
      {
        ok: false,
        message: 'La página cambió.',
        thumbnail: SHOT.d,
      },
      5,
    ),
    t(
      'browser_act',
      { sessionId: 'demo', action: 'fill', name: 'Código de verificación' },
      undefined,
      6,
      'call',
    ),
  ];
})();

const LIVE_STEPS: BrowserStep[] = browserSteps(LIVE_INVS).map((s, i) => ({
  ...s,
  at: Date.parse('2026-10-11T10:14:05-05:00') + i * 7_000,
}));

const MENTION_GROUPS = {
  groups: [
    {
      id: 'clientes',
      heading: 'Clientes',
      icon: 'Building2',
      items: [{ id: 'k1', label: 'Frigoandes', hint: 'Medellín', expands: 'Frigoandes ' }],
    },
    {
      id: 'tablas',
      heading: 'Tablas',
      icon: 'Boxes',
      items: [
        {
          id: 'k2',
          label: 'Frigoandes · pedidos',
          hint: 'tabla',
          expands: 'Frigoandes · pedidos ',
        },
      ],
    },
    {
      id: 'vistas',
      heading: 'Vistas',
      icon: 'BarChart3',
      items: [
        { id: 'k3', label: 'Cartera Frigoandes', hint: 'vista', expands: 'Cartera Frigoandes ' },
      ],
    },
  ],
};

export function ChatShowcase({
  dark,
  error,
  empty = false,
  panel = false,
  mention = false,
  tab = null,
  approve = false,
  navegador = null,
  archivos = false,
  tarea = null,
}: {
  dark: boolean;
  error: string | null;
  empty?: boolean;
  panel?: boolean;
  mention?: boolean;
  tab?: PanelTab | null;
  approve?: boolean;
  navegador?: 'normal' | 'ayuda' | null;
  archivos?: boolean;
  tarea?: 'trabajando' | 'necesita' | null;
}) {
  const [background, setBackground] = useState(false);
  const [client] = useState(() => {
    const c = new QueryClient();
    c.setQueryData(['conversations'], THREADS);
    c.setQueryData(['chat-sources'], {
      sources: [
        { id: 's1', label: 'Siigo', tone: 'ok' },
        { id: 's2', label: 'Correo', tone: 'ok' },
        { id: 's3', label: 'Drive', tone: 'attention' },
      ],
    });
    c.setQueryData(['chat-mentions', 'Fri'], MENTION_GROUPS);
    return c;
  });
  const [title, setTitle] = useState('Quién me debe y cómo cobro');
  const [shown, setShown] = useState(error !== 'ninguno');
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  const initial: ChatArtifact | null = panel
    ? {
        id: 't3',
        title: 'Pagos',
        kind: 'table',
        csv: { headers: ['Cliente'], rows: [['Frigoandes']] },
        render: () => (
          <DeclaredTable
            spec={DECLARED.payments_list as never}
            result={
              (MESSAGES[1] as never as { toolInvocations: { result: unknown }[] })
                .toolInvocations[2]?.result
            }
          />
        ),
      }
    : null;
  return (
    <QueryClientProvider client={client}>
      <ChatArtifactsProvider
        initial={initial}
        {...(navegador
          ? {
              initialTab: 'navegador' as const,
              initialSteps: LIVE_STEPS,
              initialTurn: {
                invocations: [...PLAN_INVS, ...LIVE_INVS] as never,
                brain: [],
                metrics: null,
                working: true,
              },
              initialLive: {
                sessionId: 'demo',
                fixture: {
                  frame: FRAME,
                  url: 'https://muisca.dian.gov.co/WebRutMuisca',
                  title: 'Consulta de RUT',
                  ...(navegador === 'ayuda'
                    ? { help: 'Escribe el código de verificación que te llegó al celular.' }
                    : {}),
                },
              },
            }
          : archivos
            ? {
                initialTab: 'archivos' as const,
                initialFiles: FIXTURE_FILES,
                conversationId: 'demo',
              }
            : tab
              ? { initialTab: tab }
              : {})}
      >
        <ChatComposeProvider compose={() => {}} ask={() => {}}>
          <div className="cortex-workspace flex h-[100dvh] gap-2 overflow-hidden bg-canvas p-0 md:gap-3 md:p-2">
            <ThreadAside />
            <div className="cortex-chat flex min-w-0 flex-1 flex-col overflow-hidden">
              <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
                <ConversationHeader
                  conversationId="demo"
                  title={title}
                  onTitle={setTitle}
                  scope={[
                    { id: 'e1', name: 'Cartera', kind: 'shared' },
                    { id: 'e2', name: 'Contratos', kind: 'global' },
                    { id: 'e3', name: 'Equipo', kind: 'personal' },
                  ]}
                  messages={MESSAGES}
                />
                <ThreadHistory />
              </header>
              <MessageList
                companyName="Distribuciones del Caribe S.A.S."
                messages={empty ? [] : approve ? [...MESSAGES, APPROVAL] : MESSAGES}
                isLoading={false}
                {...(approve ? { conversationId: 'demo' } : {})}
                agent={{ slug: 'cortex', name: 'Cortex' } as never}
                onRegenerate={() => {}}
                onSuggestion={() => {}}
                onAnswer={() => {}}
                followUpsAbove
              />
              {shown && (
                <ChatErrorCard
                  message={
                    error === 'limite'
                      ? 'Usaste todo el consumo incluido este mes. Pasa a un plan mayor para seguir.'
                      : `Se cortó la conexión mientras respondía. Escríbeme «sigue» y retomo. ${DRIVE}`
                  }
                  isLimit={error === 'limite'}
                  onRetry={() => setShown(false)}
                  onContinue={() => setShown(false)}
                  onDismiss={() => setShown(false)}
                />
              )}
              {!empty && (
                <div className="mx-auto w-full max-w-[45rem] shrink-0 px-4 sm:px-6">
                  <FollowUps
                    dock
                    messageId="a1"
                    ready
                    stored={['Prepara los de Transmar también', 'Guárdalo como vista']}
                    onPick={() => {}}
                  />
                </div>
              )}
              {tarea && (
                <BackgroundBanner
                  task={
                    FIXTURE_TASKS.find(
                      (t) => t.id === (tarea === 'necesita' ? 't-needs' : 't-working'),
                    ) ?? null
                  }
                  onCancel={() => {}}
                  onDismiss={() => {}}
                  onDecided={() => {}}
                />
              )}
              <InputBar
                onSend={() => {}}
                background={background}
                onBackgroundChange={setBackground}
                disabled={false}
                agents={[]}
                agentSlug="cortex"
                onAgentChange={() => {}}
                conversationId="demo"
                scope={[]}
                onScopeChange={() => {}}
                {...(mention ? { draft: 'Mándale un correo a @Fri' } : {})}
              />
            </div>
            <ArtifactPanel />
          </div>
        </ChatComposeProvider>
      </ChatArtifactsProvider>
    </QueryClientProvider>
  );
}
