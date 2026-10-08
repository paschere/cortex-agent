'use client';

import { Glyph } from '@/components/apps/AppGlyph';
import {
  addScreenAction,
  removeScreenAction,
  reorderScreensAction,
  updateAppAction,
  updateScreenAction,
} from '@/lib/apps/actions';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Home,
  MoreHorizontal,
  Pencil,
  PencilRuler,
  Plus,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { IconPicker } from './IconPicker';
import {
  type AppEditorData,
  BTN_PRIMARY,
  BTN_SECONDARY,
  type EditorScreen,
  ErrorLine,
  INPUT,
  MENU_CONTENT,
  MenuItem,
} from './shared';

/**
 * «Pantallas»: lo que la gente abre dentro de la app.
 *
 * Cada pantalla es una vista; aquí se ordena, se renombra, se le pone icono y
 * se decide qué roles la ven (ninguno marcado = la ven todos). Su contenido se
 * cambia con «Editar», que abre el lienzo de vistas. La primera pantalla que
 * ve cada rol es la «de inicio» si el rol la ve, y si no, la primera de su
 * lista.
 */

type Run = (task: () => Promise<{ ok: boolean; error?: string }>) => void;

/** Roles como fichas que se encienden y se apagan (ninguna = la ven todos). */
function RoleChips({
  roles,
  value,
  onChange,
}: {
  roles: AppEditorData['roles'];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  if (!roles.length)
    return <p className="text-micro text-ink-faint">Sin roles todavía: la ven todos.</p>;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {roles.map((r) => {
          const on = value.includes(r.key);
          return (
            <button
              key={r.key}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((k) => k !== r.key) : [...value, r.key])}
              className={clsx(
                'inline-flex h-7 items-center gap-1 rounded-pill border px-3 text-xs font-semibold transition-colors',
                on
                  ? 'border-primary bg-primary-soft text-primary-ink'
                  : 'border-border bg-surface text-ink-muted hover:border-primary/50',
              )}
            >
              {on && <Check className="h-3 w-3" aria-hidden />}
              {r.name}
            </button>
          );
        })}
      </div>
      <p className="text-micro text-ink-faint">
        {value.length === 0
          ? 'Ninguno marcado: la ven todos los roles.'
          : 'Sólo los roles marcados la ven.'}
      </p>
    </div>
  );
}

