'use client';

import { Button } from '@/components/ui/button';
import { IconChip, Panel, PanelHead } from '@/components/ui/panel';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MessageCircle,
  Plug,
  QrCode,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import { useState } from 'react';

/**
 * The one screen for the WhatsApp connection.
 *
 * Three questions, in the order somebody actually asks them: is it connected,
 * which groups are being archived, and whose numbers can talk to Cortex. The
 * pairing QR appears inside the first block only while it is relevant — a
 * screen that always shows a QR code trains people to ignore it.
 *
 * The copy is deliberately blunt about what archiving means. This is the one
 * screen in the product where switching something on files other people's
 * conversations into a searchable company archive, and softening that would be
 * a design failure, not a kindness.
 */

interface Connection {
  status: 'disconnected' | 'pairing' | 'connected' | 'logged_out';
  bridgeAlive: boolean;
  phoneNumber: string | null;
  qr: string | null;
  lastConnectedAt: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  dmEnabled: boolean;
}

interface Group {
  id: string;
  jid: string;
  subject: string | null;
  participants: number | null;
  archiving: boolean;
  spaceId: string | null;
  spaceName: string | null;
  archivingSince: string | null;
  lastMessageAt: string | null;
  lastIngestedAt: string | null;
}

interface Space {
  id: string;
  name: string;
  kind: 'global' | 'personal';
}

interface Link {
  phone: string;
  userId: string;
  personName: string;
  lastSeenAt: string | null;
}

interface Person {
  id: string;
  name: string;
  email: string;
}

interface Status {
  isAdmin: boolean;
  connection: Connection;
  groups: Group[];
  spaces: Space[];
  links: Link[];
  people: Person[];
}

async function fetchStatus(): Promise<Status> {
  const r = await fetch('/api/whatsapp/status');
  if (!r.ok) throw new Error('No se pudo leer el estado de WhatsApp.');
  return (await r.json()) as Status;
}

