import type { SelectedConversation } from '@/app/(app)/integrations/whatsapp/atencion/_components/AtencionConsole';
import {
  type ConversationListItem,
  type ConversationRow,
  type CustomerSettings,
  DEFAULT_CUSTOMER_SETTINGS,
  type MessageRow,
  replyRefusal,
} from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { AtencionShowcase } from './Showcase';

/**
 * «ATENCIÓN A CLIENTES» CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * Tres conversaciones: Nexa preguntó su saldo (contestó el bot con dos
 * facturas como fuente), un desconocido preguntó por una guía, y Andina pidió
 * una cotización y la tiene una persona. `?c=c1|c2|c3` abre una,
 * `?tab=ajustes` los ajustes, `?modo=oscuro`. En producción responde 404.
 */
export const dynamic = 'force-dynamic';

const NOW = new Date('2026-10-05T15:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

const SETTINGS: CustomerSettings = {
  ...DEFAULT_CUSTOMER_SETTINGS,
  enabled: true,
  businessHours: {
    '1': [['08:00', '18:00']],
    '2': [['08:00', '18:00']],
    '3': [['08:00', '18:00']],
    '4': [['08:00', '18:00']],
    '5': [['08:00', '18:00']],
    '6': [['08:00', '12:00']],
  },
  companyInfo: 'Calle 80 # 45-10, Bogotá. Tel. 601 555 0101. servicio@transportesandinos.co',
  faq: [
    {
      q: '¿Hacen envíos a Medellín?',
      a: 'Sí, despachamos a Medellín todos los días hábiles.',
      keywords: ['medellin'],
    },
  ],
  orderSources: [
    {
      trackerId: '00000000-0000-4000-8000-0000000000a1',
      label: 'Guías',
      numberField: 'guia',
      statusField: 'estado',
      etaField: 'entrega',
      clientField: 'cliente',
    },
  ],
  escalationUserId: 'u-ana',
  escalationTeam: 'servicio al cliente',
};

const conv = (over: Partial<ConversationRow> & { id: string }): ConversationRow => ({
  phone: '573001112233',
  jid: '573001112233@s.whatsapp.net',
  push_name: null,
  client_id: null,
  contact_id: null,
  status: 'abierta',
  assigned_to: null,
  verification: 'ninguna',
  verified_until: null,
  verify_attempts: 0,
  pending_intent: null,
  opted_out: false,
  opted_out_at: null,
  last_message_at: ago(5),
  last_inbound_at: ago(6),
  escalated_at: null,
  escalation_reason: null,
  closed_at: null,
  work_item_id: null,
  created_at: ago(30),
  ...over,
});

const CONVS: ConversationRow[] = [
  conv({
    id: 'c1',
    push_name: 'Carlos Pérez',
    client_id: '00000000-0000-4000-8000-0000000000c1',
    contact_id: 'k1',
    verification: 'telefono',
  }),
  conv({
    id: 'c2',
    phone: '573205550000',
    jid: '573205550000@s.whatsapp.net',
    push_name: 'Laura',
    last_message_at: ago(42),
    last_inbound_at: ago(43),
  }),
  conv({
    id: 'c3',
    phone: '573109998877',
    jid: '573109998877@s.whatsapp.net',
    push_name: 'Mónica R.',
    client_id: '00000000-0000-4000-8000-0000000000c2',
    verification: 'telefono',
    status: 'escalada',
    assigned_to: 'u-ana',
    escalated_at: ago(80),
    escalation_reason: 'pide una cotización',
    last_message_at: ago(75),
    last_inbound_at: ago(90),
  }),
  conv({
    id: 'c4',
    phone: '573157778899',
    jid: '573157778899@s.whatsapp.net',
    push_name: 'Pedro',
    status: 'cerrada',
    closed_at: ago(60 * 26),
    last_message_at: ago(60 * 26),
    last_inbound_at: ago(60 * 27),
  }),
];

const ITEMS: ConversationListItem[] = CONVS.map((c) => ({
  ...c,
  client_name: c.id === 'c1' ? 'Nexa Logística' : c.id === 'c3' ? 'Andina Cargo' : null,
  assignee_name: c.assigned_to ? 'Ana Restrepo' : null,
  last_body:
    c.id === 'c1'
      ? 'El saldo pendiente de Nexa Logística es $1.700.000 en 2 facturas…'
      : c.id === 'c2'
        ? 'Guía GU-5001: En tránsito.'
        : c.id === 'c3'
          ? 'Hola Mónica, ya te preparo la cotización a Cali.'
          : 'Con gusto. 🙌',
  last_direction: 'out',
  last_answered_by: c.id === 'c3' ? 'persona' : 'bot',
}));

const msg = (over: Partial<MessageRow> & { id: string; body: string }): MessageRow => ({
  conversation_id: 'c1',
  direction: 'in',
  intent: null,
  answered_by: null,
  author_id: null,
  sources: [],
  delivery: null,
  sent_at: null,
  created_at: ago(6),
  ...over,
});

const MESSAGES: Record<string, MessageRow[]> = {
  c1: [
    msg({
      id: 'm1',
      body: 'Hola, buenos días. ¿Cuánto debemos a la fecha?',
      intent: 'saldo',
      created_at: ago(6),
    }),
    msg({
      id: 'm2',
      direction: 'out',
      answered_by: 'bot',
      intent: 'saldo',
      created_at: ago(5),
      body: 'El saldo pendiente de Nexa Logística es *$1.700.000* en 2 facturas; de eso, $1.200.000 ya está vencido.\n\n• *FV-100*: $1.200.000 por pagar, vencida hace 10 días\n• *FV-101*: $500.000 por pagar, vence el 20 de octubre de 2026',
      sources: [
        { kind: 'invoice', id: 'i-100', label: 'FV-100' },
        { kind: 'invoice', id: 'i-101', label: 'FV-101' },
      ],
    }),
  ],
  c2: [
    msg({
      id: 'm3',
      conversation_id: 'c2',
      body: '¿Cómo va la guía GU-5001?',
      intent: 'estado_pedido',
      created_at: ago(43),
    }),
    msg({
      id: 'm4',
      conversation_id: 'c2',
      direction: 'out',
      answered_by: 'bot',
      intent: 'estado_pedido',
      created_at: ago(42),
      body: 'Guía *GU-5001*: *En tránsito*.\nEntrega estimada: 7 de octubre de 2026.\n_Actualizado el 4 de octubre de 2026._',
      sources: [{ kind: 'order', id: 'r-5001', label: 'Guías GU-5001' }],
    }),
  ],
  c3: [
    msg({
      id: 'm5',
      conversation_id: 'c3',
      body: 'Necesito cotizar 3 envíos a Cali',
      intent: 'cotizacion',
      created_at: ago(90),
    }),
    msg({
      id: 'm6',
      conversation_id: 'c3',
      direction: 'out',
      answered_by: 'bot',
      intent: 'cotizacion',
      created_at: ago(89),
      body: 'Para cotizar te paso con alguien de servicio al cliente. Te responde por este mismo chat.',
    }),
    msg({
      id: 'm7',
      conversation_id: 'c3',
      direction: 'out',
      answered_by: 'persona',
      author_id: 'u-ana',
      delivery: 'enviado',
      created_at: ago(75),
      body: 'Hola Mónica, ya te preparo la cotización a Cali.',
    }),
  ],
  c4: [],
};

export default async function AtencionShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const id = typeof q.c === 'string' ? q.c : 'c1';
  const found = CONVS.find((c) => c.id === id) ?? null;
  const selected: SelectedConversation | null = found
    ? {
        conversation: found,
        item: ITEMS.find((i) => i.id === found.id) ?? null,
        messages: MESSAGES[found.id] ?? [],
        replyBlocked: replyRefusal(found, NOW),
        canHandle: true,
      }
    : null;
  return (
    <AtencionShowcase
      dark={q.modo === 'oscuro'}
      now={NOW.toISOString()}
      settings={SETTINGS}
      conversations={ITEMS}
      selected={selected}
      people={[
        { id: 'u-ana', name: 'Ana Restrepo' },
        { id: 'u-luis', name: 'Luis Gómez' },
      ]}
      trackers={[
        {
          id: '00000000-0000-4000-8000-0000000000a1',
          name: 'Guías',
          fields: [
            { key: 'guia', label: 'Guía' },
            { key: 'estado', label: 'Estado' },
            { key: 'entrega', label: 'Entrega' },
            { key: 'cliente', label: 'Cliente' },
          ],
        },
      ]}
    />
  );
}
