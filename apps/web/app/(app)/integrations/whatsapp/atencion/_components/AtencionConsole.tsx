'use client';

import { Button } from '@/components/ui/button';
import { IconChip, Panel, PanelHead } from '@/components/ui/panel';
import { Toggle } from '@/components/views/editor/controls';
import {
  type AtencionPerson,
  type AtencionResult,
  type AtencionTracker,
  DELIVERY_TEXT,
  INTENT_TEXT,
  STATUS_TEXT,
  STATUS_TONE,
  VERIFICATION_TEXT,
  WEEKDAY_TEXT,
  phoneText,
  relativeTime,
} from '@/lib/whatsapp/atencion-shape';
import type {
  ConversationListItem,
  ConversationRow,
  CustomerSettings,
  FaqEntry,
  MessageRow,
  OrderSource,
} from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  Bot,
  Building2,
  CheckCircle2,
  Clock,
  Headset,
  Loader2,
  Lock,
  MessagesSquare,
  Plus,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

/**
 * LA PANTALLA DE ATENCIÓN.
 *
 * Dos pestañas. «Conversaciones»: la lista viva a la izquierda y la
 * conversación elegida a la derecha, con lo que contestó el bot, de dónde
 * salió cada dato (las facturas, la fila de la guía) y la caja para contestar
 * como persona — que sólo se abre dentro de las 24 h del último mensaje del
 * cliente, porque el número nunca escribe primero. «Ajustes»: encender, qué se
 * puede decir, horario, preguntas frecuentes, de dónde sale el estado de un
 * pedido y a quién se le pasa.
 */

export interface AtencionActions {
  saveSettings: (input: unknown) => Promise<AtencionResult>;
  reply: (input: { conversationId: string; text: string }) => Promise<AtencionResult>;
  close: (input: { conversationId: string }) => Promise<AtencionResult>;
}

export interface SelectedConversation {
  conversation: ConversationRow;
  item: ConversationListItem | null;
  messages: MessageRow[] | null;
  replyBlocked: string | null;
  canHandle: boolean;
}

type Filter = 'activas' | 'escalada' | 'cerrada';

