import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import type { AtencionPerson, AtencionTracker } from '@/lib/whatsapp/atencion-shape';
import {
  type ConversationListItem,
  type ConversationRow,
  type CustomerSettings,
  type MessageRow,
  getConversation,
  listConversationMessages,
  listCustomerConversations,
  listTrackers,
  loadCustomerSettings,
  replyRefusal,
} from '@cortex/agent-tools';
import { ArrowLeft, Headset } from 'lucide-react';
import Link from 'next/link';
import { AtencionConsole } from './_components/AtencionConsole';
import { closeAtencionConversation, replyAsPerson, saveAtencionSettings } from './actions';

/**
 * ATENCIÓN A CLIENTES POR WHATSAPP (0185).
 *
 * Vive debajo de Integraciones › WhatsApp porque es el mismo número: aquí se
 * enciende, se decide qué se puede decir y a quién se le pasa, y se ve lo que
 * pasa — cada conversación con lo que contestó el bot, de dónde salió cada
 * dato, y una caja para contestar como persona dentro de esa conversación.
 *
 * Cada lectura va por su lado; si una falla, su sección lo dice y el resto de
 * la pantalla sigue en pie.
 */

export const dynamic = 'force-dynamic';

export default async function AtencionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const q = await searchParams;
  const selectedId = typeof q.c === 'string' ? q.c : null;
  const now = new Date();

  const [settings, conversations, people, trackers, session] = await Promise.all([
    loadCustomerSettings(db).catch(() => null as CustomerSettings | null),
    listCustomerConversations(db, { limit: 150 }).catch(
      () => null as ConversationListItem[] | null,
    ),
    db
      .from('users')
      .select('id, name, email')
      .order('name', { ascending: true })
      .limit(300)
      .then(({ data, error }) =>
        error
          ? []
          : ((data ?? []) as Array<{ id: string; name: string | null; email: string }>).map(
              (u): AtencionPerson => ({ id: u.id, name: u.name || u.email }),
            ),
      ),
    listTrackers(db, 60)
      .then((rows) =>
        rows.map(
          (t): AtencionTracker => ({
            id: t.id,
            name: t.name,
            fields: t.fields.map((f) => ({ key: f.key, label: f.label })),
          }),
        ),
      )
      .catch(() => [] as AtencionTracker[]),
    db
      .from('whatsapp_sessions')
      .select('status')
      .maybeSingle()
      .then(({ data, error }) => (error ? null : ((data?.status as string | null) ?? null))),
  ]);

  let selected: ConversationRow | null = null;
  let messages: MessageRow[] | null = null;
  if (selectedId && /^[0-9a-f-]{36}$/i.test(selectedId)) {
    selected = await getConversation(db, selectedId).catch(() => null);
    if (selected) messages = await listConversationMessages(db, selected.id).catch(() => null);
  }
  const canManage = user.role === 'org_admin';
  const canHandle =
    !!selected &&
    (canManage ||
      selected.assigned_to === user.id ||
      (settings?.escalationUserId ?? null) === user.id);

  return (
    <>
      <Link
        href="/integrations/whatsapp"
        className="mb-3 inline-flex min-h-8 items-center gap-1.5 rounded-pill border border-border bg-surface px-3 text-xs font-bold text-ink-muted shadow-card transition-colors duration-150 hover:text-primary motion-reduce:transition-none"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        WhatsApp
      </Link>
      <PageHeader
        title="Atención a clientes"
        subtitle="Lo que tus clientes preguntan por WhatsApp: estado de su pedido, sus facturas y su saldo. Cortex contesta con tus datos y, si no sabe, se lo pasa a una persona."
        icon={<Headset className="h-5 w-5" />}
      />
      <AtencionConsole
        now={now.toISOString()}
        settings={settings}
        conversations={conversations}
        selected={
          selected
            ? {
                conversation: selected,
                item: conversations?.find((c) => c.id === selected?.id) ?? null,
                messages,
                replyBlocked: replyRefusal(selected, now),
                canHandle,
              }
            : null
        }
        people={people}
        trackers={trackers}
        canManage={canManage}
        bridgeConnected={session === 'connected'}
        actions={{
          saveSettings: saveAtencionSettings,
          reply: replyAsPerson,
          close: closeAtencionConversation,
        }}
      />
    </>
  );
}
