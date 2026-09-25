'use client';

/**
 * La gente de todas las empresas del fundador, y lo que puede hacer con ella.
 *
 * ===========================================================================
 * UNA FILA POR PERSONA, UNA LÍNEA POR EMPRESA
 * ===========================================================================
 * Quien trabaja en dos empresas del mismo fundador aparece una vez, con sus dos
 * membresías debajo. Así un cambio se hace donde se ve a quién afecta: el rol
 * se cambia por empresa (es un permiso de ESA empresa), y retirar a alguien de
 * una no le toca las otras.
 *
 * Todo lo que cambia algo es una acción de servidor de app/(app)/overview/
 * actions.ts, que vuelve a comprobar la propiedad de cada empresa y aplica las
 * reglas de lib/founder-rules.ts. Este componente no decide nada: oculta lo que
 * no se va a poder hacer (el propio rol, un fundador único) para no ofrecer un
 * botón que va a fallar, y pinta lo que contesta el servidor.
 *
 * Con una sola empresa (la ficha de /overview/companies/[id]) se esconden el
 * selector de empresas y el filtro: sobran.
 */

import {
  cancelFounderInvitationAction,
  changeFounderMemberRoleAction,
  inviteAcrossCompaniesAction,
  removeFounderMemberAction,
} from '@/app/(app)/overview/actions';
import { RemoveMemberDialog } from '@/components/team/RemoveMemberDialog';
import { Button } from '@/components/ui/button';
import {
  type FounderPerson,
  type PerCompanyResult,
  type PersonMembership,
  summarizeResults,
} from '@/lib/founder-rules';
import { chipClass } from '@/lib/status-chip';
import type { CompanyInvitation } from '@/lib/team/membership-admin';
import type { Role } from '@cortex/core';
import { clsx } from 'clsx';
import { Check, CircleAlert, Loader2, MailPlus, Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

const ROLE_LABEL: Record<Role, string> = {
  org_admin: 'Admin de la empresa',
  team_admin: 'Admin de equipo',
  member: 'Miembro',
};

const FIELD =
  'min-h-9 rounded-sm border border-border bg-surface px-3 text-xs text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-primary/40 focus:ring-4 focus:ring-primary/10 disabled:opacity-60';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('es-CO', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function hoursLeft(iso: string) {
  const hours = Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000);
  if (hours <= 0) return 'vencida';
  return hours < 48 ? `vence en ${hours} h` : `vence en ${Math.round(hours / 24)} d`;
}

/* ---------------------------------------------------------------------------
 * Invitar
 * ------------------------------------------------------------------------- */

function InvitePanel({ companies }: { companies: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const single = companies.length === 1;
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [selected, setSelected] = useState<string[]>(single ? [companies[0]?.id ?? ''] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<PerCompanyResult[] | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const response = await inviteAcrossCompaniesAction({
        email,
        role,
        organizationIds: selected,
      });
      if (response.message) setError(response.message);
      setResults(response.results.length > 0 ? response.results : null);
      if (response.results.some((result) => result.ok)) {
        if (response.ok) setEmail('');
        router.refresh();
      }
    } catch {
      setError('No se pudo enviar. Revisa tu conexión.');
    } finally {
      setBusy(false);
    }
  }

  const summary = results ? summarizeResults(results) : null;
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );

  return (
    <section
      aria-labelledby="invite-title"
      className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
          <MailPlus className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 id="invite-title" className="text-base font-semibold text-ink">
            Invitar a alguien
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            {single
              ? 'Le llega un enlace que dura 48 horas. Ocupa un asiento mientras está pendiente.'
              : 'Una sola invitación por empresa elegida. Cada una respeta su plan y sus asientos.'}
          </p>
        </div>
      </div>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="invite-email" className="sr-only">
            Correo
          </label>
          <input
            id="invite-email"
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="nombre@empresa.com"
            className={clsx(FIELD, 'min-w-0 flex-1')}
          />
          <label htmlFor="invite-role" className="sr-only">
            Rol
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'member')}
            className={FIELD}
          >
            <option value="member">Miembro</option>
            <option value="admin">Admin de la empresa</option>
          </select>
          <Button
            type="submit"
            disabled={busy || !email.trim() || selected.length === 0}
            className="min-h-9 px-4 py-1.5 text-xs"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            Enviar invitación
          </Button>
        </div>
        {!single && (
          <fieldset>
            <legend className="mb-1.5 text-micro text-ink-faint">Empresas</legend>
            <div className="flex flex-wrap gap-1.5">
              {companies.map((company) => {
                const on = selected.includes(company.id);
                return (
                  <button
                    key={company.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(company.id)}
                    className={clsx(
                      'inline-flex min-h-8 items-center gap-1.5 rounded-pill border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                      on
                        ? 'border-primary/40 bg-primary-soft text-primary-ink'
                        : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink',
                    )}
                  >
                    {on && <Check className="h-3 w-3" aria-hidden />}
                    {company.name}
                  </button>
                );
              })}
              {companies.length > 2 && (
                <button
                  type="button"
                  onClick={() =>
                    setSelected(
                      selected.length === companies.length ? [] : companies.map((c) => c.id),
                    )
                  }
                  className="min-h-8 rounded-pill px-3 text-xs font-semibold text-primary hover:bg-primary-soft"
                >
                  {selected.length === companies.length ? 'Ninguna' : 'Todas'}
                </button>
              )}
            </div>
          </fieldset>
        )}
      </form>
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-sm border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose"
        >
          {error}
        </p>
      )}
      {summary && results && (
        <output className="mt-3 block rounded-sm border border-border bg-surface-2 px-3 py-2.5 text-xs">
          <span className={chipClass(summary.tone)}>{summary.text}</span>
          {(results.length > 1 || !results[0]?.ok) && (
            <ul className="mt-2 space-y-1">
              {results.map((result) => (
                <li key={result.organizationId} className="flex items-start gap-2">
                  {result.ok ? (
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald" aria-hidden />
                  ) : (
                    <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose" aria-hidden />
                  )}
                  <span className="min-w-0 text-ink-muted">
                    <strong className="font-semibold text-ink">{result.organizationName}</strong> ·{' '}
                    {result.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </output>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * Una membresía: rol y salida
 * ------------------------------------------------------------------------- */

function MembershipLine({
  person,
  membership,
  isSelf,
  ownerCount,
  showCompany,
}: {
  person: FounderPerson;
  membership: PersonMembership;
  isSelf: boolean;
  ownerCount: number;
  showCompany: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const label = person.name ?? person.email;
  const owner = membership.role === 'owner';

  async function changeRole(next: Role) {
    setBusy(true);
    setNote(null);
    try {
      const result = await changeFounderMemberRoleAction({
        organizationId: membership.organizationId,
        memberId: membership.memberId,
        role: next,
      });
      setNote({ ok: result.ok, text: result.message });
      startTransition(() => router.refresh());
    } catch {
      setNote({ ok: false, text: 'No se pudo cambiar el rol. Revisa tu conexión.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
      {showCompany && (
        <span className="min-w-0 flex-1 basis-40 truncate text-xs font-semibold text-ink">
          {membership.organizationName}
        </span>
      )}
      <div className="flex items-center gap-2">
        {owner ? (
          <span className={chipClass('primary')}>Fundador</span>
        ) : isSelf ? (
          <span className={chipClass('neutral')}>{ROLE_LABEL[membership.directoryRole]}</span>
        ) : (
          <>
            <label className="sr-only" htmlFor={`role-${membership.memberId}`}>
              Rol de {label} en {membership.organizationName}
            </label>
            <select
              id={`role-${membership.memberId}`}
              value={membership.directoryRole}
              disabled={busy}
              onChange={(event) => void changeRole(event.target.value as Role)}
              className={clsx(FIELD, 'min-h-8 py-0')}
            >
              <option value="member">{ROLE_LABEL.member}</option>
              <option value="team_admin">{ROLE_LABEL.team_admin}</option>
              <option value="org_admin">{ROLE_LABEL.org_admin}</option>
            </select>
          </>
        )}
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-faint" aria-hidden />}
      </div>
      <span className="tabular text-micro text-ink-faint" title={formatDate(membership.joinedAt)}>
        desde {formatDate(membership.joinedAt)}
      </span>
      <span className="ml-auto">
        {isSelf ? (
          <span className="text-micro text-ink-faint">Tú</span>
        ) : owner && ownerCount <= 1 ? (
          <span className="text-micro text-ink-faint" title="La empresa se quedaría sin fundador">
            Único fundador
          </span>
        ) : (
          <RemoveMemberDialog
            personLabel={label}
            companyName={membership.organizationName}
            disabled={busy}
            onConfirm={() =>
              removeFounderMemberAction({
                organizationId: membership.organizationId,
                memberId: membership.memberId,
              })
            }
            onDone={() => startTransition(() => router.refresh())}
          />
        )}
      </span>
      {note && (
        <p
          role={note.ok ? 'status' : 'alert'}
          className={clsx('basis-full text-micro', note.ok ? 'text-emerald' : 'text-rose')}
        >
          {note.text}
        </p>
      )}
    </li>
  );
}

/* ---------------------------------------------------------------------------
 * Invitaciones pendientes
 * ------------------------------------------------------------------------- */

type InvitationView = CompanyInvitation & { organizationName: string };

function InvitationRow({
  invitation,
  showCompany,
}: { invitation: InvitationView; showCompany: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const result = await cancelFounderInvitationAction({
        organizationId: invitation.organizationId,
        invitationId: invitation.id,
      });
      if (!result.ok) setError(result.message);
      startTransition(() => router.refresh());
    } catch {
      setError('No se pudo cancelar. Revisa tu conexión.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 sm:px-5">
      <span className="min-w-0 flex-1 basis-48">
        <span className="tabular block truncate text-xs font-semibold text-ink">
          {invitation.email}
        </span>
        <span className="block text-micro text-ink-faint">
          {showCompany ? `${invitation.organizationName} · ` : ''}
          {invitation.role === 'admin' ? 'Admin de la empresa' : 'Miembro'}
        </span>
      </span>
      <span
        suppressHydrationWarning
        className={chipClass(invitation.expired ? 'amber' : 'neutral')}
        title={formatDate(invitation.expiresAt)}
      >
        {invitation.expired ? 'Vencida' : hoursLeft(invitation.expiresAt)}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={cancel}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-pill px-2.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <X className="h-3.5 w-3.5" aria-hidden />
        )}
        Cancelar
      </button>
      {error && (
        <p role="alert" className="basis-full text-micro text-rose">
          {error}
        </p>
      )}
    </li>
  );
}

/* ---------------------------------------------------------------------------
 * La vista
 * ------------------------------------------------------------------------- */

export function FounderPeople({
  actorAccountId,
  companies,
  people,
  ownerCounts,
  invitations,
}: {
  actorAccountId: string;
  companies: Array<{ id: string; name: string }>;
  people: FounderPerson[];
  ownerCounts: Record<string, number>;
  invitations: InvitationView[];
}) {
  const single = companies.length === 1;
  const [query, setQuery] = useState('');
  const [company, setCompany] = useState<string>('all');

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('es');
    return people
      .map((person) => ({
        ...person,
        memberships:
          company === 'all'
            ? person.memberships
            : person.memberships.filter((m) => m.organizationId === company),
      }))
      .filter(
        (person) =>
          person.memberships.length > 0 &&
          (!needle ||
            person.email.toLocaleLowerCase('es').includes(needle) ||
            (person.name ?? '').toLocaleLowerCase('es').includes(needle)),
      );
  }, [people, query, company]);

  const pending = invitations.filter(
    (invitation) => company === 'all' || invitation.organizationId === company,
  );

  return (
    <div className="space-y-6">
      <InvitePanel companies={companies} />

      <section
        aria-labelledby="people-title"
        className="overflow-hidden rounded-card border border-border bg-surface shadow-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
          <h2 id="people-title" className="text-base font-semibold text-ink">
            Equipo{' '}
            <span className="tabular text-sm font-normal text-ink-faint">· {visible.length}</span>
          </h2>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
                aria-hidden
              />
              <label htmlFor="people-search" className="sr-only">
                Buscar persona
              </label>
              <input
                id="people-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar por nombre o correo"
                className={clsx(FIELD, 'w-full pl-8')}
              />
            </div>
            {!single && (
              <>
                <label htmlFor="people-company" className="sr-only">
                  Empresa
                </label>
                <select
                  id="people-company"
                  value={company}
                  onChange={(event) => setCompany(event.target.value)}
                  className={FIELD}
                >
                  <option value="all">Todas las empresas</option>
                  {companies.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        </div>
        {visible.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-ink-muted">
            {query
              ? 'Nadie coincide con esa búsqueda.'
              : 'Todavía no hay nadie más en tus empresas.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((person) => {
              const isSelf = person.accountId === actorAccountId;
              return (
                <li
                  key={person.accountId}
                  className="grid gap-x-6 gap-y-1 px-4 py-3 sm:px-5 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]"
                >
                  <div className="min-w-0 pt-2">
                    <p className="truncate text-sm font-semibold text-ink">
                      {person.name ?? person.email}
                      {isSelf && (
                        <span className="ml-1.5 text-micro font-normal text-ink-faint">(tú)</span>
                      )}
                    </p>
                    {person.name && (
                      <p className="tabular truncate text-micro text-ink-faint">{person.email}</p>
                    )}
                  </div>
                  <ul className="min-w-0 divide-y divide-border/60">
                    {person.memberships.map((membership) => (
                      <MembershipLine
                        key={membership.memberId}
                        person={person}
                        membership={membership}
                        isSelf={isSelf}
                        ownerCount={ownerCounts[membership.organizationId] ?? 0}
                        showCompany={!single}
                      />
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="pending-title"
        className="overflow-hidden rounded-card border border-border bg-surface shadow-card"
      >
        <div className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
          <h2 id="pending-title" className="text-base font-semibold text-ink">
            Invitaciones pendientes
          </h2>
          <span className="tabular text-micro text-ink-faint">{pending.length} en espera</span>
        </div>
        {pending.length === 0 ? (
          <p className="px-4 py-6 text-xs text-ink-muted sm:px-5">
            No hay invitaciones por aceptar.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {pending.map((invitation) => (
              <InvitationRow key={invitation.id} invitation={invitation} showCompany={!single} />
            ))}
          </ul>
        )}
        <p className="border-t border-border px-4 py-2.5 text-micro text-ink-faint sm:px-5">
          Las vencidas siguen ocupando asiento hasta que las canceles.
        </p>
      </section>
    </div>
  );
}