export function AtencionConsole({
  now,
  settings,
  conversations,
  selected,
  people,
  trackers,
  canManage,
  bridgeConnected,
  actions,
  basePath = '/integrations/whatsapp/atencion',
}: {
  now: string;
  settings: CustomerSettings | null;
  conversations: ConversationListItem[] | null;
  selected: SelectedConversation | null;
  people: AtencionPerson[];
  trackers: AtencionTracker[];
  canManage: boolean;
  bridgeConnected: boolean;
  actions: AtencionActions;
  basePath?: string;
}) {
  const params = useSearchParams();
  const [tab, setTab] = useState<'conversaciones' | 'ajustes'>(
    params.get('tab') === 'ajustes' ? 'ajustes' : 'conversaciones',
  );
  const nowDate = useMemo(() => new Date(now), [now]);

  return (
    <div className="flex flex-col gap-5">
      <StatusStrip settings={settings} bridgeConnected={bridgeConnected} />
      <div role="tablist" aria-label="Atención" className="flex gap-2">
        {(
          [
            ['conversaciones', 'Conversaciones', MessagesSquare],
            ['ajustes', 'Ajustes', Settings2],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={clsx(
              'inline-flex min-h-10 items-center gap-2 rounded-pill border px-4 text-sm font-bold transition-colors duration-150',
              tab === key
                ? 'border-primary bg-primary text-white'
                : 'border-border bg-surface text-ink-muted hover:text-ink',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      {tab === 'conversaciones' ? (
        <Conversations
          now={nowDate}
          conversations={conversations}
          selected={selected}
          actions={actions}
          basePath={basePath}
        />
      ) : settings ? (
        <SettingsForm
          settings={settings}
          people={people}
          trackers={trackers}
          canManage={canManage}
          save={actions.saveSettings}
        />
      ) : (
        <ReadError what="los ajustes de atención" />
      )}
    </div>
  );
}

function StatusStrip({
  settings,
  bridgeConnected,
}: {
  settings: CustomerSettings | null;
  bridgeConnected: boolean;
}) {
  const on = settings?.enabled === true;
  return (
    <Panel className="flex flex-wrap items-center gap-4 px-5 py-4">
      <IconChip tone={on ? 'emerald' : 'amber'}>
        <Headset className="h-4 w-4" />
      </IconChip>
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-sm font-bold text-ink">
          {on ? 'La atención está encendida' : 'La atención está apagada'}
        </p>
        <p className="text-xs text-ink-muted">
          {on
            ? 'Quien no es del equipo y le escribe al número recibe respuesta con tus datos, o pasa a una persona.'
            : 'A quien no es del equipo se le contesta que el número es sólo para el equipo. Enciéndela en Ajustes.'}
        </p>
      </div>
      {!bridgeConnected && (
        <span className="inline-flex items-center gap-1.5 rounded-pill bg-amber-soft px-3 py-1 text-xs font-bold text-amber">
          <AlertTriangle className="h-3.5 w-3.5" />
          El número no está conectado
        </span>
      )}
      <span className="inline-flex items-center gap-1.5 rounded-pill bg-surface-2 px-3 py-1 text-xs font-bold text-ink-muted">
        <ShieldCheck className="h-3.5 w-3.5" />
        Nunca escribe primero
      </span>
    </Panel>
  );
}

function ReadError({ what }: { what: string }) {
  return (
    <Panel className="flex items-center gap-3 px-5 py-4 text-sm text-rose">
      <AlertTriangle className="h-4 w-4" />
      No pude leer {what}. Recarga en un momento.
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Conversaciones
// ---------------------------------------------------------------------------

function Conversations({
  now,
  conversations,
  selected,
  actions,
  basePath,
}: {
  now: Date;
  conversations: ConversationListItem[] | null;
  selected: SelectedConversation | null;
  actions: AtencionActions;
  basePath: string;
}) {
  const [filter, setFilter] = useState<Filter>('activas');
  if (!conversations) return <ReadError what="las conversaciones" />;
  const counts = {
    activas: conversations.filter((c) => c.status !== 'cerrada').length,
    escalada: conversations.filter((c) => c.status === 'escalada').length,
    cerrada: conversations.filter((c) => c.status === 'cerrada').length,
  };
  const shown = conversations.filter((c) =>
    filter === 'activas' ? c.status !== 'cerrada' : c.status === filter,
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(280px,380px)_1fr]">
      <Panel className="flex min-w-0 flex-col overflow-hidden">
        <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-3">
          {(
            [
              ['activas', 'Activas'],
              ['escalada', 'Con una persona'],
              ['cerrada', 'Cerradas'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
              className={clsx(
                'rounded-pill px-3 py-1 text-xs font-bold transition-colors',
                filter === key ? 'bg-primary-soft text-primary' : 'text-ink-muted hover:text-ink',
              )}
            >
              {label} <span className="tabular-nums opacity-70">{counts[key]}</span>
            </button>
          ))}
        </div>
        {shown.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-muted">
            {filter === 'activas'
              ? 'Nadie está escribiendo ahora. Cuando un cliente le escriba al número, aparece aquí.'
              : 'No hay conversaciones aquí.'}
          </p>
        ) : (
          <ul className="max-h-[640px] divide-y divide-border overflow-y-auto">
            {shown.map((c) => (
              <li key={c.id}>
                <Link
                  href={`${basePath}?c=${c.id}`}
                  scroll={false}
                  className={clsx(
                    'flex flex-col gap-1 px-4 py-3 transition-colors hover:bg-surface-2',
                    selected?.conversation.id === c.id && 'bg-primary-soft/60',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-bold text-ink">
                      {c.client_name ?? c.push_name ?? phoneText(c.phone)}
                    </span>
                    <span className="shrink-0 text-micro text-ink-faint">
                      {relativeTime(c.last_message_at, now)}
                    </span>
                  </div>
                  <p className="line-clamp-2 text-xs text-ink-muted">
                    {c.last_direction === 'out'
                      ? c.last_answered_by === 'persona'
                        ? 'Persona: '
                        : 'Cortex: '
                      : ''}
                    {c.last_body ?? '—'}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={clsx(
                        'rounded-pill px-2 py-0.5 text-micro font-bold',
                        STATUS_TONE[c.status],
                      )}
                    >
                      {STATUS_TEXT[c.status]}
                    </span>
                    {c.client_name && (
                      <span className="text-micro text-ink-faint">{phoneText(c.phone)}</span>
                    )}
                    {c.assignee_name && c.status === 'escalada' && (
                      <span className="text-micro text-ink-faint">· {c.assignee_name}</span>
                    )}
                    {c.opted_out && (
                      <span className="text-micro font-bold text-rose">· pidió la baja</span>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {selected ? (
        <ConversationView now={now} selected={selected} actions={actions} />
      ) : (
        <Panel className="flex min-h-[320px] flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <MessagesSquare className="h-6 w-6 text-ink-faint" />
          <p className="text-sm font-bold text-ink">Elige una conversación</p>
          <p className="max-w-sm text-xs text-ink-muted">
            Vas a ver lo que escribió el cliente, lo que le contestó Cortex con la factura o la guía
            de donde salió cada dato, y podrás contestar como persona.
          </p>
        </Panel>
      )}
    </div>
  );
}

function ConversationView({
  now,
  selected,
  actions,
}: {
  now: Date;
  selected: SelectedConversation;
  actions: AtencionActions;
}) {
  const router = useRouter();
  const { conversation: conv, item, messages } = selected;
  const [text, setText] = useState('');
  const [note, setNote] = useState<AtencionResult | null>(null);
  const [pending, start] = useTransition();
  const who = item?.client_name ?? conv.push_name ?? phoneText(conv.phone);

  const run = (work: () => Promise<AtencionResult>, after?: () => void) =>
    start(async () => {
      const result = await work();
      setNote(result);
      if (result.ok) {
        after?.();
        router.refresh();
      }
    });

  const blocked = !selected.canHandle
    ? 'Sólo un administrador o la persona que atiende esta conversación puede contestarla.'
    : selected.replyBlocked;

  return (
    <Panel className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <p className="truncate text-base font-bold text-ink">{who}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
            <span>{phoneText(conv.phone)}</span>
            {conv.client_id && (
              <Link
                href={`/clients/${conv.client_id}`}
                className="inline-flex items-center gap-1 font-bold text-primary hover:underline"
              >
                <Building2 className="h-3 w-3" />
                Ver ficha
              </Link>
            )}
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" />
              {VERIFICATION_TEXT[conv.verification] ?? conv.verification}
            </span>
          </p>
          {conv.status === 'escalada' && (
            <p className="mt-1 text-xs text-amber">
              {item?.assignee_name ? `Con ${item.assignee_name}` : 'Con una persona'}
              {conv.escalation_reason ? ` — ${conv.escalation_reason}` : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={clsx('rounded-pill px-2.5 py-1 text-xs font-bold', STATUS_TONE[conv.status])}
          >
            {STATUS_TEXT[conv.status]}
          </span>
          {conv.status !== 'cerrada' && selected.canHandle && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => run(() => actions.close({ conversationId: conv.id }))}
            >
              <CheckCircle2 className="h-4 w-4" />
              Cerrar
            </Button>
          )}
        </div>
      </div>

      <div className="flex max-h-[520px] flex-col gap-3 overflow-y-auto bg-canvas/50 px-5 py-4">
        {messages === null ? (
          <p className="text-sm text-rose">No pude leer los mensajes.</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-ink-muted">Sin mensajes todavía.</p>
        ) : (
          messages.map((m) => <Bubble key={m.id} message={m} now={now} />)
        )}
      </div>

      <div className="border-t border-border px-5 py-4">
        <label
          htmlFor="reply"
          className="mb-1.5 flex items-center gap-1.5 text-sm font-bold text-ink"
        >
          <UserRound className="h-4 w-4 text-ink-faint" />
          Responder como persona
        </label>
        {blocked ? (
          <p className="flex items-start gap-2 rounded-card bg-surface-2 px-3 py-2.5 text-xs text-ink-muted">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {blocked}
          </p>
        ) : (
          <>
            <textarea
              id="reply"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={3000}
              rows={3}
              placeholder="Lo que escribas sale tal cual, por WhatsApp, en esta conversación."
              className="w-full resize-y rounded-card border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-primary"
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-micro text-ink-faint">
                Desde que contestas, el bot no vuelve a meterse en esta conversación.
              </p>
              <Button
                disabled={pending || !text.trim()}
                onClick={() =>
                  run(
                    () => actions.reply({ conversationId: conv.id, text }),
                    () => setText(''),
                  )
                }
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                Enviar por WhatsApp
              </Button>
            </div>
          </>
        )}
        {note && (
          <output className={clsx('mt-2 block text-xs', note.ok ? 'text-emerald' : 'text-rose')}>
            {note.ok ? note.note : note.error}
          </output>
        )}
      </div>
    </Panel>
  );
}

/** *negrita* y _cursiva_ como las pinta WhatsApp; nada más. */
function WhatsappText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^\*[^*\n]+\*$/.test(part) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: trozos fijos de un texto que no cambia.
          <strong key={i}>{part.slice(1, -1)}</strong>
        ) : /^_[^_\n]+_$/.test(part) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: trozos fijos de un texto que no cambia.
          <em key={i}>{part.slice(1, -1)}</em>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Bubble({ message: m, now }: { message: MessageRow; now: Date }) {
  const inbound = m.direction === 'in';
  const person = m.answered_by === 'persona';
  return (
    <div className={clsx('flex flex-col gap-1', inbound ? 'items-start' : 'items-end')}>
      <div
        className={clsx(
          'max-w-[85%] whitespace-pre-wrap rounded-card px-3.5 py-2.5 text-sm shadow-card',
          inbound
            ? 'rounded-tl-sm bg-surface text-ink'
            : person
              ? 'rounded-tr-sm bg-primary text-white'
              : 'rounded-tr-sm bg-emerald-soft text-ink',
        )}
      >
        <WhatsappText text={m.body} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-micro text-ink-faint">
        {!inbound &&
          (person ? (
            <span className="inline-flex items-center gap-1">
              <UserRound className="h-3 w-3" />
              Persona
              {m.delivery ? ` · ${DELIVERY_TEXT[m.delivery] ?? m.delivery}` : ''}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Bot className="h-3 w-3" />
              Cortex
            </span>
          ))}
        {inbound && m.intent && <span>{INTENT_TEXT[m.intent] ?? m.intent}</span>}
        <span>· {relativeTime(m.created_at, now)}</span>
      </div>
      {m.sources.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
          {m.sources.slice(0, 8).map((s) => (
            <span
              key={`${s.kind}:${s.id}`}
              title={`Fuente: ${s.label}`}
              className="rounded-pill border border-border bg-surface px-2 py-0.5 text-micro text-ink-muted"
            >
              {s.kind === 'invoice' ? `Factura ${s.label}` : s.kind === 'order' ? s.label : s.label}
            </span>
          ))}
          {m.sources.length > 8 && (
            <span className="text-micro text-ink-faint">+{m.sources.length - 8}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

const fieldBase =
  'rounded-card border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-primary disabled:opacity-60';
const inputClass = `w-full ${fieldBase}`;

function SettingsForm({
  settings,
  people,
  trackers,
  canManage,
  save,
}: {
  settings: CustomerSettings;
  people: AtencionPerson[];
  trackers: AtencionTracker[];
  canManage: boolean;
  save: AtencionActions['saveSettings'];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<CustomerSettings>(settings);
  const [note, setNote] = useState<AtencionResult | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof CustomerSettings>(key: K, value: CustomerSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const ro = !canManage;

  const submit = () =>
    start(async () => {
      const result = await save({
        enabled: draft.enabled,
        timeZone: draft.timeZone,
        businessHours: draft.businessHours,
        botAfterHours: draft.botAfterHours,
        greeting: draft.greeting ?? null,
        afterHoursMessage: draft.afterHoursMessage ?? null,
        shareOrderStatus: draft.shareOrderStatus,
        shareInvoices: draft.shareInvoices,
        shareBalance: draft.shareBalance,
        shareCompanyInfo: draft.shareCompanyInfo,
        companyInfo: draft.companyInfo ?? null,
        faq: draft.faq.filter((f) => f.q.trim() && f.a.trim()),
        orderSources: draft.orderSources,
        escalationUserId: draft.escalationUserId,
        escalationTeam: draft.escalationTeam ?? null,
        maxRepliesPerHour: draft.maxRepliesPerHour,
      });
      setNote(result);
      if (result.ok) router.refresh();
    });

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      {!canManage && (
        <p className="xl:col-span-2 flex items-center gap-2 rounded-card bg-surface-2 px-4 py-3 text-xs text-ink-muted">
          <Lock className="h-3.5 w-3.5" />
          Sólo un administrador puede cambiar estos ajustes.
        </p>
      )}

      <Panel className="pb-5">
        <PanelHead icon={<Headset className="h-4 w-4" />} title="Encendido" />
        <div className="flex flex-col gap-4 px-6 pt-4">
          <Toggle
            label="Contestarle a los clientes que escriban"
            hint="Apagado, a quien no es del equipo se le dice que el número es sólo para el equipo."
            checked={draft.enabled}
            onChange={(v) => set('enabled', v)}
            disabled={ro}
          />
          <p className="flex items-start gap-2 rounded-card bg-amber-soft px-3 py-2.5 text-xs text-ink">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" />
            WhatsApp puede bloquear números que se ven automatizados. Cortex sólo contesta a quien
            escribió, con pausas de persona, un máximo de respuestas por hora y respetando a quien
            pide no recibir más mensajes. No hace envíos masivos ni escribe primero.
          </p>
          <label className="flex items-center justify-between gap-3 text-sm text-ink">
            Máximo de respuestas automáticas por hora, por conversación
            <input
              type="number"
              min={1}
              max={60}
              value={draft.maxRepliesPerHour}
              onChange={(e) => set('maxRepliesPerHour', Number(e.target.value) || 1)}
              disabled={ro}
              className={clsx(fieldBase, 'w-20 shrink-0 text-right')}
            />
          </label>
        </div>
      </Panel>

      <Panel className="pb-5">
        <PanelHead icon={<ShieldCheck className="h-4 w-4" />} title="Qué se puede compartir" />
        <div className="flex flex-col gap-4 px-6 pt-4">
          <Toggle
            label="Estado de pedido o guía"
            hint="Sólo el estado y la fecha estimada. Con el número de guía basta, como una página de rastreo."
            checked={draft.shareOrderStatus}
            onChange={(v) => set('shareOrderStatus', v)}
            disabled={ro}
          />
          <Toggle
            label="Facturas pendientes de ESE cliente"
            hint="Sólo si se identificó por el teléfono de un contacto suyo, o con su NIT y el número de una de sus facturas."
            checked={draft.shareInvoices}
            onChange={(v) => set('shareInvoices', v)}
            disabled={ro}
          />
          <Toggle
            label="Saldo de ESE cliente"
            hint="Con la misma identificación. Nunca el de otro cliente."
            checked={draft.shareBalance}
            onChange={(v) => set('shareBalance', v)}
            disabled={ro}
          />
          <Toggle
            label="Datos públicos de la empresa"
            hint="Lo que escribas abajo y el horario de atención."
            checked={draft.shareCompanyInfo}
            onChange={(v) => set('shareCompanyInfo', v)}
            disabled={ro}
          />
          <textarea
            aria-label="Datos públicos de la empresa"
            rows={3}
            maxLength={2000}
            placeholder="Dirección, teléfonos, correo, medios de pago…"
            value={draft.companyInfo ?? ''}
            onChange={(e) => set('companyInfo', e.target.value)}
            disabled={ro}
            className={inputClass}
          />
        </div>
      </Panel>

      <Panel className="pb-5">
        <PanelHead icon={<Clock className="h-4 w-4" />} title="Horario y mensajes" />
        <div className="flex flex-col gap-3 px-6 pt-4">
          <HoursEditor
            hours={draft.businessHours}
            onChange={(h) => set('businessHours', h)}
            disabled={ro}
          />
          <Toggle
            label="Fuera de horario, igual contestar lo que sale de los datos"
            hint="Apagado, fuera de horario sólo se manda el aviso de horario (una vez cada 12 horas)."
            checked={draft.botAfterHours}
            onChange={(v) => set('botAfterHours', v)}
            disabled={ro}
          />
          <textarea
            aria-label="Saludo"
            rows={2}
            maxLength={600}
            placeholder="Saludo (opcional). Sin saludo, Cortex dice qué puede consultar."
            value={draft.greeting ?? ''}
            onChange={(e) => set('greeting', e.target.value)}
            disabled={ro}
            className={inputClass}
          />
          <textarea
            aria-label="Mensaje fuera de horario"
            rows={2}
            maxLength={600}
            placeholder="Mensaje fuera de horario (opcional)."
            value={draft.afterHoursMessage ?? ''}
            onChange={(e) => set('afterHoursMessage', e.target.value)}
            disabled={ro}
            className={inputClass}
          />
        </div>
      </Panel>

      <Panel className="pb-5">
        <PanelHead icon={<UserRound className="h-4 w-4" />} title="A quién se le pasa" />
        <div className="flex flex-col gap-3 px-6 pt-4">
          <p className="text-xs text-ink-muted">
            Cotizaciones, quejas, lo que el bot no entiende y quien pide una persona. Le llega un
            aviso en la campana y queda como trabajo suyo en Equipo.
          </p>
          <select
            aria-label="Persona que atiende"
            value={draft.escalationUserId ?? ''}
            onChange={(e) => set('escalationUserId', e.target.value || null)}
            disabled={ro}
            className={inputClass}
          >
            <option value="">Los administradores</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            aria-label="Equipo"
            maxLength={80}
            placeholder="Nombre del equipo (opcional): «servicio al cliente»"
            value={draft.escalationTeam ?? ''}
            onChange={(e) => set('escalationTeam', e.target.value)}
            disabled={ro}
            className={inputClass}
          />
        </div>
      </Panel>

      <Panel className="pb-5 xl:col-span-2">
        <PanelHead
          icon={<MessagesSquare className="h-4 w-4" />}
          title="Preguntas frecuentes aprobadas"
        />
        <FaqEditor faq={draft.faq} onChange={(f) => set('faq', f)} disabled={ro} />
      </Panel>

      <Panel className="pb-5 xl:col-span-2">
        <PanelHead
          icon={<Building2 className="h-4 w-4" />}
          title="De dónde sale el estado de un pedido"
        />
        <OrderSourcesEditor
          sources={draft.orderSources}
          trackers={trackers}
          onChange={(s) => set('orderSources', s)}
          disabled={ro}
        />
      </Panel>

      {canManage && (
        <div className="xl:col-span-2 flex flex-wrap items-center justify-end gap-3">
          {note && (
            <output className={clsx('text-sm', note.ok ? 'text-emerald' : 'text-rose')}>
              {note.ok ? note.note : note.error}
            </output>
          )}
          <Button disabled={pending} onClick={submit}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Guardar ajustes
          </Button>
        </div>
      )}
    </div>
  );
}

function HoursEditor({
  hours,
  onChange,
  disabled,
}: {
  hours: CustomerSettings['businessHours'];
  onChange: (next: CustomerSettings['businessHours']) => void;
  disabled: boolean;
}) {
  const setDay = (day: string, slot: [string, string] | null) => {
    const next = { ...hours };
    if (slot) next[day] = [slot];
    else delete next[day];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-ink-muted">
        Sin ningún día marcado, se considera que siempre hay alguien.
      </p>
      {WEEKDAY_TEXT.map(([day, label]) => {
        const slot = hours[day]?.[0] ?? null;
        return (
          <div key={day} className="flex items-center gap-2 text-sm">
            <label className="flex w-28 shrink-0 items-center gap-2 text-ink">
              <input
                type="checkbox"
                checked={!!slot}
                disabled={disabled}
                onChange={(e) => setDay(day, e.target.checked ? ['08:00', '18:00'] : null)}
              />
              {label}
            </label>
            {slot && (
              <>
                <input
                  type="time"
                  aria-label={`${label} desde`}
                  value={slot[0]}
                  disabled={disabled}
                  onChange={(e) => setDay(day, [e.target.value, slot[1]])}
                  className={clsx(fieldBase, 'w-32 shrink-0')}
                />
                <span className="text-ink-faint">a</span>
                <input
                  type="time"
                  aria-label={`${label} hasta`}
                  value={slot[1]}
                  disabled={disabled}
                  onChange={(e) => setDay(day, [slot[0], e.target.value])}
                  className={clsx(fieldBase, 'w-32 shrink-0')}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FaqEditor({
  faq,
  onChange,
  disabled,
}: {
  faq: FaqEntry[];
  onChange: (next: FaqEntry[]) => void;
  disabled: boolean;
}) {
  const patch = (i: number, value: Partial<FaqEntry>) =>
    onChange(faq.map((f, j) => (j === i ? { ...f, ...value } : f)));
  return (
    <div className="flex flex-col gap-3 px-6 pt-4">
      <p className="text-xs text-ink-muted">
        El bot contesta estas preguntas con tu respuesta, tal cual. Si no encaja con seguridad, pasa
        a una persona.
      </p>
      {faq.map((f, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: filas editables sin id propio; sólo cambian de lugar al quitar una.
          key={`faq-${i}`}
          className="grid gap-2 rounded-card border border-border p-3 md:grid-cols-[1fr_1fr_auto]"
        >
          <input
            aria-label="Pregunta"
            placeholder="Pregunta: ¿Hacen envíos a Medellín?"
            value={f.q}
            maxLength={300}
            disabled={disabled}
            onChange={(e) => patch(i, { q: e.target.value })}
            className={inputClass}
          />
          <input
            aria-label="Palabras clave"
            placeholder="Palabras clave, separadas por coma"
            value={(f.keywords ?? []).join(', ')}
            disabled={disabled}
            onChange={(e) =>
              patch(i, {
                keywords: e.target.value
                  .split(',')
                  .map((k) => k.trim())
                  .filter((k) => k.length >= 2)
                  .slice(0, 20),
              })
            }
            className={inputClass}
          />
          <button
            type="button"
            aria-label="Quitar pregunta"
            disabled={disabled}
            onClick={() => onChange(faq.filter((_, j) => j !== i))}
            className="inline-flex h-9 w-9 items-center justify-center rounded-pill text-ink-faint hover:bg-rose-soft hover:text-rose"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <textarea
            aria-label="Respuesta"
            placeholder="Respuesta aprobada"
            value={f.a}
            rows={2}
            maxLength={1200}
            disabled={disabled}
            onChange={(e) => patch(i, { a: e.target.value })}
            className={clsx(inputClass, 'md:col-span-3')}
          />
        </div>
      ))}
      {!disabled && faq.length < 60 && (
        <Button
          variant="outline"
          onClick={() => onChange([...faq, { q: '', a: '', keywords: [] }])}
        >
          <Plus className="h-4 w-4" />
          Agregar pregunta
        </Button>
      )}
    </div>
  );
}

function OrderSourcesEditor({
  sources,
  trackers,
  onChange,
  disabled,
}: {
  sources: OrderSource[];
  trackers: AtencionTracker[];
  onChange: (next: OrderSource[]) => void;
  disabled: boolean;
}) {
  const patch = (i: number, value: Partial<OrderSource>) =>
    onChange(sources.map((s, j) => (j === i ? { ...s, ...value } : s)));
  const add = () => {
    const t = trackers[0];
    if (!t) return;
    onChange([
      ...sources,
      {
        trackerId: t.id,
        label: t.name,
        numberField: t.fields[0]?.key ?? '',
        statusField: t.fields[1]?.key ?? t.fields[0]?.key ?? '',
        etaField: null,
        clientField: null,
      },
    ]);
  };
  const fieldSelect = (
    i: number,
    s: OrderSource,
    key: 'numberField' | 'statusField' | 'etaField' | 'clientField',
    label: string,
    optional: boolean,
  ) => {
    const tracker = trackers.find((t) => t.id === s.trackerId);
    return (
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        {label}
        <select
          value={s[key] ?? ''}
          disabled={disabled}
          onChange={(e) => patch(i, { [key]: e.target.value || null } as Partial<OrderSource>)}
          className={inputClass}
        >
          {optional && <option value="">— ninguno —</option>}
          {(tracker?.fields ?? []).map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
    );
  };
  return (
    <div className="flex flex-col gap-3 px-6 pt-4">
      <p className="text-xs text-ink-muted">
        La tabla donde están tus guías o pedidos. Del número que escriba el cliente sólo se dice el
        estado y la fecha estimada. Con la columna de cliente, si quien escribe ya está identificado
        y la guía es de otro cliente, se le dice que no la encontró.
      </p>
      {trackers.length === 0 && (
        <p className="text-xs text-ink-faint">
          Todavía no hay tablas. Crea la de Guías o Pedidos en Tablas y vuelve aquí.
        </p>
      )}
      {sources.map((s, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: filas editables sin id propio; sólo cambian de lugar al quitar una.
          key={`src-${i}`}
          className="grid gap-2 rounded-card border border-border p-3 md:grid-cols-3 xl:grid-cols-6"
        >
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            Tabla
            <select
              value={s.trackerId}
              disabled={disabled}
              onChange={(e) => {
                const t = trackers.find((x) => x.id === e.target.value);
                patch(i, {
                  trackerId: e.target.value,
                  label: t?.name ?? s.label,
                  numberField: t?.fields[0]?.key ?? '',
                  statusField: t?.fields[1]?.key ?? t?.fields[0]?.key ?? '',
                  etaField: null,
                  clientField: null,
                });
              }}
              className={inputClass}
            >
              {trackers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {fieldSelect(i, s, 'numberField', 'Número', false)}
          {fieldSelect(i, s, 'statusField', 'Estado', false)}
          {fieldSelect(i, s, 'etaField', 'Entrega estimada', true)}
          {fieldSelect(i, s, 'clientField', 'Cliente', true)}
          <div className="flex items-end">
            <button
              type="button"
              aria-label="Quitar tabla"
              disabled={disabled}
              onClick={() => onChange(sources.filter((_, j) => j !== i))}
              className="inline-flex h-9 w-9 items-center justify-center rounded-pill text-ink-faint hover:bg-rose-soft hover:text-rose"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
      {!disabled && trackers.length > 0 && sources.length < 10 && (
        <Button variant="outline" onClick={add}>
          <Plus className="h-4 w-4" />
          Agregar tabla
        </Button>
      )}
    </div>
  );
}
