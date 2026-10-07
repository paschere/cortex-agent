'use client';

import { saveRolesAction, updateScreenAction } from '@/lib/apps/actions';
import type { AppPermissions } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  type AppEditorData,
  BTN_DANGER,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  type EditorRole,
  type EditorTracker,
  ErrorLine,
  INPUT,
  roleKeyOf,
} from './shared';

/**
 * «Roles y permisos»: quién ve y hace qué.
 *
 * Tres cuadros, del más grueso al más fino:
 *   1. los roles (nombre y qué hacen);
 *   2. rol × pantalla: qué pantallas abre cada rol (el cambio se guarda al
 *      marcar; ninguna marcada = la ven todos);
 *   3. rol × tabla: qué filas ve, si crea, si edita, qué campos escribe y qué
 *      botones usa. Una tabla que el rol no tiene configurada es INVISIBLE para
 *      él: es la regla del servidor (negar por defecto), y aquí se dice igual.
 *
 * Los roles y sus permisos se guardan juntos con «Guardar roles»; el
 * administrador de la empresa no aparece: ve todo y no se puede recortar.
 */

type Perm = AppPermissions['tables'][string];
const DEFAULT_PERM: Perm = { read: 'all', create: false, edit: 'none', actions: [] };
const APPROVE = '__approve';
const REJECT = '__reject';
const MAX_ROLES = 8;

const attrOf = (equals: string) => equals.replace(/^\$user\./, '');

