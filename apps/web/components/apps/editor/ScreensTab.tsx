'use client';

import {
  addScreenAction,
  removeScreenAction,
  reorderScreensAction,
  updateAppAction,
  updateScreenAction,
} from '@/lib/apps/actions';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, Check, Pencil, PencilRuler, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  type AppEditorData,
  BTN_DANGER,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  type EditorScreen,
  ErrorLine,
  INPUT,
  SCREEN_ICONS,
  ScreenIcon,
} from './shared';

/**
 * «Pantallas»: lo que la gente abre dentro de la app.
 *
 * Cada pantalla es una vista; aquí se ordena, se renombra, se le pone icono y
 * se decide qué roles la ven (ninguno marcado = la ven todos). Su contenido se
 * cambia con «Editar pantalla», que abre el lienzo de vistas. La primera
 * pantalla que ve cada rol es la «de inicio» si el rol la ve, y si no, la
 * primera de su lista.
 */

function RoleChecks({
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
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {roles.map((r) => (
        <label key={r.key} className="inline-flex items-center gap-1.5 text-xs text-ink">
          <input
            type="checkbox"
            checked={value.includes(r.key)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, r.key] : value.filter((k) => k !== r.key))
            }
          />
          {r.name}
        </label>
      ))}
      <span className="text-micro text-ink-faint">
        {value.length === 0 ? 'Ninguno marcado: la ven todos los roles.' : ''}
      </span>
    </div>
  );
}

function ScreenRow({
  appId,
  screen,
  index,
  total,
  roles,
  busy,
  run,
  move,
}: {
  appId: string;
  screen: EditorScreen;
  index: number;
  total: number;
  roles: AppEditorData['roles'];
  busy: boolean;
  run: (task: () => Promise<{ ok: boolean; error?: string }>) => void;
  move: (dir: -1 | 1) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(screen.title);
  const [icon, setIcon] = useState(screen.icon);
  const [rolesDraft, setRolesDraft] = useState(screen.roles);
  const names = new Map(roles.map((r) => [r.key, r.name]));

  return (
    <li className="rounded-card border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
          <ScreenIcon name={screen.icon} className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <p className="truncate text-sm font-semibold text-ink">{screen.title}</p>
          <p className="mt-0.5 flex flex-wrap gap-1">
            {screen.roles.length === 0 ? (
              <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-micro text-ink-muted">
                Todos los roles
              </span>
            ) : (
              screen.roles.map((k) => (
                <span
                  key={k}
                  className="rounded-pill bg-primary-soft px-2 py-0.5 text-micro font-semibold text-primary"
                >
                  {names.get(k) ?? k}
                </span>
              ))
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-label="Subir"
            disabled={busy || index === 0}
            onClick={() => move(-1)}
            className={BTN_SECONDARY}
          >
            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Bajar"
            disabled={busy || index === total - 1}
            onClick={() => move(1)}
            className={BTN_SECONDARY}
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button type="button" onClick={() => setEditing((v) => !v)} className={BTN_SECONDARY}>
            <Pencil className="h-3.5 w-3.5" aria-hidden /> Datos
          </button>
          <Link href={`/apps/${appId}/edit?pantalla=${screen.id}`} className={BTN_PRIMARY}>
            <PencilRuler className="h-3.5 w-3.5" aria-hidden /> Editar pantalla
          </Link>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`¿Quitar la pantalla «${screen.title}»? Se archiva con su vista.`))
                run(() => removeScreenAction(appId, screen.id));
            }}
            className={BTN_DANGER}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Quitar
          </button>
        </div>
      </div>

      {editing && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <div className="flex flex-wrap gap-2">
            <label className="min-w-0 flex-1 basis-48">
              <span className="mb-1 block text-micro font-semibold text-ink-muted">Título</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={60}
                className={clsx(INPUT, 'w-full')}
              />
            </label>
            <label>
              <span className="mb-1 block text-micro font-semibold text-ink-muted">Icono</span>
              <select value={icon} onChange={(e) => setIcon(e.target.value)} className={INPUT}>
                {SCREEN_ICONS.map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div>
            <span className="mb-1 block text-micro font-semibold text-ink-muted">Quién la ve</span>
            <RoleChecks roles={roles} value={rolesDraft} onChange={setRolesDraft} />
          </div>
          <button
            type="button"
            disabled={busy || !title.trim()}
            onClick={() =>
              run(async () => {
                const res = await updateScreenAction(appId, screen.id, {
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
        </div>
      )}
    </li>
  );
}

export function ScreensTab({ data }: { data: AppEditorData }) {
  const { app, screens, roles } = data;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState(SCREEN_ICONS[0]?.name ?? 'ClipboardPlus');
  const [newRoles, setNewRoles] = useState<string[]>([]);

  function run(task: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const res = await task();
      if (!res.ok) return setError(res.error ?? 'No se pudo.');
      router.refresh();
    });
  }

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
    <div className="space-y-5">
      <ErrorLine error={error} />

      {screens.length === 0 ? (
        <p className="rounded-card border border-dashed border-border-strong bg-surface/40 p-6 text-center text-sm text-ink-muted">
          La aplicación todavía no tiene pantallas. Agrega la primera aquí abajo.
        </p>
      ) : (
        <ul className="space-y-2">
          {screens.map((s, i) => (
            <ScreenRow
              key={`${s.id}:${s.title}:${s.icon}:${s.roles.join(',')}`}
              appId={app.id}
              screen={s}
              index={i}
              total={screens.length}
              roles={roles}
              busy={pending}
              run={run}
              move={(dir) => move(i, dir)}
            />
          ))}
        </ul>
      )}

      {screens.length > 0 && (
        <label className={clsx(CARD, 'flex flex-wrap items-center gap-3')}>
          <span className="text-xs font-semibold text-ink">Pantalla de inicio</span>
          <select
            value={app.homeScreen ?? ''}
            disabled={pending}
            onChange={(e) =>
              run(() => updateAppAction(app.id, { homeScreen: e.target.value || null }))
            }
            className={INPUT}
          >
            <option value="">La primera que vea cada rol</option>
            {screens.map((s) => (
              <option key={s.id} value={s.slug}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
      )}

      <form
        className={clsx(CARD, 'space-y-3')}
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          run(async () => {
            const res = await addScreenAction(app.id, { title, icon, roles: newRoles });
            if (res.ok) {
              setTitle('');
              setNewRoles([]);
            }
            return res;
          });
        }}
      >
        <h3 className="text-sm font-semibold text-ink">Agregar pantalla</h3>
        <div className="flex flex-wrap gap-2">
          <label className="min-w-0 flex-1 basis-48">
            <span className="mb-1 block text-micro font-semibold text-ink-muted">Título</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={60}
              placeholder="Ej. Registrar guía"
              className={clsx(INPUT, 'w-full')}
            />
          </label>
          <label>
            <span className="mb-1 block text-micro font-semibold text-ink-muted">Icono</span>
            <select value={icon} onChange={(e) => setIcon(e.target.value)} className={INPUT}>
              {SCREEN_ICONS.map((i) => (
                <option key={i.name} value={i.name}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <span className="mb-1 block text-micro font-semibold text-ink-muted">Quién la ve</span>
          <RoleChecks roles={roles} value={newRoles} onChange={setNewRoles} />
        </div>
        <button type="submit" disabled={pending || !title.trim()} className={BTN_PRIMARY}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> Agregar pantalla
        </button>
      </form>
    </div>
  );
}
