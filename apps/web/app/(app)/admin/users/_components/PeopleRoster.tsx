'use client';

import { FounderChangeDialog } from '@/components/team/FounderChangeDialog';
import { RemoveMemberDialog } from '@/components/team/RemoveMemberDialog';
import { Input } from '@/components/ui/input';
import { foldText } from '@/lib/founder-rules';
import { ROLES_INFO, type RoleKey } from '@/lib/team/role-matrix';
import type { StepUpRequirement } from '@/lib/team/step-up-rules';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import {
  Crown,
  Flag,
  LogOut,
  MoreHorizontal,
  Repeat,
  Search,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  UserMinus,
  UserRound,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { removeMemberAction } from '../actions';
import {
  leaveCompanyAction,
  promoteToOwnerAction,
  stepDownAction,
  transferOwnershipAction,
} from '../founder-actions';
import { RoleDialog } from './RoleDialog';

/**
 * El listado de personas con búsqueda, filtros y el menú de cada fila.
 *
 * Todo lo que decide un permiso viene YA CALCULADO del servidor en `can`
 * (con las mismas funciones de founder-rules.ts que repiten las acciones):
 * este componente sólo muestra u oculta ítems. Mostrar un ítem no autoriza
 * nada; cada acción vuelve a comprobar en el servidor.
 *
 * Las fechas llegan ya escritas («hace 3h»): calcularlas aquí produciría un
 * texto distinto en el servidor y en el navegador y un aviso de hidratación.
 */

export interface RosterRow {
  /** Fila de `public.users` de esta empresa. */
  id: string;
  name: string | null;
  email: string;
  label: string;
  initials: string;
  role: RoleKey | 'removed';
  directoryRole: 'member' | 'team_admin' | 'org_admin';
  managerId: string | null;
  /** Quiénes NO pueden ser su jefe (él mismo y quienes cerrarían un círculo). */
  blockedManagerIds: string[];
  teams: string[];
  title: string | null;
  lastActiveLabel: string | null;
  lastActiveTitle: string | null;
  calls7d: number;
  flagged30d: number;
  joinedLabel: string;
  self: boolean;
  /** `null` = no se muestra (sólo los fundadores lo ven, y sólo en roles altos). */
  twoFactor: boolean | null;
  can: {
    changeRole: boolean;
    promote: boolean;
    transfer: boolean;
    remove: boolean;
    stepDown: boolean;
    leave: boolean;
  };
}

export interface StepUpView {
  /** Para movimientos de un fundador: qué se pide. */
  requirement: StepUpRequirement;
  hasTwoFactor: boolean;
}

type ActiveDialog = {
  kind: 'role' | 'promote' | 'transfer' | 'step_down' | 'leave' | 'remove';
  row: RosterRow;
} | null;

const FIELD =
  'rounded-sm border border-border-strong bg-surface px-2.5 py-2 text-xs text-ink transition-colors focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/15';

const ITEM =
  'flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2 text-xs text-ink outline-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-40';

type StatusKey = 'active' | 'inactive' | 'removed';
const statusOf = (row: RosterRow): StatusKey =>
  row.role === 'removed' ? 'removed' : row.lastActiveLabel ? 'active' : 'inactive';

export function PeopleRoster({
  rows,
  teamNames,
  companyName,
  windowDays,
  stepUp,
}: {
  rows: RosterRow[];
  teamNames: string[];
  companyName: string;
  windowDays: number;
  stepUp: StepUpView;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<'all' | RoleKey | 'removed'>('all');
  const [team, setTeam] = useState('all');
  const [status, setStatus] = useState<'all' | StatusKey>('all');
  const [active, setActive] = useState<ActiveDialog>(null);

  const filtered = useMemo(() => {
    const needle = foldText(query);
    return rows.filter((row) => {
      if (role !== 'all' && row.role !== role) return false;
      if (team !== 'all' && !row.teams.includes(team)) return false;
      if (status !== 'all' && statusOf(row) !== status) return false;
      if (!needle) return true;
      const haystack = [row.name, row.email, row.title, ...row.teams].filter(Boolean).join(' ');
      return foldText(haystack).includes(needle);
    });
  }, [rows, query, role, team, status]);

  const filtering = query !== '' || role !== 'all' || team !== 'all' || status !== 'all';
  const refresh = () => router.refresh();
  const close = (open: boolean) => {
    if (!open) setActive(null);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="relative min-w-[200px] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Busca por nombre, correo, cargo o equipo"
            aria-label="Buscar personas"
            className="py-2 pl-9 text-xs"
          />
        </div>
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as typeof role)}
          aria-label="Filtrar por rol"
          className={FIELD}
        >
          <option value="all">Todos los roles</option>
          <option value="owner">{ROLES_INFO.owner.label}</option>
          <option value="admin">{ROLES_INFO.admin.label}</option>
          <option value="team_admin">{ROLES_INFO.team_admin.label}</option>
          <option value="member">{ROLES_INFO.member.label}</option>
          <option value="removed">Sin acceso</option>
        </select>
        <select
          value={team}
          onChange={(event) => setTeam(event.target.value)}
          aria-label="Filtrar por equipo"
          className={FIELD}
          disabled={teamNames.length === 0}
        >
          <option value="all">
            {teamNames.length === 0 ? 'Sin equipos' : 'Todos los equipos'}
          </option>
          {teamNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
          aria-label="Filtrar por estado"
          className={FIELD}
        >
          <option value="all">Cualquier estado</option>
          <option value="active">Con actividad</option>
          <option value="inactive">Sin actividad</option>
          <option value="removed">Sin acceso</option>
        </select>
        {filtering && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setRole('all');
              setTeam('all');
              setStatus('all');
            }}
            className="text-xs font-semibold text-primary hover:underline"
          >
            Quitar filtros
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="px-4 py-12 text-center">
          <Users className="mx-auto mb-3 h-6 w-6 text-ink-faint" />
          <p className="text-sm font-semibold text-ink">Nadie coincide con eso</p>
          <p className="mt-1 text-xs text-ink-muted">
            Prueba con otra búsqueda o quita los filtros.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {filtered.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-surface-2/40"
            >
              <Link
                href={`/admin/users/${row.id}`}
                className="group flex min-w-[220px] flex-1 items-center gap-3"
              >
                <span
                  aria-hidden
                  className={clsx(
                    'grid h-9 w-9 shrink-0 place-items-center rounded-pill text-xs font-bold',
                    row.role === 'owner'
                      ? 'bg-primary text-white'
                      : 'bg-primary-soft text-primary-ink',
                  )}
                >
                  {row.initials}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink group-hover:text-primary">
                    {row.label}
                    {row.self && <span className="ml-1.5 text-micro text-ink-faint">(tú)</span>}
                  </span>
                  {row.name && (
                    <span className="tabular block truncate text-micro text-ink-faint">
                      {row.email}
                    </span>
                  )}
                </span>
              </Link>

              <div className="flex min-w-[150px] flex-wrap items-center gap-1.5">
                <RoleChip role={row.role} />
                {row.twoFactor !== null && (
                  <span
                    title={
                      row.twoFactor
                        ? 'Tiene la verificación en dos pasos activa'
                        : 'No ha activado la verificación en dos pasos'
                    }
                    className={clsx(
                      'inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-micro font-semibold',
                      row.twoFactor
                        ? 'border-emerald/30 bg-emerald-soft text-emerald'
                        : 'border-amber/40 bg-amber-soft text-amber',
                    )}
                  >
                    {row.twoFactor ? (
                      <ShieldCheck className="h-3 w-3" aria-hidden />
                    ) : (
                      <ShieldOff className="h-3 w-3" aria-hidden />
                    )}
                    {row.twoFactor ? '2 pasos' : 'Sin 2 pasos'}
                  </span>
                )}
              </div>

              <div className="min-w-[140px] flex-1 text-xs">
                <div className="truncate text-ink">
                  {row.title ?? <span className="text-ink-faint">Sin cargo</span>}
                </div>
                <div className="truncate text-micro text-ink-faint">
                  {row.teams.length > 0 ? row.teams.join(' · ') : 'Sin equipo'}
                </div>
              </div>

              <div className="min-w-[110px] text-xs" title={row.lastActiveTitle ?? undefined}>
                <div className="tabular text-ink-muted">
                  {row.lastActiveLabel ?? (
                    <span className="text-ink-faint">Sin actividad {windowDays}d+</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-micro text-ink-faint">
                  {row.calls7d > 0 && (
                    <span className="tabular">
                      {row.calls7d.toLocaleString('es-CO')} acciones · 7d
                    </span>
                  )}
                  {row.flagged30d > 0 && (
                    <Link
                      href={`/admin/users/${row.id}#security`}
                      className="inline-flex items-center gap-1 font-semibold text-rose hover:underline"
                    >
                      <Flag className="h-3 w-3" aria-hidden />
                      {row.flagged30d}
                    </Link>
                  )}
                </div>
              </div>

              <RowMenu row={row} onPick={(kind) => setActive({ kind, row })} />
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-border px-4 py-2 text-micro text-ink-faint">
        {filtering ? `${filtered.length} de ${rows.length} personas` : `${rows.length} personas`}
      </div>

      {active?.kind === 'role' && (
        <RoleDialog
          key={active.row.id}
          open
          onOpenChange={close}
          personLabel={active.row.label}
          userId={active.row.id}
          currentRole={active.row.directoryRole}
          roleLocked={!active.row.can.changeRole}
          lockedReason={
            active.row.self
              ? 'Tu propio rol lo cambia otro administrador.'
              : active.row.role === 'owner'
                ? 'Un fundador no cambia de rol aquí: para soltar la propiedad usa «Dejar de ser fundador» o pásasela a otra persona.'
                : 'Esta persona ya no tiene acceso.'
          }
          currentManagerId={active.row.managerId}
          managerChoices={rows
            .filter(
              (other) =>
                other.id !== active.row.id &&
                other.role !== 'removed' &&
                !active.row.blockedManagerIds.includes(other.id),
            )
            .map((other) => ({ id: other.id, label: other.label }))}
          onSaved={refresh}
        />
      )}

      {active?.kind === 'promote' && (
        <FounderChangeDialog
          mode="promote"
          open
          onOpenChange={close}
          companyName={companyName}
          personName={active.row.name ?? undefined}
          personEmail={active.row.email}
          requirement={stepUp.requirement}
          hasTwoFactor={stepUp.hasTwoFactor}
          onSubmit={(payload) =>
            promoteToOwnerAction({ ...payload, directoryUserId: active.row.id })
          }
          onDone={refresh}
        />
      )}

      {active?.kind === 'transfer' && (
        <FounderChangeDialog
          mode="transfer"
          open
          onOpenChange={close}
          companyName={companyName}
          personName={active.row.name ?? undefined}
          personEmail={active.row.email}
          requirement={stepUp.requirement}
          hasTwoFactor={stepUp.hasTwoFactor}
          onSubmit={(payload) =>
            transferOwnershipAction({ ...payload, directoryUserId: active.row.id })
          }
          onDone={refresh}
        />
      )}

      {active?.kind === 'step_down' && (
        <FounderChangeDialog
          mode="step_down"
          open
          onOpenChange={close}
          companyName={companyName}
          requirement={stepUp.requirement}
          hasTwoFactor={stepUp.hasTwoFactor}
          onSubmit={(payload) => stepDownAction(payload)}
          onDone={refresh}
        />
      )}

      {active?.kind === 'leave' && (
        <FounderChangeDialog
          mode="leave"
          open
          onOpenChange={close}
          companyName={companyName}
          requirement={active.row.role === 'owner' ? stepUp.requirement : null}
          hasTwoFactor={stepUp.hasTwoFactor}
          onSubmit={(payload) => leaveCompanyAction(payload)}
          // Ya no pertenece a esta empresa: recargar la misma página no sirve.
          onDone={() => window.location.assign('/')}
        />
      )}

      {active?.kind === 'remove' && (
        <RemoveMemberDialog
          hideTrigger
          open
          onOpenChange={close}
          personLabel={active.row.label}
          companyName={companyName}
          onConfirm={removeMemberAction.bind(null, active.row.id)}
          onDone={refresh}
        />
      )}
    </div>
  );
}

function RoleChip({ role }: { role: RosterRow['role'] }) {
  if (role === 'removed') {
    return (
      <span className="rounded-pill border border-rose/30 bg-rose-soft px-2 py-0.5 text-micro font-semibold text-rose">
        Sin acceso
      </span>
    );
  }
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-micro font-semibold',
        ROLES_INFO[role].chip,
      )}
    >
      {role === 'owner' && <Crown className="h-3 w-3" aria-hidden />}
      {ROLES_INFO[role].label}
    </span>
  );
}

