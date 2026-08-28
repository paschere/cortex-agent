'use client';

import { Button } from '@/components/ui/button';
import { IconChip, Panel, PanelHead } from '@/components/ui/panel';
import { type SetupFacts, setupSteps, wouldAnswerMe } from '@/lib/whatsapp-setup';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  MessageCircle,
  Plug,
  QrCode,
  Send,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

/**
 * The one screen for the WhatsApp connection.
 *
 * IT OPENS WITH A SEQUENCE, and that is the whole reason this screen moved out
 * of Brain Knowledge. What people want first is to text the number and be
 * answered, and that needs three things in order: pair the company line, link
 * your own number to your Cortex user, then decide which groups are read. The
 * middle step is invisible until it bites — an unlinked number gets a polite
 * "no te reconozco" — so the checklist states it up front instead of letting
 * somebody discover it with their thumb.
 *
 * Below the checklist the three blocks appear in that same order. The pairing
 * QR shows inside the first one only while it is relevant: a screen that always
 * shows a QR code trains people to ignore it.
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
  /** Answering — a different permission from archiving. */
  replying: boolean;
  replyScope: 'plain' | 'knowledge' | 'internal';
  replySpaceId: string | null;
  replySpaceName: string | null;
  replyingSince: string | null;
  replyLimitPerHour: number;
}

interface Space {
  id: string;
  name: string;
  kind: 'global' | 'shared' | 'personal';
}

