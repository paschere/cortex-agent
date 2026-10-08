'use client';

import { ChatErrorCard } from '@/components/chat/ChatErrorCard';
import { MessageList } from '@/components/chat/MessageList';
import { ThreadAside, ThreadHistory } from '@/components/chat/ThreadHistory';
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
        result: { __error: `No tengo permiso para leer esa hoja: ${SHEET}` },
      },
    ],
  } as Message,
];

export function ChatShowcase({
  dark,
  error,
  empty = false,
}: { dark: boolean; error: string | null; empty?: boolean }) {
  const [client] = useState(() => {
    const c = new QueryClient();
    c.setQueryData(['conversations'], THREADS);
    return c;
  });
  const [shown, setShown] = useState(error !== 'ninguno');
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return (
    <QueryClientProvider client={client}>
      <div className="cortex-workspace flex h-[100dvh] overflow-hidden">
        <ThreadAside />
        <div className="cortex-chat flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
            <span className="text-base font-semibold text-ink">Conversación</span>
            <ThreadHistory />
          </header>
          <MessageList
            companyName="Distribuciones del Caribe S.A.S."
            messages={empty ? [] : MESSAGES}
            isLoading={false}
            agent={{ slug: 'cortex', name: 'Cortex' } as never}
            onRegenerate={() => {}}
            onSuggestion={() => {}}
            onAnswer={() => {}}
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
          <div className="h-24 shrink-0 border-t border-border bg-surface" />
        </div>
      </div>
    </QueryClientProvider>
  );
}