function RowMenu({
  row,
  onPick,
}: {
  row: RosterRow;
  onPick: (kind: NonNullable<ActiveDialog>['kind']) => void;
}) {
  const removed = row.role === 'removed';
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label={`Acciones para ${row.label}`}
        className="grid h-8 w-8 place-items-center rounded-pill text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[240px] rounded-card border border-border bg-surface p-1 shadow-pop"
        >
          <Menu.Item asChild className={ITEM}>
            <Link href={`/admin/users/${row.id}`}>
              <UserRound className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
              Ver detalle
            </Link>
          </Menu.Item>
          {!removed && (
            <Menu.Item className={ITEM} onSelect={() => onPick('role')}>
              <SlidersHorizontal className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
              {row.can.changeRole ? 'Cambiar rol o jefe…' : 'Cambiar a quién le responde…'}
            </Menu.Item>
          )}
          {row.can.promote && (
            <Menu.Item className={ITEM} onSelect={() => onPick('promote')}>
              <Crown className="h-3.5 w-3.5 text-primary" aria-hidden />
              Hacer cofundador…
            </Menu.Item>
          )}
          {row.can.transfer && (
            <Menu.Item className={ITEM} onSelect={() => onPick('transfer')}>
              <Repeat className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
              Pasarle la propiedad…
            </Menu.Item>
          )}
          {row.can.stepDown && (
            <Menu.Item className={ITEM} onSelect={() => onPick('step_down')}>
              <Crown className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
              Dejar de ser fundador…
            </Menu.Item>
          )}
          {(row.can.remove || row.can.leave) && <Menu.Separator className="my-1 h-px bg-border" />}
          {row.can.leave && (
            <Menu.Item
              className={clsx(ITEM, 'text-rose data-[highlighted]:bg-rose-soft')}
              onSelect={() => onPick('leave')}
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden />
              Dejar la empresa…
            </Menu.Item>
          )}
          {row.can.remove && (
            <Menu.Item
              className={clsx(ITEM, 'text-rose data-[highlighted]:bg-rose-soft')}
              onSelect={() => onPick('remove')}
            >
              <UserMinus className="h-3.5 w-3.5" aria-hidden />
              Quitar de la empresa…
            </Menu.Item>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