interface NumberLink {
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

/** A number that wrote to the line and was turned away. */
interface UnlinkedNumber {
  phone: string;
  attempts: number;
  lastAt: string;
}

interface Status {
  isAdmin: boolean;
  connection: Connection;
  groups: Group[];
  spaces: Space[];
  /** Only company-wide spaces: a personal one can never be cited in a group. */
  citableSpaces: Space[];
  links: NumberLink[];
  people: Person[];
  me: { id: string; name: string; phone: string | null };
  unlinkedNumbers: UnlinkedNumber[];
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
  // the digits WhatsApp keys on, and `normalizePhone` on the server is the only
  // thing allowed to decide what those digits are.
  return `+${phone.slice(0, 2)} ${phone.slice(2, 5)} ${phone.slice(5, 8)} ${phone.slice(8)}`.trim();
}

/* --------------------------------------------------------------- la secuencia */

const STEP_COPY: Record<'pair' | 'link' | 'groups', { title: string; line: string }> = {
  pair: {
    title: 'Empareja el número de la empresa',
    line: 'Escanea el código con el teléfono dedicado. Sin esto no entra ni sale nada.',
  },
  link: {
    title: 'Vincula tu número',
    line: 'Cortex solo le responde a números que sabe de quién son. Si el tuyo no está, te contesta que no te reconoce.',
  },
  groups: {
    title: 'Elige los grupos',
    line: 'Cuáles se archivan en Brain Knowledge y en cuáles puede responder si lo mencionan.',
  },
};

/**
 * What is missing, in the order en que hay que hacerlo.
 *
 * Shown while anything is pending and reduced to one green line when nothing
 * is: a permanent checklist of ticks is furniture.
 */
function SetupChecklist({ facts }: { facts: SetupFacts }) {
  const steps = setupSteps(facts);
  const answer = wouldAnswerMe(facts);

  if (answer.yes && facts.groupsConfigured > 0) {
    return (
      <Panel className="flex items-start gap-3 px-5 py-4">
        <IconChip tone="emerald">
          <CheckCircle2 className="h-4 w-4" />
        </IconChip>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">Listo para usarse</div>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            El número está en línea, el tuyo está vinculado y hay{' '}
            <span className="tabular">{facts.groupsConfigured}</span>{' '}
            {facts.groupsConfigured === 1 ? 'grupo configurado' : 'grupos configurados'}. Escríbele
            desde tu teléfono cuando quieras.
          </p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHead
        title="Para que Cortex te conteste"
        right={answer.yes ? 'ya te contesta' : 'todavía no te contesta'}
      />
      <p className="px-5 pt-1 text-xs leading-relaxed text-ink-muted">
        Tres pasos, en este orden. El del medio es el que se olvida: sin él el número queda en línea
        y aun así te responde que no sabe quién eres.
      </p>
      <ol className="mt-3 divide-y divide-border border-t border-border">
        {steps.map((step, i) => {
          const copy = STEP_COPY[step.key];
          return (
            <li key={step.key} className="flex items-start gap-3 px-5 py-3">
              <span
                className={clsx(
                  'grid h-7 w-7 shrink-0 place-items-center rounded-sm text-xs font-bold',
                  step.state === 'done' && 'bg-emerald-soft text-emerald',
                  step.state === 'now' && 'bg-amber-soft text-amber',
                  step.state === 'later' && 'bg-surface-2 text-ink-faint',
                )}
              >
                {step.state === 'done' ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div
                  className={clsx(
                    'text-sm font-semibold',
                    step.state === 'later' ? 'text-ink-faint' : 'text-ink',
                  )}
                >
                  {copy.title}
                </div>
                <p
                  className={clsx(
                    'mt-0.5 text-xs leading-relaxed',
                    step.state === 'later' ? 'text-ink-faint' : 'text-ink-muted',
                  )}
                >
                  {copy.line}
                </p>
              </div>
              {step.state === 'now' && (
                <span className="shrink-0 rounded-pill border border-amber/40 bg-amber-soft px-2.5 py-0.5 text-micro font-semibold text-amber">
                  Sigue esto
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
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
        title="1 · Conexión"
        right={connection.lastSeenAt ? `visto ${fecha(connection.lastSeenAt)}` : 'sin señales'}
      />
      <div className="flex items-start gap-3 px-5 py-4">
        <IconChip tone={COPY.tone}>{COPY.icon}</IconChip>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">{COPY.title}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{COPY.line}</p>
          {connection.lastError && state !== 'connected' && (
            <p className="mt-2 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-xs leading-relaxed text-ink">
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
          <p className="max-w-sm text-center text-xs leading-relaxed text-ink-faint">
            El código cambia cada pocos segundos. Si se vence, esta pantalla muestra el siguiente
            sola.
          </p>
        </div>
      )}

      <div className="border-t border-border px-5 py-3">
        <p className="text-xs leading-relaxed text-ink-faint">
          Usa un <b className="font-semibold text-ink-muted">número dedicado de la empresa</b>,
          nunca el personal de alguien. Este es un cliente no oficial y WhatsApp puede bloquear el
          número.
        </p>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------- tu propio número */

/**
 * The step everybody skips, made into one click.
 *
 * THE PROBLEM IT SOLVES: linking a number used to mean typing it, and a number
 * typed with the wrong country code produces a link that matches nobody — so
 * the screen said "vinculado" and WhatsApp kept answering "no te reconozco".
 *
 * THE FIX: never ask for the digits. You tap "Escribirle" (a wa.me link that
 * opens WhatsApp with the message ready), your number reaches the line, the
 * refusal is filed with the number already through `normalizePhone`, and it
 * comes back here as a button. What gets stored is what WhatsApp sent, so it
 * cannot be wrong. Nothing about the format is computed in the browser.
 *
 * WHO MAY PRESS IT: an org admin, unchanged. A link is an authorisation — it
 * decides that messages from a number run with a named person's integrations
 * and permissions — and `/api/whatsapp/links` refuses anybody else. Making the
 * gesture one click does not make it self-service.
 */
function MyNumberPanel({
  me,
  connection,
  unlinked,
  isAdmin,
  onLink,
  busy,
}: {
  me: Status['me'];
  connection: Connection;
  unlinked: UnlinkedNumber[];
  isAdmin: boolean;
  onLink: (input: { phone: string; userId: string }) => void;
  busy: boolean;
}) {
  const paired = connection.status === 'connected';
  const waHref = connection.phoneNumber
    ? `https://wa.me/${connection.phoneNumber}?text=${encodeURIComponent('Hola')}`
    : null;

  if (me.phone) {
    return (
      <Panel>
        <PanelHead title="2 · Tu número" right="vinculado" />
        <div className="flex flex-wrap items-start gap-3 px-5 py-4">
          <IconChip tone="emerald">
            <CheckCircle2 className="h-4 w-4" />
          </IconChip>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-ink">Cortex ya te contesta</div>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
              Escribe desde{' '}
              <span className="font-mono text-xs text-ink">{telefono(me.phone)}</span> y la
              conversación corre con tu identidad y tus permisos, igual que en la web.
            </p>
          </div>
          {waHref && (
            <a
              href={waHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-primary px-3 py-1.5 text-xs font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong motion-reduce:transform-none motion-reduce:transition-none"
            >
              <Send className="h-3.5 w-3.5" />
              Escribirle
            </a>
          )}
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHead title="2 · Tu número" right="sin vincular" />
      <div className="flex items-start gap-3 px-5 py-4">
        <IconChip tone="amber">
          <UserRound className="h-4 w-4" />
        </IconChip>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">
            Hoy Cortex te respondería que no te reconoce
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            Un mensaje directo corre con la identidad de la persona dueña del número. Mientras el
            tuyo no esté aquí, recibes una negativa corta y no se ejecuta nada.
          </p>
        </div>
      </div>

      {!paired ? (
        <p className="border-t border-border px-5 py-3.5 text-xs leading-relaxed text-ink-faint">
          Primero hay que emparejar el número de la empresa, arriba. Sin línea no hay a quién
          escribirle.
        </p>
      ) : (
        <>
          <div className="border-t border-border px-5 py-3.5">
            <div className="field-label">Cómo se hace sin teclear tu número</div>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Escríbele <b className="font-semibold text-ink">“Hola”</b> al número de la empresa
              desde tu teléfono. Te va a decir que no te reconoce —es lo esperado— y tu número
              aparece abajo para vincularlo con un clic, tal como WhatsApp lo escribe.
            </p>
            {waHref && (
              <a
                href={waHref}
                target="_blank"
                rel="noreferrer"
                className="mt-2.5 inline-flex items-center gap-1.5 rounded-pill bg-primary px-3 py-1.5 text-xs font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong motion-reduce:transform-none motion-reduce:transition-none"
              >
                <Send className="h-3.5 w-3.5" />
                Escribirle al número
              </a>
            )}
          </div>

          {/* Only an admin gets the list, and only an admin gets it from the
              API: these are other people's numbers, including strangers who
              found the line, and nobody else can act on them anyway. */}
          <div className="border-t border-border px-5 py-3.5">
            <div className="field-label">
              {isAdmin ? 'Números que escribieron y no reconocemos' : 'Quién lo vincula'}
              {isAdmin && unlinked.length > 0 && (
                <>
                  {' · '}
                  <span className="tabular">{unlinked.length}</span>
                </>
              )}
            </div>

            {!isAdmin ? (
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                Vincular un número da permisos, así que lo hace un administrador. Escríbele al
                número y pídele a un administrador que abra esta pantalla: el tuyo le aparece ahí
                para vincularlo de una.
              </p>
            ) : unlinked.length === 0 ? (
              <p className="mt-1 text-xs leading-relaxed text-ink-faint">
                Todavía no ha escrito nadie desconocido. En cuanto lo hagas, tu número sale aquí en
                segundos.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1.5">
                {unlinked.map((n) => (
                  <li
                    key={n.phone}
                    className="flex flex-wrap items-center gap-2 rounded-card bg-surface-2 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-xs text-ink">{telefono(n.phone)}</div>
                      <div className="mt-0.5 text-micro text-ink-faint">
                        <span className="tabular">{n.attempts}</span>{' '}
                        {n.attempts === 1 ? 'intento' : 'intentos'} · último {fecha(n.lastAt)}
                      </div>
                    </div>
                    <Button
                      disabled={busy}
                      onClick={() => onLink({ phone: n.phone, userId: me.id })}
                    >
                      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      Es mío
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {isAdmin && unlinked.length > 0 && (
              <p className="mt-2 text-micro leading-relaxed text-ink-faint">
                Si alguno es de un compañero, vincúlalo abajo eligiendo a quién pertenece. “Es mío”
                lo vincula a ti, {me.name}.
              </p>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------- grupos */

const SCOPE_COPY: Record<
  Group['replyScope'],
  { name: string; line: string; tone: 'sky' | 'amber' }
> = {
  plain: {
    name: 'Solo la conversación',
    line: 'Resume, traduce, saca cuentas y redacta con lo que se dijo en el grupo. No consulta ningún sistema de la empresa.',
    tone: 'sky',
  },
  knowledge: {
    name: 'Conversación + un espacio',
    line: 'Además puede citar un espacio de empresa de Brain Knowledge. Nunca espacios personales.',
    tone: 'sky',
  },
  internal: {
    name: 'Grupo interno',
    line: 'Además consulta los sistemas de trabajo de quien pregunta. Solo para grupos sin clientes ni proveedores adentro.',
    tone: 'amber',
  },
};

/**
 * One group, two switches.
 *
 * They are drawn as two separate rows of controls with their own sentences,
 * never as one "activar" toggle, because they are two different decisions with
 * two different risks: archiving decides what the company remembers, answering
 * decides what Cortex says out loud in a room that may contain the client. The
 * screen has to make the answer to "¿qué puede decir Cortex aquí?" readable at
 * a glance — nobody should discover the scope by way of something leaking.
 */
function GroupRow({
  group,
  spaces,
  citableSpaces,
  onArchive,
  onReply,
  busy,
}: {
  group: Group;
  spaces: Space[];
  citableSpaces: Space[];
  onArchive: (input: { jid: string; archiving: boolean; spaceId?: string }) => void;
  onReply: (input: {
    jid: string;
    replying: boolean;
    replyScope?: string;
    replySpaceId?: string | null;
  }) => void;
  busy: boolean;
}) {
  const [spaceId, setSpaceId] = useState(group.spaceId ?? spaces[0]?.id ?? '');
  const [scope, setScope] = useState<Group['replyScope']>(group.replyScope);
  const [replySpaceId, setReplySpaceId] = useState(
    group.replySpaceId ?? citableSpaces[0]?.id ?? '',
  );

  const scopeCopy = SCOPE_COPY[group.replyScope];

  return (
    <div className="border-t border-border px-5 py-3.5">
      <div className="flex flex-wrap items-start gap-3">
        <IconChip tone={group.archiving || group.replying ? 'emerald' : 'sky'}>
          <Users className="h-4 w-4" />
        </IconChip>

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-ink">
            {group.subject ?? 'Grupo sin nombre'}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-micro text-ink-faint">
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
        </div>
      </div>

      {/* ---- archivar ---- */}
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-card bg-surface-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="field-label">Archivar</div>
          {group.archiving ? (
            <p className="text-xs leading-relaxed text-emerald">
              Se guarda en{' '}
              <b className="font-semibold">{group.spaceName ?? 'un espacio borrado'}</b> desde el{' '}
              {fecha(group.archivingSince)}.
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-ink-faint">
              No se guarda nada de este grupo.
            </p>
          )}
        </div>
        {!group.archiving && (
          <select
            value={spaceId}
            onChange={(e) => setSpaceId(e.target.value)}
            aria-label="Espacio de destino"
            className="h-9 rounded-card border border-border bg-surface px-2.5 text-xs text-ink"
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
            onArchive(
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

      {/* ---- responder ---- */}
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-card bg-surface-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="field-label">Responder si lo mencionan</div>
          {group.replying ? (
            <>
              <p className="text-xs leading-relaxed text-emerald">
                Responde solo cuando lo mencionen con @, desde el {fecha(group.replyingSince)}.
                Máximo {group.replyLimitPerHour} respuestas por hora.
              </p>
              <p
                className={
                  scopeCopy.tone === 'amber'
                    ? 'mt-1 rounded-card border border-amber/30 bg-amber-soft px-2.5 py-1.5 text-micro leading-relaxed text-ink'
                    : 'mt-1 text-micro leading-relaxed text-ink-muted'
                }
              >
                <b className="font-semibold">{scopeCopy.name}.</b> {scopeCopy.line}
                {group.replyScope === 'knowledge' && (
                  <>
                    {' '}
                    Espacio: <b className="font-semibold">{group.replySpaceName ?? 'ninguno'}</b>.
                  </>
                )}
              </p>
            </>
          ) : (
            <p className="text-xs leading-relaxed text-ink-faint">
              Cortex lee pero nunca escribe en este grupo.
            </p>
          )}
        </div>

        {!group.replying && (
          <>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as Group['replyScope'])}
              aria-label="Qué puede responder"
              className="h-9 rounded-card border border-border bg-surface px-2.5 text-xs text-ink"
            >
              <option value="plain">Solo la conversación</option>
              <option value="knowledge">Conversación + un espacio</option>
              <option value="internal">Grupo interno (sin gente de fuera)</option>
            </select>
            {scope === 'knowledge' && (
              <select
                value={replySpaceId}
                onChange={(e) => setReplySpaceId(e.target.value)}
                aria-label="Espacio que puede citar"
                className="h-9 rounded-card border border-border bg-surface px-2.5 text-xs text-ink"
              >
                <option value="">¿Qué espacio puede citar?</option>
                {citableSpaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </>
        )}

        <Button
          variant={group.replying ? 'outline' : 'default'}
          disabled={busy || (!group.replying && scope === 'knowledge' && !replySpaceId)}
          onClick={() =>
            onReply(
              group.replying
                ? { jid: group.jid, replying: false }
                : {
                    jid: group.jid,
                    replying: true,
                    replyScope: scope,
                    replySpaceId: scope === 'knowledge' ? replySpaceId : null,
                  },
            )
          }
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {group.replying ? 'Dejar de responder' : 'Dejar que responda'}
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
  links: NumberLink[];
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
      <PanelHead title="Quién más puede escribirle" right={`${links.length} números`} />
      <p className="px-5 pt-1 text-xs leading-relaxed text-ink-muted">
        Cada mensaje directo corre con la identidad y los permisos de la persona del número. Un
        número que no esté aquí recibe una negativa corta y queda registrado; nunca se ejecuta nada.
      </p>

      {isAdmin && (
        <div className="mt-3 border-t border-border px-5 py-3">
          <div className="field-label">Vincular a mano</div>
          <p className="mt-1 text-micro leading-relaxed text-ink-faint">
            Para alguien que no está frente a la pantalla. Escríbelo con indicativo; nosotros lo
            dejamos en el formato que WhatsApp usa.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+57 300 111 2233"
              aria-label="Número de WhatsApp"
              className="h-9 w-full max-w-[190px] rounded-card border border-border bg-surface px-3 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-primary/40"
            />
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              aria-label="Persona"
              className="h-9 rounded-card border border-border bg-surface px-2.5 text-xs text-ink"
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
        </div>
      )}

      {links.length === 0 ? (
        <p className="border-t border-border px-5 py-4 text-xs text-ink-faint">
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
              <div className="truncate text-sm font-semibold text-ink">{link.personName}</div>
              <div className="mt-0.5 font-mono text-micro text-ink-faint">
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
    // own; a screen somebody is staring at while pairing has to keep up. It is
    // also what makes "escríbele y tu número aparece abajo" feel immediate.
    refetchInterval: 8_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['whatsapp-status'] });

  const setReplying = useMutation({
    mutationFn: async (input: {
      jid: string;
      replying: boolean;
      replyScope?: string;
      replySpaceId?: string | null;
    }) => {
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
    mutationFn: async (input: { phone: string; userId: string; mine?: boolean }) => {
      const r = await fetch('/api/whatsapp/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: input.phone, userId: input.userId }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? 'No se pudo vincular el número.');
      return input.mine === true;
    },
    onSuccess: async (mine) => {
      setMessage({
        tone: 'ok',
        text: mine
          ? 'Tu número quedó vinculado. Vuelve a escribirle y ya te contesta.'
          : 'Número vinculado. Ya puede escribirle a Cortex.',
      });
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

  // Sorted by "does Cortex do anything here", not by archiving alone — the two
  // permissions are independent and a reply-only group is just as configured as
  // an archive-only one.
  const active = data.groups.filter((g) => g.archiving || g.replying);
  const rest = data.groups.filter((g) => !g.archiving && !g.replying);
  const busy =
    saveGroup.isPending || setReplying.isPending || linkNumber.isPending || unlinkNumber.isPending;

  const facts: SetupFacts = {
    connected: data.connection.status === 'connected' && data.connection.bridgeAlive,
    myNumberLinked: data.me.phone !== null,
    groupsConfigured: active.length,
  };

  return (
    <div className="flex flex-col gap-5">
      {message && (
        <p
          className={
            message.tone === 'ok'
              ? 'rounded-card border border-emerald/30 bg-emerald-soft px-4 py-2.5 text-xs leading-relaxed text-ink'
              : 'rounded-card border border-rose/30 bg-rose-soft px-4 py-2.5 text-xs leading-relaxed text-ink'
          }
        >
          {message.text}
        </p>
      )}

      <SetupChecklist facts={facts} />

      <ConnectionPanel connection={data.connection} />

      <MyNumberPanel
        me={data.me}
        connection={data.connection}
        unlinked={data.unlinkedNumbers}
        isAdmin={isAdmin && data.isAdmin}
        busy={busy}
        onLink={(input) => linkNumber.mutate({ ...input, mine: true })}
      />

      <Panel>
        <PanelHead
          title="3 · Grupos"
          right={`${data.groups.filter((g) => g.archiving).length} archivándose · ${data.groups.filter((g) => g.replying).length} respondiendo`}
        />
        <div className="px-5 pb-3 pt-1 text-xs leading-relaxed text-ink-muted">
          <p>
            Cada grupo tiene <b className="font-semibold text-ink">dos permisos aparte</b>, y uno no
            implica el otro.
          </p>
          <p className="mt-1.5">
            <b className="font-semibold text-ink">Archivar</b> guarda la conversación en Brain
            Knowledge con el nombre de quien escribió cada mensaje — incluida gente que no trabaja
            aquí. Empieza a contar desde que lo enciendes, nunca hacia atrás.
          </p>
          <p className="mt-1.5">
            <b className="font-semibold text-ink">Responder</b> deja que Cortex escriba en el grupo,
            y solo cuando lo mencionen con @. Sin mención sigue callado. Ahí lo lee todo el mundo
            del grupo, así que elige con cuidado qué puede consultar para responder.
          </p>
        </div>

        {data.spaces.length === 0 && (
          <p className="border-t border-border px-5 py-4 text-xs text-ink-faint">
            Necesitas un espacio de Brain Knowledge donde puedas escribir antes de archivar un
            grupo.
          </p>
        )}

        {data.groups.length === 0 ? (
          <p className="border-t border-border px-5 py-4 text-xs text-ink-faint">
            Todavía no hay grupos. Aparecen solos cuando el número quede conectado y esté dentro de
            algún grupo.
          </p>
        ) : (
          [...active, ...rest].map((group) => (
            <GroupRow
              key={group.id}
              group={group}
              spaces={data.spaces}
              citableSpaces={data.citableSpaces}
              busy={busy}
              onArchive={(input) => saveGroup.mutate(input)}
              onReply={(input) => setReplying.mutate(input)}
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

      <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-ink-faint">
        <MessageCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Las conversaciones archivadas quedan como documentos normales: se buscan, se citan y se
        borran desde{' '}
        <Link href="/kb" className="inline-flex items-center gap-0.5 font-semibold text-primary">
          Brain Knowledge
          <ArrowRight className="h-3 w-3" />
        </Link>
        , con los permisos del espacio donde las pusiste. Cortex nunca escribe primero: en los
        grupos solo contesta si lo mencionan, y por interno solo si le escribieron.
      </p>
    </div>
  );
}
