'use client';

import { removeMemberAction, setMemberAction } from '@/lib/apps/actions';
import { clsx } from 'clsx';
import { Plus, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  type AppEditorData,
  BTN_DANGER,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  type EditorMember,
  ErrorLine,
  INPUT,
} from './shared';

/**
 * «Miembros»: quién entra a la app y con qué rol.
 *
 * Los atributos (`cliente = Andina`) son lo que usan los roles que filtran
 * filas «donde Cliente = su cliente». Quien es owner o admin de la empresa
 * entra siempre como administrador, esté o no en esta lista.
 */

const ATTR_KEY = /^[a-z][a-z0-9_]{0,39}$/;

type Run = (task: () => Promise<{ ok: boolean; error?: string }>) => void;

function MemberRow({
  appId,
  member,
  roles,
  busy,
  run,
}: {
  appId: string;
  member: EditorMember;
  roles: AppEditorData['roles'];
  busy: boolean;
  run: Run;
}) {
  const [rows, setRows] = useState(Object.entries(member.attributes).map(([k, v]) => ({ k, v })));
  const draft = Object.fromEntries(
    rows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v.trim()]),
  );
  const changed = JSON.stringify(draft) !== JSON.stringify(member.attributes);
  const badKey = rows.some((r) => r.k.trim() && !ATTR_KEY.test(r.k.trim()));
  const roleKnown = roles.some((r) => r.key === member.roleKey);

  return (
    <li className="space-y-3 rounded-card border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <p className="truncate text-sm font-semibold text-ink">{member.name}</p>
          <p className="truncate text-micro text-ink-muted">{member.email}</p>
        </div>
        <select
          value={member.roleKey}
          disabled={busy}
          aria-label={`Rol de ${member.name}`}
          onChange={(e) =>
            run(() =>
              setMemberAction(appId, {
                userId: member.userId,
                roleKey: e.target.value,
                attributes: member.attributes,
              }),
            )
          }
          className={INPUT}
        >
          {!roleKnown && <option value={member.roleKey}>{member.roleKey} (ya no existe)</option>}
          {roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`¿Quitar a ${member.name} de la aplicación?`))
              run(() => removeMemberAction(appId, member.userId));
          }}
          className={BTN_DANGER}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Quitar
        </button>
      </div>

      <div className="space-y-1.5">
        <p className="text-micro font-semibold text-ink-muted">Atributos</p>
        {rows.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: filas locales sin id propio
          <div key={i} className="flex flex-wrap items-center gap-2">
            <input
              value={r.k}
              onChange={(e) =>
                setRows(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))
              }
              placeholder="atributo (ej. cliente)"
              aria-label="Nombre del atributo"
              className={clsx(INPUT, 'w-40')}
            />
            <span className="text-ink-faint">=</span>
            <input
              value={r.v}
              onChange={(e) =>
                setRows(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))
              }
              placeholder="valor (ej. Andina)"
              aria-label="Valor del atributo"
              className={clsx(INPUT, 'w-48')}
            />
            <button
              type="button"
              aria-label="Quitar atributo"
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
              className="grid h-7 w-7 place-items-center rounded-pill text-ink-faint hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setRows([...rows, { k: '', v: '' }])}
            className={BTN_SECONDARY}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Atributo
          </button>
          {changed && (
            <button
              type="button"
              disabled={busy || badKey}
              onClick={() =>
                run(() =>
                  setMemberAction(appId, {
                    userId: member.userId,
                    roleKey: member.roleKey,
                    attributes: draft,
                  }),
                )
              }
              className={BTN_PRIMARY}
            >
              Guardar atributos
            </button>
          )}
          {badKey && (
            <span className="text-micro text-rose">
              El nombre va en minúsculas, sin espacios ni tildes (a–z, 0–9, _).
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

export function MembersTab({ data }: { data: AppEditorData }) {
  const { app, members, roles, directory } = data;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const [roleKey, setRoleKey] = useState(roles[0]?.key ?? '');
  const free = directory.filter((p) => !members.some((m) => m.userId === p.id));

  const run: Run = (task) => {
    setError(null);
    start(async () => {
      const res = await task();
      if (!res.ok) return setError(res.error ?? 'No se pudo.');
      router.refresh();
    });
  };

  return (
    <div className="space-y-5">
      <p className="max-w-2xl text-xs leading-relaxed text-ink-muted">
        Los dueños y administradores de la empresa siempre entran como administrador: ven todo y no
        se les puede recortar. Aquí asignas el rol de las demás personas del espacio.
      </p>
      <ErrorLine error={error} />

      {roles.length === 0 && (
        <p className="rounded-card bg-amber-soft px-3 py-2 text-xs text-amber">
          Crea primero al menos un rol en «Roles y permisos» para poder asignarlo.
        </p>
      )}

      {members.length === 0 ? (
        <p className="rounded-card border border-dashed border-border-strong bg-surface/40 p-6 text-center text-sm text-ink-muted">
          Nadie más está en esta aplicación todavía.
        </p>
      ) : (
        <ul className="space-y-2">
          {members.map((m) => (
            <MemberRow
              key={`${m.userId}:${m.roleKey}:${JSON.stringify(m.attributes)}`}
              appId={app.id}
              member={m}
              roles={roles}
              busy={pending}
              run={run}
            />
          ))}
        </ul>
      )}

      <form
        className={clsx(CARD, 'space-y-3')}
        onSubmit={(e) => {
          e.preventDefault();
          if (userId && roleKey) {
            run(() => setMemberAction(app.id, { userId, roleKey }));
            setUserId('');
          }
        }}
      >
        <h3 className="text-sm font-semibold text-ink">Agregar miembro</h3>
        {free.length === 0 ? (
          <p className="text-xs text-ink-muted">Todas las personas del espacio ya están.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 basis-56">
              <span className="mb-1 block text-micro font-semibold text-ink-muted">Persona</span>
              <select
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                className={clsx(INPUT, 'w-full')}
              >
                <option value="">Elige a alguien…</option>
                {free.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.email}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-micro font-semibold text-ink-muted">Rol</span>
              <select
                value={roleKey}
                onChange={(e) => setRoleKey(e.target.value)}
                className={INPUT}
              >
                {roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={pending || !userId || !roleKey} className={BTN_PRIMARY}>
              <Plus className="h-3.5 w-3.5" aria-hidden /> Agregar
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
