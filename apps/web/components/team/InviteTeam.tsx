'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cop, count } from '@/lib/plan-shape';
import {
  type InviteEmailResult,
  type InviteStatus,
  MAX_INVITES_PER_REQUEST,
  STATUS_LABEL,
  looksLikeEmail,
  parseEmailList,
} from '@/lib/team/invitation-input';
import {
  COFOUNDER_ROLE,
  INVITABLE_ROLES,
  INVITATION_TTL_DAYS,
  invitationRoleLabel,
} from '@/lib/team/invitation-roles';
import { STEP_UP_COPY, type StepUpRequirement } from '@/lib/team/step-up-rules';
import { Check, Copy, Crown, MessageCircle, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';

/**
 * Invitar a la gente de la empresa, desde el producto.
 *
 * VIVE AQUÍ Y NO EN `onboarding/_components/` PORQUE INVITAR NO ES UN PASO DEL
 * ARRANQUE: es lo que alguien viene a hacer a «Personas» cuando quiere agregar a
 * alguien, y tiene que seguir ahí después de la segunda persona. El componente
 * sigue siendo de props puras; la comprobación de asientos sigue siendo de la
 * ruta (`POST /api/team/invite`). Un botón deshabilitado es una cortesía, no un
 * límite.
 *
 * ===========================================================================
 * LO QUE CAMBIÓ: INVITAR A UN EQUIPO, NO A UNA PERSONA
 * ===========================================================================
 * Antes era un correo, un selector de rol de una palabra y «Invitar»: para
 * meter a ocho personas había que hacerlo ocho veces, sin decir qué podía hacer
 * cada rol ni dar forma de decirle algo a quien llega. Ahora:
 *
 *   - se PEGAN varios correos juntos (comas, espacios, saltos de línea, «Ana
 *     <ana@x.com>»); se validan al vuelo, se quitan repetidos y se ven como chips,
 *     con los inválidos marcados en rojo para corregirlos;
 *   - el rol se elige viendo qué puede hacer cada uno, en una frase;
 *   - opcionalmente, un cargo, un equipo y un mensaje personal que sale en el
 *     correo (se guardan atados a la invitación y se aplican al aceptar);
 *   - el resultado es POR correo: «enviada», «ya es miembro», «sin cupo». Si 3 de
 *     5 salen y 2 no caben, se dice cuáles — y los que fallaron se quedan en el
 *     campo para reintentar.
 *
 * `seatsMaximum` es null en todos los planes de pago desde la 0086 — Cortex se
 * cobra por persona y limitar cuántas entran es rechazar plata. En un plan de
 * pago esto dice la otra verdad: qué trae cada persona y qué suma al mes. Quien
 * está por escribir una dirección es quien debe saber la tarifa.
 */

interface TeamOption {
  id: string;
  name: string;
}

interface Chip {
  email: string;
  valid: boolean;
}

const STATUS_STYLE: Record<InviteStatus, string> = {
  sent: 'bg-emerald-soft text-emerald',
  already_member: 'bg-sky-soft text-sky',
  already_invited: 'bg-sky-soft text-sky',
  no_seats: 'bg-amber-soft text-amber',
  invalid: 'bg-rose-soft text-rose',
  failed: 'bg-rose-soft text-rose',
};

const MESSAGE_MAX = 600;

export function InviteTeam({
  seatsUsed,
  seatsMaximum,
  perSeatAnswers,
  priceCopPerSeat,
  canInvite,
  isOwner = false,
  stepUp,
}: {
  seatsUsed: number;
  seatsMaximum: number | null;
  perSeatAnswers: number | null;
  priceCopPerSeat: number;
  canInvite: boolean;
  /** Fundador: puede invitar directo como cofundador. */
  isOwner?: boolean;
  /** Qué factor pide confirmar que eres tú (sólo cuenta para cofundador). */
  stepUp?: { requirement: StepUpRequirement };
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  const [draft, setDraft] = useState('');
  const [role, setRole] = useState<'member' | 'admin' | 'owner'>('member');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [factor, setFactor] = useState<StepUpRequirement | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [sentRole, setSentRole] = useState<'member' | 'admin' | 'owner'>('member');
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState('');
  const [teamId, setTeamId] = useState('');
  const [message, setMessage] = useState('');
  const [teams, setTeams] = useState<TeamOption[] | null>(null);
  const [state, setState] = useState<'idle' | 'sending'>('idle');
  const [results, setResults] = useState<InviteEmailResult[]>([]);
  const [sentTotal, setSentTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const validChips = chips.filter((chip) => chip.valid);
  const invalidChips = chips.length - validChips.length;
  const seatsLeft =
    seatsMaximum === null ? null : Math.max(0, seatsMaximum - seatsUsed - sentTotal);
  const overSeats = seatsLeft !== null && validChips.length > seatsLeft;
  const tooMany = validChips.length > MAX_INVITES_PER_REQUEST;

  /** Pasa lo escrito o pegado a chips: válidos al frente, inválidos en rojo, sin repetir. */
  function commit(raw: string) {
    const parsed = parseEmailList(raw);
    if (parsed.valid.length === 0 && parsed.invalid.length === 0) return;
    setChips((prev) => {
      const known = new Set(prev.map((chip) => chip.email));
      const next = [...prev];
      for (const email of parsed.valid) {
        if (!known.has(email)) {
          known.add(email);
          next.push({ email, valid: true });
        }
      }
      for (const bad of parsed.invalid) {
        if (!known.has(bad)) {
          known.add(bad);
          next.push({ email: bad, valid: false });
        }
      }
      return next;
    });
  }

  function onDraftChange(value: string) {
    // Un separador cierra el correo que se venía escribiendo.
    if (/[\s,;]/.test(value)) {
      commit(value);
      setDraft('');
      return;
    }
    setDraft(value);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && draft.trim()) {
      e.preventDefault();
      commit(draft);
      setDraft('');
    } else if (e.key === 'Backspace' && !draft && chips.length > 0) {
      setChips((prev) => prev.slice(0, -1));
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    commit(`${draft} ${text}`);
    setDraft('');
  }

  async function openOptions() {
    setOpen((value) => !value);
    if (teams !== null) return;
    try {
      const res = await fetch('/api/team/invitations');
      const data = (await res.json().catch(() => ({}))) as { teams?: TeamOption[] };
      setTeams(data.teams ?? []);
    } catch {
      setTeams([]);
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    const pending = draft.trim();
    const all = pending
      ? [...chips, ...parseEmailList(pending).valid.map((email) => ({ email, valid: true }))]
      : chips;
    const emails = all.filter((chip) => chip.valid).map((chip) => chip.email);
    if (emails.length === 0) return;
    setState('sending');
    setErr(null);
    setResults([]);
    try {
      const res = await fetch('/api/team/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emails,
          role,
          message: message.trim() || undefined,
          position: position.trim() || undefined,
          teamId: teamId || undefined,
          password: role === 'owner' && activeFactor === 'password' ? password : undefined,
          code: role === 'owner' && activeFactor === 'totp' ? code : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        requirement?: StepUpRequirement;
        results?: InviteEmailResult[];
      };
      const outcome = data.results;
      if (!res.ok || !outcome) {
        // El servidor puede pedir otro factor del que se pintó; se muestra ése.
        if (data.requirement) setFactor(data.requirement);
        setErr(data.error ?? 'No se pudo enviar las invitaciones.');
        return;
      }
      setResults(outcome);
      setSentRole(role);
      setPassword('');
      setCode('');
      if (role === 'owner') setRole('member');
      const done = new Set(
        outcome
          .filter(
            (r) =>
              r.status === 'sent' ||
              r.status === 'already_member' ||
              r.status === 'already_invited',
          )
          .map((r) => r.email),
      );
      setSentTotal((n) => n + outcome.filter((r) => r.status === 'sent').length);
      // Lo que salió deja el campo; lo que falló se queda para reintentar.
      setChips((prev) => prev.filter((chip) => !done.has(chip.email)));
      setDraft('');
      if (done.size > 0) startTransition(() => router.refresh());
    } catch {
      setErr('No se pudieron enviar las invitaciones. Revisa tu conexión.');
    } finally {
      setState('idle');
    }
  }

  if (!canInvite) {
    return (
      <p className="text-xs text-ink-muted">
        Quien administra el espacio es quien invita. Pídele a esa persona que te agregue a alguien.
      </p>
    );
  }

  const total = validChips.length + (looksLikeEmail(draft.trim()) ? 1 : 0);
  const full = seatsLeft === 0;
  const roleOptions = isOwner ? [...INVITABLE_ROLES, COFOUNDER_ROLE] : INVITABLE_ROLES;
  const activeFactor = factor ?? stepUp?.requirement ?? 'password';
  const cofounder = role === 'owner';
  const cofounderBlocked =
    cofounder &&
    (total !== 1 ||
      activeFactor === 'sign_in_again' ||
      (activeFactor === 'password' && !password) ||
      (activeFactor === 'totp' && !/^\d{6}$/.test(code.replace(/\s+/g, ''))));

  return (
    <form onSubmit={invite} className="space-y-4">
      <div>
        <label htmlFor="invite-emails" className="field-label mb-1 block">
          Correos
        </label>
        {/* El contenedor hace de campo: enfocar cualquier parte lleva al input. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: el input interior es el elemento enfocable; esto sólo amplía el área de clic. */}
        <div
          onClick={() => inputRef.current?.focus()}
          className="flex min-h-[46px] cursor-text flex-wrap items-center gap-1.5 rounded-sm border border-border-strong bg-surface px-2.5 py-2 transition-colors focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/15"
        >
          {chips.map((chip) => (
            <span
              key={chip.email}
              title={chip.valid ? undefined : 'No parece un correo. Quítalo o corrígelo.'}
              className={`inline-flex max-w-full items-center gap-1 rounded-pill py-0.5 pl-2.5 pr-1 text-xs ${
                chip.valid ? 'bg-primary-soft text-ink' : 'bg-rose-soft text-rose'
              }`}
            >
              <span className="truncate font-mono">{chip.email}</span>
              <button
                type="button"
                aria-label={`Quitar ${chip.email}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setChips((prev) => prev.filter((c) => c.email !== chip.email));
                }}
                className="grid h-4 w-4 place-items-center rounded-pill hover:bg-surface/70"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ))}
          <input
            id="invite-emails"
            ref={inputRef}
            type="text"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => {
              if (draft.trim()) {
                commit(draft);
                setDraft('');
              }
            }}
            placeholder={chips.length === 0 ? 'ana@empresa.com, luis@empresa.com…' : ''}
            className="min-w-[160px] flex-1 bg-transparent py-0.5 font-mono text-sm text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
        <p className="mt-1.5 text-micro text-ink-faint">
          Pega varios a la vez, separados por coma, espacio o salto de línea. Hasta{' '}
          {MAX_INVITES_PER_REQUEST} por vez.
        </p>
        {invalidChips > 0 && (
          <p className="mt-1 text-xs text-rose">
            {invalidChips === 1
              ? 'Hay un texto que no parece un correo'
              : `Hay ${invalidChips} textos que no parecen un correo`}
            : quítalos o corrígelos (en rojo).
          </p>
        )}
      </div>

      <fieldset>
        <legend className="field-label mb-1.5">Rol</legend>
        <div className={`grid gap-2 ${isOwner ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
          {roleOptions.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-start gap-2.5 rounded-sm border px-3 py-2.5 transition-colors ${
                role === option.value
                  ? 'border-primary bg-primary-soft'
                  : 'border-border bg-surface hover:bg-surface-2'
              }`}
            >
              <input
                type="radio"
                name="invite-role"
                value={option.value}
                checked={role === option.value}
                onChange={() => setRole(option.value)}
                className="mt-0.5 accent-[var(--color-primary,#4f46e5)]"
              />
              <span>
                <span className="block text-sm font-semibold text-ink">{option.label}</span>
                <span className="mt-0.5 block text-xs leading-snug text-ink-muted">
                  {option.blurb}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {cofounder && (
        <div className="space-y-3 rounded-sm border border-amber/40 bg-amber-soft p-3.5">
          <p className="flex items-start gap-2 text-xs leading-relaxed text-ink">
            <Crown className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
            <span>
              Quien acepte entra como <strong>dueño de la empresa</strong>: ve y cambia todo, maneja
              el plan y los pagos, nombra o retira cofundadores y puede borrar la empresa. Invita de
              a una persona, y sólo a alguien de total confianza. Los demás fundadores reciben un
              aviso.
            </span>
          </p>
          {total > 1 && (
            <p className="text-xs font-semibold text-rose">
              Para cofundador, deja un solo correo en el campo.
            </p>
          )}
          <div>
            <p className="mb-1.5 text-xs text-ink-muted">{STEP_UP_COPY[activeFactor]}</p>
            {activeFactor === 'password' && (
              <Input
                type="password"
                autoComplete="current-password"
                aria-label="Tu contraseña"
                placeholder="Tu contraseña"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
            {activeFactor === 'totp' && (
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="Código de 6 dígitos"
                placeholder="123 456"
                maxLength={7}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="tabular max-w-[160px]"
              />
            )}
          </div>
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={openOptions}
          aria-expanded={open}
          className="text-xs font-semibold text-primary hover:underline"
        >
          {open ? 'Ocultar cargo, equipo y mensaje' : 'Agregar cargo, equipo y mensaje (opcional)'}
        </button>
        {open && (
          <div className="mt-3 space-y-3 rounded-sm border border-border bg-surface-2 p-3.5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="invite-position" className="field-label mb-1 block">
                  Cargo
                </label>
                <Input
                  id="invite-position"
                  type="text"
                  maxLength={80}
                  placeholder="Analista de cartera"
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="invite-team" className="field-label mb-1 block">
                  Equipo
                </label>
                <select
                  id="invite-team"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                  className="h-[42px] w-full rounded-sm border border-border-strong bg-surface px-3 text-sm text-ink"
                >
                  <option value="">Sin equipo todavía</option>
                  {(teams ?? []).map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
                {teams !== null && teams.length === 0 && (
                  <span className="mt-1 block text-micro text-ink-faint">
                    Aún no hay equipos; se crean en Equipos.
                  </span>
                )}
              </div>
            </div>
            <div>
              <label htmlFor="invite-message" className="field-label mb-1 block">
                Mensaje personal
              </label>
              <textarea
                id="invite-message"
                rows={3}
                maxLength={MESSAGE_MAX}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Bienvenida al equipo. Empiezas con la cartera; cualquier duda me escribes."
                className="w-full resize-y rounded-sm border border-border-strong bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/15"
              />
              <span className="tabular mt-1 block text-right text-micro text-ink-faint">
                {message.length}/{MESSAGE_MAX}
              </span>
            </div>
            <p className="text-micro text-ink-faint">
              El mensaje sale en el correo y en la página de la invitación. El cargo y el equipo se
              ponen cuando la persona acepta.
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={
            state === 'sending' ||
            total === 0 ||
            full ||
            tooMany ||
            invalidChips > 0 ||
            cofounderBlocked
          }
          className="py-2"
        >
          {state === 'sending'
            ? 'Enviando…'
            : cofounder
              ? 'Invitar como cofundador'
              : total > 1
                ? `Enviar ${total} invitaciones`
                : 'Enviar invitación'}
        </Button>
        {overSeats && seatsLeft !== null && (
          <span className="text-xs text-amber">
            A tu plan le caben {count(seatsLeft)} más; las que no quepan saldrán como «sin cupo».
          </span>
        )}
        {tooMany && (
          <span className="text-xs text-rose">
            Son más de {MAX_INVITES_PER_REQUEST}: envía primero estas y luego las demás.
          </span>
        )}
      </div>

      <p className="text-xs text-ink-faint">
        {seatsMaximum === null ? (
          <>
            <span className="tabular">{count(seatsUsed)}</span> personas en el espacio. Cada una
            entra con su asistente
            {perSeatAnswers !== null && (
              <>
                {' '}
                y con <span className="tabular">{count(perSeatAnswers)}</span> respuestas al mes
              </>
            )}
            {priceCopPerSeat > 0 && (
              <>
                , y suma <span className="tabular">{cop(priceCopPerSeat)}</span> al mes
              </>
            )}
            .
          </>
        ) : (
          <>
            <span className="tabular">{count(seatsUsed)}</span> de{' '}
            <span className="tabular">{count(seatsMaximum)}</span> personas de tu plan.
          </>
        )}{' '}
        El enlace de cada invitación dura {INVITATION_TTL_DAYS} días.
      </p>

      {results.length > 0 && (
        <ul className="divide-y divide-border rounded-sm border border-border" aria-live="polite">
          {results.map((result) => (
            <li
              key={`${result.email}-${result.status}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-ink">{result.email}</span>
              <span
                className={`rounded-pill px-2 py-0.5 text-micro font-semibold ${STATUS_STYLE[result.status]}`}
              >
                {STATUS_LABEL[result.status]}
              </span>
              {result.status !== 'sent' && (
                <span className="basis-full text-ink-muted">{result.message}</span>
              )}
              {result.status === 'sent' && result.id && (
                <InviteLink
                  id={result.id}
                  roleLabel={invitationRoleLabel(sentRole)}
                  copied={copied === result.id}
                  onCopied={() => {
                    setCopied(result.id ?? null);
                    setTimeout(() => setCopied(null), 2500);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {err && <p className="text-xs leading-relaxed text-rose">{err}</p>}
    </form>
  );
}

/**
 * El enlace de una invitación a la vista, para mandarlo por donde la persona sí
 * mira (WhatsApp, un chat) y no depender de que el correo llegue. Es el mismo
 * enlace del correo: nominal, vence y sólo lo acepta la cuenta de ese correo.
 */
export function InviteLink({
  id,
  roleLabel,
  copied,
  onCopied,
}: {
  id: string;
  roleLabel: string;
  copied: boolean;
  onCopied: () => void;
}) {
  const link =
    typeof window === 'undefined'
      ? `/accept-invitation/${id}`
      : `${window.location.origin}/accept-invitation/${id}`;
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(
    `Te invité a Cortex como ${roleLabel.toLowerCase()}. Entra con este enlace: ${link}`,
  )}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      onCopied();
    } catch {
      // Sin permiso de portapapeles: el campo queda seleccionado para copiarlo a mano.
      (document.getElementById(`invite-link-${id}`) as HTMLInputElement | null)?.select();
    }
  }

  return (
    <div className="flex basis-full flex-wrap items-center gap-1.5">
      <input
        id={`invite-link-${id}`}
        readOnly
        value={link}
        aria-label="Enlace de la invitación"
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 rounded-sm border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-micro text-ink-muted outline-none focus:border-primary"
      />
      <Button
        type="button"
        variant="outline"
        className="gap-1.5 px-2.5 py-1 text-micro"
        onClick={copy}
      >
        {copied ? (
          <Check className="h-3 w-3 text-emerald" aria-hidden />
        ) : (
          <Copy className="h-3 w-3" aria-hidden />
        )}
        {copied ? 'Copiado' : 'Copiar'}
      </Button>
      <a
        href={whatsapp}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-8 items-center gap-1.5 rounded-pill px-2.5 py-1 text-micro font-bold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <MessageCircle className="h-3 w-3" aria-hidden />
        WhatsApp
      </a>
    </div>
  );
}