function IconTile({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  return (
    <span
      className={clsx(
        'grid shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-ink',
        size === 'lg' ? 'h-10 w-10' : 'h-9 w-9',
      )}
    >
      <Glyph name={name} className="h-[18px] w-[18px]" />
    </span>
  );
}

function ScreenRow({
  data,
  screen,
  index,
  busy,
  run,
  move,
}: {
  data: AppEditorData;
  screen: EditorScreen;
  index: number;
  busy: boolean;
  run: Run;
  move: (dir: -1 | 1) => void;
}) {
  const { app, roles, screens } = data;
  const total = screens.length;
  const isHome = app.homeScreen === screen.slug;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(screen.title);
  const [icon, setIcon] = useState(screen.icon);
  const [rolesDraft, setRolesDraft] = useState(screen.roles);
  const names = new Map(roles.map((r) => [r.key, r.name]));
  const editHref = `/apps/${app.id}/edit?pantalla=${screen.id}`;
  const filters = data.screenFilters[screen.slug]?.length ?? 0;
  const summary = [
    screen.viewName && screen.viewName !== screen.title ? `Vista «${screen.viewName}»` : null,
    filters > 0 ? `${filters} ${filters === 1 ? 'filtro' : 'filtros'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className="group rounded-card border border-border bg-surface shadow-card transition-colors hover:border-primary/40">
      <div className="flex items-center gap-1 p-2 sm:p-2.5">
        <Link
          href={editHref}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <IconTile name={screen.icon} size="lg" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-ink">{screen.title}</span>
              {isHome && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-emerald-soft px-2 py-0.5 text-micro font-semibold text-emerald">
                  <Home className="h-3 w-3" aria-hidden /> Inicio
                </span>
              )}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1">
              {screen.roles.length === 0 ? (
                <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-micro text-ink-muted">
                  Todos los roles
                </span>
              ) : (
                screen.roles.map((k) => (
                  <span
                    key={k}
                    className="rounded-pill bg-primary-soft px-2 py-0.5 text-micro font-semibold text-primary-ink"
                  >
                    {names.get(k) ?? k}
                  </span>
                ))
              )}
              {summary && <span className="text-micro text-ink-faint">{summary}</span>}
            </span>
          </span>
        </Link>

        <Link
          href={editHref}
          className="hidden h-8 shrink-0 items-center gap-1.5 rounded-pill px-3 text-xs font-semibold text-ink-muted transition-colors hover:bg-primary-soft hover:text-primary-ink sm:inline-flex"
        >
          <PencilRuler className="h-3.5 w-3.5" aria-hidden /> Editar
        </Link>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={`Acciones de ${screen.title}`}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-pill text-ink-muted outline-none transition-colors hover:bg-surface-2 hover:text-ink data-[state=open]:bg-surface-2 data-[state=open]:text-ink"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT}>
              <DropdownMenu.Item asChild>
                <Link
                  href={editHref}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2 text-xs font-semibold text-ink-muted outline-none data-[highlighted]:bg-primary-soft data-[highlighted]:text-primary-ink"
                >
                  <PencilRuler className="h-3.5 w-3.5" aria-hidden /> Editar pantalla
                </Link>
              </DropdownMenu.Item>
              <MenuItem onSelect={() => setEditing((v) => !v)}>
                <Pencil className="h-3.5 w-3.5" aria-hidden /> Datos (título, icono, roles)
              </MenuItem>
              <MenuItem
                disabled={busy}
                onSelect={() =>
                  run(() => updateAppAction(app.id, { homeScreen: isHome ? null : screen.slug }))
                }
              >
                <Home className="h-3.5 w-3.5" aria-hidden />
                {isHome ? 'Quitar como inicio' : 'Poner como inicio'}
              </MenuItem>
              <MenuItem disabled={busy || index === 0} onSelect={() => move(-1)}>
                <ArrowUp className="h-3.5 w-3.5" aria-hidden /> Subir
              </MenuItem>
              <MenuItem disabled={busy || index === total - 1} onSelect={() => move(1)}>
                <ArrowDown className="h-3.5 w-3.5" aria-hidden /> Bajar
              </MenuItem>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <MenuItem
                tone="rose"
                disabled={busy}
                onSelect={() => {
                  if (
                    window.confirm(
                      `¿Quitar la pantalla «${screen.title}»? Se archiva con su vista.`,
                    )
                  )
                    run(() => removeScreenAction(app.id, screen.id));
                }}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Quitar
              </MenuItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {editing && (
        <div className="space-y-3 border-t border-border bg-surface-2/40 p-3 sm:p-4">
          <div className="flex items-end gap-2">
            <div>
              <span className="mb-1 block text-micro font-semibold text-ink-muted">Icono</span>
              <IconPicker value={icon} onChange={setIcon} label="Cambiar el icono de la pantalla">
                <IconTile name={icon} size="lg" />
              </IconPicker>
            </div>
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-micro font-semibold text-ink-muted">Título</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={60}
                className={clsx(INPUT, 'h-10 w-full')}
              />
            </label>
          </div>
          <div>
            <span className="mb-1.5 block text-micro font-semibold text-ink-muted">
              Quién la ve
            </span>
            <RoleChips roles={roles} value={rolesDraft} onChange={setRolesDraft} />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !title.trim()}
              onClick={() =>
                run(async () => {
                  const res = await updateScreenAction(app.id, screen.id, {
                    title,
                    icon,
                    roles: rolesDraft,
                  });
                  if (res.ok) setEditing(false);
                  return res;
                })
              }
              className={BTN_PRIMARY}
            >
              <Check className="h-3.5 w-3.5" aria-hidden /> Guardar pantalla
            </button>
            <button type="button" onClick={() => setEditing(false)} className={BTN_SECONDARY}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function NewScreen({
  data,
  busy,
  run,
}: {
  data: AppEditorData;
  busy: boolean;
  run: Run;
}) {
  const { app, roles } = data;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState('ClipboardPlus');
  const [newRoles, setNewRoles] = useState<string[]>([]);

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border-strong bg-transparent px-4 py-4 text-sm font-semibold text-ink-muted transition-colors hover:border-primary hover:bg-primary-soft/40 hover:text-primary-ink"
      >
        <Plus className="h-4 w-4" aria-hidden /> Nueva pantalla
      </button>
    );

  return (
    <form
      className="space-y-4 rounded-card border border-primary/40 bg-surface p-4 shadow-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        run(async () => {
          const res = await addScreenAction(app.id, { title, icon, roles: newRoles });
          if (res.ok) {
            setTitle('');
            setNewRoles([]);
            setOpen(false);
          }
          return res;
        });
      }}
    >
      <div>
        <h3 className="text-sm font-semibold text-ink">Nueva pantalla</h3>
        <p className="mt-0.5 text-xs text-ink-muted">
          Ponle un nombre y un icono; después la armas con «Editar».
        </p>
      </div>
      <div className="flex items-end gap-2">
        <div>
          <span className="mb-1 block text-micro font-semibold text-ink-muted">Icono</span>
          <IconPicker value={icon} onChange={setIcon} label="Elegir el icono de la pantalla">
            <IconTile name={icon} size="lg" />
          </IconPicker>
        </div>
        <label className="min-w-0 flex-1">
          <span className="mb-1 block text-micro font-semibold text-ink-muted">Título</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={60}
            placeholder="Ej. Registrar guía"
            className={clsx(INPUT, 'h-10 w-full')}
          />
        </label>
      </div>
      <div>
        <span className="mb-1.5 block text-micro font-semibold text-ink-muted">Quién la ve</span>
        <RoleChips roles={roles} value={newRoles} onChange={setNewRoles} />
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !title.trim()} className={BTN_PRIMARY}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> Agregar pantalla
        </button>
        <button type="button" onClick={() => setOpen(false)} className={BTN_SECONDARY}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

export function ScreensTab({ data }: { data: AppEditorData }) {
  const { app, screens } = data;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run: Run = (task) => {
    setError(null);
    start(async () => {
      const res = await task();
      if (!res.ok) return setError(res.error ?? 'No se pudo.');
      router.refresh();
    });
  };

  function move(index: number, dir: -1 | 1) {
    const ids = screens.map((s) => s.id);
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    const a = ids[index];
    const b = ids[target];
    if (!a || !b) return;
    ids[index] = b;
    ids[target] = a;
    run(() => reorderScreensAction(app.id, ids));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <SlidersHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
        <p className="text-xs text-ink-muted">
          Lo que la gente abre dentro de la app. Toca una pantalla para editarla; en «…» las
          ordenas, eliges cuál es la de inicio o la quitas.
        </p>
      </div>
      <ErrorLine error={error} />

      {screens.length === 0 && (
        <p className="rounded-card border border-dashed border-border-strong bg-surface/40 p-6 text-center text-sm text-ink-muted">
          La aplicación todavía no tiene pantallas. Agrega la primera aquí abajo.
        </p>
      )}
      {screens.length > 0 && (
        <ul className="space-y-2">
          {screens.map((s, i) => (
            <ScreenRow
              key={`${s.id}:${s.title}:${s.icon}:${s.roles.join(',')}:${app.homeScreen ?? ''}`}
              data={data}
              screen={s}
              index={i}
              busy={pending}
              run={run}
              move={(dir) => move(i, dir)}
            />
          ))}
        </ul>
      )}

      <NewScreen data={data} busy={pending} run={run} />
    </div>
  );
}