function fecha(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Intl.DateTimeFormat('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

function telefono(phone: string): string {
  // Grouped for reading, never re-formatted for storage: the stored value is
  // the digits WhatsApp keys on.
  return `+${phone.slice(0, 2)} ${phone.slice(2, 5)} ${phone.slice(5, 8)} ${phone.slice(8)}`.trim();
}

/* ----------------------------------------------------------------- conexión */

function ConnectionPanel({ connection }: { connection: Connection }) {
  const { status, bridgeAlive } = connection;

  // The bridge going quiet is a different problem from WhatsApp dropping the
  // session, and they need different answers, so they are never shown as one
  // "disconnected".
  const state = !bridgeAlive
    ? ('offline' as const)
    : status === 'connected'
      ? ('connected' as const)
      : status === 'pairing'
        ? ('pairing' as const)
        : status === 'logged_out'
          ? ('logged_out' as const)
          : ('down' as const);

  const COPY = {
    connected: {
      tone: 'emerald' as const,
      icon: <CheckCircle2 className="h-4 w-4" />,
      title: 'Conectado',
      line: connection.phoneNumber
        ? `En línea con el número ${telefono(connection.phoneNumber)}.`
        : 'En línea.',
    },
    pairing: {
      tone: 'amber' as const,
      icon: <QrCode className="h-4 w-4" />,
      title: 'Esperando el emparejamiento',
      line: 'Escanea el código con el teléfono dedicado: WhatsApp → Dispositivos vinculados → Vincular un dispositivo.',
    },
    logged_out: {
      tone: 'rose' as const,
      icon: <AlertTriangle className="h-4 w-4" />,
      title: 'WhatsApp cerró la sesión',
      line: 'El dispositivo fue desvinculado desde el teléfono o por WhatsApp. Hay que volver a emparejar; nada de lo ya archivado se pierde.',
    },
    down: {
      tone: 'amber' as const,
      icon: <Plug className="h-4 w-4" />,
      title: 'Sin conexión',
      line: 'El servicio está corriendo pero no logra conectarse a WhatsApp. Reintenta solo, cada vez con más espera entre intentos.',
    },
    offline: {
      tone: 'rose' as const,
      icon: <AlertTriangle className="h-4 w-4" />,
      title: 'El servicio no está reportando',
      line: 'Nadie ha dado señales en los últimos minutos. Revisa el servicio de WhatsApp en Railway: mientras esté caído no entra nada nuevo, pero no se pierde lo que ya estaba.',
    },
  }[state];

  return (
    <Panel>
      <PanelHead
        title="Conexión"
        right={connection.lastSeenAt ? `visto ${fecha(connection.lastSeenAt)}` : 'sin señales'}
      />
      <div className="flex items-start gap-3 px-5 py-4">
        <IconChip tone={COPY.tone}>{COPY.icon}</IconChip>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink">{COPY.title}</div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">{COPY.line}</p>
          {connection.lastError && state !== 'connected' && (
            <p className="mt-2 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-[12px] leading-relaxed text-ink">
              {connection.lastError}
            </p>
          )}
        </div>
      </div>

      {connection.qr && state !== 'connected' && (
        <div className="flex flex-col items-center gap-2 border-t border-border px-5 py-5">
          {/* A plain <img>: the source is a data: URL that changes every few
              seconds, so there is nothing for next/image to optimise or cache. */}
          <img
            src={connection.qr}
            alt="Código QR para vincular WhatsApp"
            className="h-56 w-56 rounded-card border border-border bg-white p-2"
          />
          <p className="max-w-sm text-center text-[12px] leading-relaxed text-ink-faint">
            El código cambia cada pocos segundos. Si se vence, esta pantalla muestra el siguiente
            sola.
          </p>
        </div>
      )}

      <div className="border-t border-border px-5 py-3">
        <p className="text-[12px] leading-relaxed text-ink-faint">
          Usa un <b className="font-semibold text-ink-muted">número dedicado de la empresa</b>,
          nunca el personal de alguien. Este es un cliente no oficial y WhatsApp puede bloquear el
          número.
        </p>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------- grupos */

function GroupRow({
  group,
  spaces,
  onSave,
  busy,
}: {
  group: Group;
  spaces: Space[];
  onSave: (input: { jid: string; archiving: boolean; spaceId?: string }) => void;
  busy: boolean;
}) {
  const [spaceId, setSpaceId] = useState(group.spaceId ?? spaces[0]?.id ?? '');

  return (
    <div className="flex flex-wrap items-start gap-3 border-t border-border px-5 py-3.5">
      <IconChip tone={group.archiving ? 'emerald' : 'sky'}>
        <Users className="h-4 w-4" />
      </IconChip>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-ink">
          {group.subject ?? 'Grupo sin nombre'}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-faint">
          {group.participants != null && (
            <span className="tabular">{group.participants} personas</span>
          )}
          {group.lastMessageAt && (
            <>
              <span>&middot;</span>
              <span className="tabular">último mensaje {fecha(group.lastMessageAt)}</span>
            </>
          )}
        </div>

        {group.archiving ? (
          <p className="mt-1 text-[12px] leading-relaxed text-emerald">
            Se archiva en <b className="font-semibold">{group.spaceName ?? 'un espacio borrado'}</b>{' '}
            desde el {fecha(group.archivingSince)}.
          </p>
        ) : (
          <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
            No se archiva. Cortex ve el grupo pero no guarda nada de él.
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {!group.archiving && (
          <select
            value={spaceId}
            onChange={(e) => setSpaceId(e.target.value)}
            aria-label="Espacio de destino"
            className="h-9 rounded-card border border-border bg-surface px-2.5 text-[12.5px] text-ink"
          >
            <option value="">¿En qué espacio?</option>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.kind === 'global' ? ' (toda la empresa)' : ''}
              </option>
            ))}
          </select>
        )}
        <Button
          variant={group.archiving ? 'outline' : 'default'}
          disabled={busy || (!group.archiving && !spaceId)}
          onClick={() =>
            onSave(
              group.archiving
                ? { jid: group.jid, archiving: false }
                : { jid: group.jid, archiving: true, spaceId },
            )
          }
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {group.archiving ? 'Dejar de archivar' : 'Archivar'}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ números */

function LinksPanel({
  links,
  people,
  isAdmin,
  onLink,
  onUnlink,
  busy,
}: {
  links: Link[];
  people: Person[];
  isAdmin: boolean;
  onLink: (input: { phone: string; userId: string }) => void;
  onUnlink: (phone: string) => void;
  busy: boolean;
}) {
  const [phone, setPhone] = useState('');
  const [userId, setUserId] = useState('');

  return (
    <Panel>
      <PanelHead title="Quién puede escribirle" right={`${links.length} números`} />
      <p className="px-5 pt-1 text-[12.5px] leading-relaxed text-ink-muted">
        Cada mensaje directo corre con la identidad y los permisos de la persona del número. Un
        número que no esté aquí recibe una negativa corta y queda registrado; nunca se ejecuta nada.
      </p>

      {isAdmin && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+57 300 111 2233"
            aria-label="Número de WhatsApp"
            className="tabular h-9 w-full max-w-[190px] rounded-card border border-border bg-surface px-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40"
          />
          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            aria-label="Persona"
            className="h-9 rounded-card border border-border bg-surface px-2.5 text-[12.5px] text-ink"
          >
            <option value="">¿De quién es?</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button
            disabled={busy || !phone.trim() || !userId}
            onClick={() => {
              onLink({ phone, userId });
              setPhone('');
              setUserId('');
            }}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Vincular
          </Button>
        </div>
      )}

      {links.length === 0 ? (
        <p className="border-t border-border px-5 py-4 text-[12.5px] text-ink-faint">
          Todavía no hay números vinculados, así que nadie puede conversar con Cortex por WhatsApp.
        </p>
      ) : (
        links.map((link) => (
          <div
            key={link.phone}
            className="flex items-center gap-3 border-t border-border px-5 py-3"
          >
            <IconChip tone="primary">
              <UserRound className="h-4 w-4" />
            </IconChip>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-ink">{link.personName}</div>
              <div className="tabular mt-0.5 text-[11.5px] text-ink-faint">
                {telefono(link.phone)}
                {link.lastSeenAt ? ` · escribió ${fecha(link.lastSeenAt)}` : ' · nunca ha escrito'}
              </div>
            </div>
            {isAdmin && (
              <button
                type="button"
                onClick={() => onUnlink(link.phone)}
                disabled={busy}
                aria-label={`Quitar el número de ${link.personName}`}
                className="rounded-card p-2 text-ink-faint transition-colors hover:bg-rose-soft hover:text-rose"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        ))
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------- index */

export function WhatsappConsole({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['whatsapp-status'],
    queryFn: fetchStatus,
    // The QR rotates every few seconds and the connection state changes on its
    // own; a screen somebody is staring at while pairing has to keep up.
    refetchInterval: 8_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['whatsapp-status'] });

  const saveGroup = useMutation({
    mutationFn: async (input: { jid: string; archiving: boolean; spaceId?: string }) => {
      const r = await fetch('/api/whatsapp/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const j = (await r.json()) as { note?: string; error?: string };
      if (!r.ok) throw new Error(j.error ?? 'No se pudo guardar el cambio.');
      return j.note ?? 'Listo.';
    },
    onSuccess: async (note) => {
      setMessage({ tone: 'ok', text: note });
      await invalidate();
    },
    onError: (err: Error) => setMessage({ tone: 'bad', text: err.message }),
  });

  const linkNumber = useMutation({
    mutationFn: async (input: { phone: string; userId: string }) => {
      const r = await fetch('/api/whatsapp/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? 'No se pudo vincular el número.');
    },
    onSuccess: async () => {
      setMessage({ tone: 'ok', text: 'Número vinculado. Ya puede escribirle a Cortex.' });
      await invalidate();
    },
    onError: (err: Error) => setMessage({ tone: 'bad', text: err.message }),
  });

  const unlinkNumber = useMutation({
    mutationFn: async (phone: string) => {
      const r = await fetch(`/api/whatsapp/links?phone=${encodeURIComponent(phone)}`, {
        method: 'DELETE',
      });
      if (!r.ok) {
        const j = (await r.json()) as { error?: string };
        throw new Error(j.error ?? 'No se pudo quitar el número.');
      }
    },
    onSuccess: async () => {
      setMessage({
        tone: 'ok',
        text: 'Número desvinculado. Deja de responderle desde el próximo mensaje.',
      });
      await invalidate();
    },
    onError: (err: Error) => setMessage({ tone: 'bad', text: err.message }),
  });

  if (isLoading || !data) {
    return <div className="h-64 animate-pulse rounded-card bg-surface-2" />;
  }

  const archiving = data.groups.filter((g) => g.archiving);
  const rest = data.groups.filter((g) => !g.archiving);
  const busy = saveGroup.isPending || linkNumber.isPending || unlinkNumber.isPending;

  return (
    <div className="flex flex-col gap-5">
      {message && (
        <p
          className={
            message.tone === 'ok'
              ? 'rounded-card border border-emerald/30 bg-emerald-soft px-4 py-2.5 text-[12.5px] leading-relaxed text-ink'
              : 'rounded-card border border-rose/30 bg-rose-soft px-4 py-2.5 text-[12.5px] leading-relaxed text-ink'
          }
        >
          {message.text}
        </p>
      )}

      <ConnectionPanel connection={data.connection} />

      <Panel>
        <PanelHead
          title="Grupos"
          right={`${archiving.length} de ${data.groups.length} archivándose`}
        />
        <p className="px-5 pb-3 pt-1 text-[12.5px] leading-relaxed text-ink-muted">
          Elige grupo por grupo. Archivar guarda la conversación en Brain Knowledge con el nombre de
          quien escribió cada mensaje — incluida gente que no trabaja aquí. Empieza a contar desde
          el momento en que lo enciendes, nunca hacia atrás.
        </p>

        {data.spaces.length === 0 && (
          <p className="border-t border-border px-5 py-4 text-[12.5px] text-ink-faint">
            Necesitas un espacio de Brain Knowledge donde puedas escribir antes de archivar un
            grupo.
          </p>
        )}

        {data.groups.length === 0 ? (
          <p className="border-t border-border px-5 py-4 text-[12.5px] text-ink-faint">
            Todavía no hay grupos. Aparecen solos cuando el número quede conectado y esté dentro de
            algún grupo.
          </p>
        ) : (
          [...archiving, ...rest].map((group) => (
            <GroupRow
              key={group.id}
              group={group}
              spaces={data.spaces}
              busy={busy}
              onSave={(input) => saveGroup.mutate(input)}
            />
          ))
        )}
      </Panel>

      <LinksPanel
        links={data.links}
        people={data.people}
        isAdmin={isAdmin && data.isAdmin}
        busy={busy}
        onLink={(input) => linkNumber.mutate(input)}
        onUnlink={(phone) => unlinkNumber.mutate(phone)}
      />

      <p className="flex items-start gap-2 px-1 text-[12px] leading-relaxed text-ink-faint">
        <MessageCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Las conversaciones archivadas quedan como documentos normales: se buscan, se citan y se
        borran desde Brain Knowledge, con los permisos del espacio donde las pusiste.
      </p>
    </div>
  );
}