/** El resumen en lenguaje simple de lo que un rol hace con una tabla. */
function summary(perm: Perm, tracker: EditorTracker): string {
  const field = (key: string) => tracker.fields.find((f) => f.key === key)?.label ?? key;
  const read =
    perm.read === 'all'
      ? 'Ve todas las filas'
      : perm.read === 'own'
        ? 'Ve sólo lo que registró'
        : `Ve las filas donde «${field(perm.read.field)}» es su ${attrOf(perm.read.equals) || '…'}`;
  const edit =
    perm.edit === 'none' ? 'no edita' : perm.edit === 'own' ? 'edita lo suyo' : 'edita todo';
  return `${read}; ${perm.create ? 'crea' : 'no crea'}; ${edit}.`;
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={clsx(
        'rounded-pill border px-2.5 py-1 text-micro font-semibold transition-colors',
        on
          ? 'border-primary bg-primary-soft text-primary'
          : 'border-border bg-surface text-ink-muted hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function TableCell({
  role,
  tracker,
  onChange,
}: {
  role: EditorRole;
  tracker: EditorTracker;
  onChange: (perm: Perm | null) => void;
}) {
  const perm = role.permissions.tables[tracker.slug];
  const id = `${role.key}-${tracker.slug}`;
  if (!perm)
    return (
      <div className="rounded-lg border border-dashed border-border-strong p-3">
        <p className="text-xs font-semibold text-ink">{role.name}</p>
        <p className="mt-0.5 text-micro text-ink-muted">
          Sin configurar: este rol no ve esta tabla ni sus bloques.
        </p>
        <button
          type="button"
          onClick={() => onChange(DEFAULT_PERM)}
          className={clsx(BTN_SECONDARY, 'mt-2')}
        >
          Darle acceso
        </button>
      </div>
    );

  const mode = typeof perm.read === 'string' ? perm.read : 'field';
  const readField = typeof perm.read === 'string' ? '' : perm.read.field;
  const readAttr = typeof perm.read === 'string' ? '' : attrOf(perm.read.equals);
  const fieldChoices = tracker.fields;
  const buttons = [
    { id: APPROVE, label: 'Aprobar' },
    { id: REJECT, label: 'Rechazar' },
    ...tracker.actions,
  ];
  const set = (patch: Partial<Perm>) => onChange({ ...perm, ...patch });

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-ink">{role.name}</p>
          <p className="mt-0.5 text-micro text-ink-muted">{summary(perm, tracker)}</p>
        </div>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="shrink-0 text-micro font-semibold text-rose hover:underline"
        >
          Quitar acceso
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label>
          <span className="mb-1 block text-micro font-semibold text-ink-muted">Qué filas ve</span>
          <select
            value={mode}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'all' || v === 'own') return set({ read: v });
              const first = fieldChoices[0]?.key ?? '';
              set({ read: { field: first, equals: `$user.${first}` } });
            }}
            className={INPUT}
          >
            <option value="all">Todas</option>
            <option value="own">Sólo lo que registró</option>
            {fieldChoices.length > 0 && (
              <option value="field">Las filas donde un campo = su atributo</option>
            )}
          </select>
        </label>
        {mode === 'field' && (
          <>
            <label>
              <span className="mb-1 block text-micro font-semibold text-ink-muted">Campo</span>
              <select
                value={readField}
                onChange={(e) =>
                  set({ read: { field: e.target.value, equals: `$user.${readAttr}` } })
                }
                className={INPUT}
              >
                {fieldChoices.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-micro font-semibold text-ink-muted">
                Atributo de la persona
              </span>
              <input
                value={readAttr}
                onChange={(e) =>
                  set({
                    read: {
                      field: readField,
                      equals: `$user.${e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')}`,
                    },
                  })
                }
                placeholder="ej. cliente"
                className={clsx(INPUT, 'w-36')}
              />
            </label>
          </>
        )}
        <label className="inline-flex items-center gap-1.5 pb-1.5 text-xs text-ink">
          <input
            type="checkbox"
            checked={perm.create}
            onChange={(e) => set({ create: e.target.checked })}
          />
          Crea
        </label>
        <label>
          <span className="mb-1 block text-micro font-semibold text-ink-muted">Edita</span>
          <select
            value={perm.edit}
            onChange={(e) => set({ edit: e.target.value as Perm['edit'] })}
            className={INPUT}
          >
            <option value="none">No</option>
            <option value="own">Sólo lo suyo</option>
            <option value="all">Todo</option>
          </select>
        </label>
      </div>

      {fieldChoices.length > 0 && (
        <fieldset className="min-w-0">
          <legend className="mb-1 text-micro font-semibold text-ink-muted">
            Campos que escribe{' '}
            <span className="font-normal text-ink-faint">
              (ninguno marcado = todos los del bloque)
            </span>
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {fieldChoices.map((f) => {
              const list = perm.fields ?? [];
              return (
                <Chip
                  key={f.key}
                  on={list.includes(f.key)}
                  onClick={() => {
                    const next = toggle(list, f.key);
                    set({ fields: next.length ? next : undefined });
                  }}
                >
                  {f.label}
                </Chip>
              );
            })}
          </div>
        </fieldset>
      )}

      <fieldset className="min-w-0">
        <legend className="mb-1 text-micro font-semibold text-ink-muted">
          Botones que puede usar
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {buttons.map((b) => (
            <Chip
              key={b.id}
              on={perm.actions.includes(b.id)}
              onClick={() => set({ actions: toggle(perm.actions, b.id) })}
            >
              {b.label}
            </Chip>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

export function RolesTab({ data }: { data: AppEditorData }) {
  const { app, screens, trackers, unknownTrackers } = data;
  const saved = data.roles;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [roles, setRoles] = useState<EditorRole[]>(saved);
  const [newName, setNewName] = useState('');

  const dirty = JSON.stringify(roles) !== JSON.stringify(saved);
  const newKey = roleKeyOf(newName);
  const newInvalid =
    !newName.trim() ||
    newKey === 'administrador' ||
    newKey.length < 2 ||
    roles.some((r) => r.key === newKey) ||
    roles.length >= MAX_ROLES;

  const allTrackers: EditorTracker[] = [
    ...trackers,
    ...unknownTrackers.map((slug) => ({ slug, name: slug, fields: [], actions: [] })),
  ];

  function patchRole(key: string, patch: Partial<EditorRole>) {
    setRoles(roles.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function setPerm(roleKey: string, slug: string, perm: Perm | null) {
    setRoles(
      roles.map((r) => {
        if (r.key !== roleKey) return r;
        const tables = { ...r.permissions.tables };
        if (perm) tables[slug] = perm;
        else delete tables[slug];
        return { ...r, permissions: { ...r.permissions, tables } };
      }),
    );
  }

  function save() {
    setError(null);
    setNotice(null);
    start(async () => {
      const res = await saveRolesAction(
        app.id,
        roles.map((r) => ({
          key: r.key,
          name: r.name,
          description: r.description,
          permissions: r.permissions,
        })),
      );
      if (!res.ok) return setError(res.error);
      setNotice('Roles guardados.');
      router.refresh();
    });
  }

  function toggleScreen(screenId: string, current: string[], roleKey: string) {
    setError(null);
    start(async () => {
      const res = await updateScreenAction(app.id, screenId, { roles: toggle(current, roleKey) });
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <ErrorLine error={error} />
      {notice && (
        <output className="block rounded-card bg-emerald-soft px-3 py-2 text-xs text-emerald">
          {notice}
        </output>
      )}

      {/* 1. Los roles */}
      <section className={clsx(CARD, 'space-y-3')}>
        <h3 className="text-sm font-semibold text-ink">Roles</h3>
        <p className="text-xs leading-relaxed text-ink-muted">
          Quien administra la empresa entra como «administrador» y no necesita rol. Aquí van los
          demás: operario, supervisor, cliente…
        </p>
        {roles.length === 0 && <p className="text-xs text-ink-muted">Todavía no hay roles.</p>}
        <ul className="space-y-2">
          {roles.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center gap-2">
              <input
                value={r.name}
                onChange={(e) => patchRole(r.key, { name: e.target.value })}
                maxLength={60}
                aria-label="Nombre del rol"
                className={clsx(INPUT, 'w-44 font-semibold')}
              />
              <code className="rounded-pill bg-surface-2 px-2 py-0.5 text-micro text-ink-muted">
                {r.key}
              </code>
              <input
                value={r.description}
                onChange={(e) => patchRole(r.key, { description: e.target.value })}
                maxLength={300}
                placeholder="Qué hace este rol"
                aria-label="Descripción del rol"
                className={clsx(INPUT, 'min-w-0 flex-1 basis-56')}
              />
              <label className="inline-flex items-center gap-1.5 text-xs text-ink">
                <input
                  type="checkbox"
                  checked={r.permissions.export}
                  onChange={(e) =>
                    patchRole(r.key, {
                      permissions: { ...r.permissions, export: e.target.checked },
                    })
                  }
                />
                Exporta
              </label>
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      `¿Quitar el rol «${r.name}»? Al guardar, sus miembros quedan fuera de la app hasta que les asignes otro.`,
                    )
                  )
                    setRoles(roles.filter((x) => x.key !== r.key));
                }}
                className={BTN_DANGER}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Quitar
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (newInvalid) return;
            setRoles([
              ...roles,
              {
                key: newKey,
                name: newName.trim(),
                description: '',
                permissions: { tables: {}, export: false },
              },
            ]);
            setNewName('');
          }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={60}
            placeholder="Nombre del rol nuevo"
            aria-label="Nombre del rol nuevo"
            className={clsx(INPUT, 'w-56')}
          />
          <button type="submit" disabled={newInvalid} className={BTN_SECONDARY}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Agregar rol
          </button>
          {newName.trim() && newKey === 'administrador' && (
            <span className="text-micro text-rose">«administrador» está reservado.</span>
          )}
          {roles.length >= MAX_ROLES && (
            <span className="text-micro text-ink-muted">Máximo {MAX_ROLES} roles.</span>
          )}
        </form>
      </section>

      {/* 2. Rol × pantalla */}
      {saved.length > 0 && screens.length > 0 && (
        <section className={clsx(CARD, 'space-y-3')}>
          <h3 className="text-sm font-semibold text-ink">Qué pantallas abre cada rol</h3>
          <p className="text-xs text-ink-muted">
            Se guarda al marcar. Una pantalla sin ningún rol marcado la ven todos los roles.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-xs">
              <thead>
                <tr className="text-micro text-ink-muted">
                  <th className="py-1.5 pr-3 font-semibold">Pantalla</th>
                  {saved.map((r) => (
                    <th key={r.key} className="px-2 py-1.5 text-center font-semibold">
                      {r.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {screens.map((s) => (
                  <tr key={s.id} className="border-t border-border">
                    <td className="py-2 pr-3 font-semibold text-ink">
                      {s.title}
                      {s.roles.length === 0 && (
                        <span className="ml-2 font-normal text-ink-faint">· la ven todos</span>
                      )}
                    </td>
                    {saved.map((r) => (
                      <td key={r.key} className="px-2 py-2 text-center">
                        <input
                          type="checkbox"
                          aria-label={`${r.name} abre ${s.title}`}
                          checked={s.roles.includes(r.key)}
                          disabled={pending}
                          onChange={() => toggleScreen(s.id, s.roles, r.key)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 3. Rol × tabla */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-ink">Qué hace cada rol con las tablas</h3>
        {allTrackers.length === 0 ? (
          <p className="rounded-card border border-dashed border-border-strong bg-surface/40 p-4 text-xs text-ink-muted">
            Ninguna pantalla lee todavía una tabla. Cuando agregues bloques con datos, aparecen
            aquí.
          </p>
        ) : roles.length === 0 ? (
          <p className="text-xs text-ink-muted">Crea un rol arriba para darle permisos.</p>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-ink-muted">
              Una tabla que no configuras para un rol es invisible para él: sus bloques le salen
              como aviso. Dale acceso sólo a lo que necesita.
            </p>
            {allTrackers.map((t) => (
              <div key={t.slug} className={clsx(CARD, 'space-y-3')}>
                <h4 className="text-sm font-semibold text-ink">
                  {t.name}{' '}
                  <code className="ml-1 text-micro font-normal text-ink-faint">{t.slug}</code>
                </h4>
                <div className="grid gap-3 lg:grid-cols-2">
                  {roles.map((r) => (
                    <TableCell
                      key={r.key}
                      role={r}
                      tracker={t}
                      onChange={(perm) => setPerm(r.key, t.slug, perm)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </section>

      <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface/95 p-3 shadow-pop backdrop-blur">
        <button type="button" disabled={pending || !dirty} onClick={save} className={BTN_PRIMARY}>
          Guardar roles
        </button>
        <span className="text-micro text-ink-muted">
          {dirty ? 'Hay cambios sin guardar en los roles.' : 'Los roles están al día.'}
        </span>
        {dirty && (
          <button type="button" onClick={() => setRoles(saved)} className={BTN_SECONDARY}>
            Descartar
          </button>
        )}
      </div>
    </div>
  );
}
