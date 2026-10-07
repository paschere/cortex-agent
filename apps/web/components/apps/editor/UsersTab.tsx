'use client';

import {
  importAppUsersAction,
  inviteAppUserAction,
  removeAppUserAction,
  resendAppInvitationAction,
  setAppUserStatusAction,
  updateAppUserAction,
} from '@/lib/apps/user-actions';
import { clsx } from 'clsx';
import { Copy, Mail, Plus, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { KioskPanel, PinControl } from './KioskPanel';
import {
  type AppEditorData,
  BTN_DANGER,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  type EditorAppUser,
  ErrorLine,
  INPUT,
  requiredAttributesOf,
} from './shared';

/**
 * «Usuarios»: la gente de AFUERA que entra a la app (operarios, clientes), sin
 * cuenta de Cortex. Reciben un correo con el enlace /a/<app>, escriben su
 * correo y les llega un código de 6 dígitos. No cuentan como asientos del plan.
 * Desactivar a alguien lo saca en su siguiente petición.
 */

const STATUS: Record<EditorAppUser['status'], { label: string; cls: string }> = {
  invited: { label: 'Invitado', cls: 'bg-amber-soft text-amber' },
  active: { label: 'Activo', cls: 'bg-emerald-soft text-emerald' },
  disabled: { label: 'Desactivado', cls: 'bg-surface-2 text-ink-muted' },
};

function seen(iso: string | null): string {
  if (!iso) return 'Nunca ha entrado';
  return `Último acceso: ${new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  }).format(new Date(iso))}`;
}

type Run = (task: () => Promise<{ ok: boolean; error?: string }>) => void;

function UserRow({
  appId,
  user,
  roles,
  busy,
  run,
  kioskEnabled,
}: {
  appId: string;
  user: EditorAppUser;
  roles: AppEditorData['roles'];
  busy: boolean;
  run: Run;
  kioskEnabled: boolean;
}) {
  const st = STATUS[user.status];
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface p-3">
      <div className="min-w-0 flex-1 basis-48">
        <p className="truncate text-sm font-semibold text-ink">{user.name}</p>
        <p className="truncate text-micro text-ink-muted">{user.email}</p>
        <p className="text-micro text-ink-faint">
          {seen(user.lastSeenAt)}
          {Object.keys(user.attributes).length > 0 &&
            ` · ${Object.entries(user.attributes)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ')}`}
        </p>
      </div>
      <span className={clsx('rounded-pill px-2.5 py-1 text-micro font-semibold', st.cls)}>
        {st.label}
      </span>
      <select
        value={user.roleKey}
        disabled={busy}
        aria-label={`Rol de ${user.name}`}
        onChange={(e) =>
          run(() => updateAppUserAction(appId, user.id, { roleKey: e.target.value }))
        }
        className={INPUT}
      >
        {!roles.some((r) => r.key === user.roleKey) && (
          <option value={user.roleKey}>{user.roleKey} (ya no existe)</option>
        )}
        {roles.map((r) => (
          <option key={r.key} value={r.key}>
            {r.name}
          </option>
        ))}
      </select>
      {user.status !== 'disabled' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => resendAppInvitationAction(appId, user.id))}
          className={BTN_SECONDARY}
        >
          <Mail className="h-3.5 w-3.5" aria-hidden /> Reenviar
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (
            user.status === 'disabled' ||
            window.confirm(`¿Desactivar a ${user.name}? Se cierran todas sus sesiones.`)
          )
            run(() =>
              setAppUserStatusAction(
                appId,
                user.id,
                user.status === 'disabled' ? 'active' : 'disabled',
              ),
            );
        }}
        className={BTN_SECONDARY}
      >
        {user.status === 'disabled' ? 'Reactivar' : 'Desactivar'}
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label={`Quitar a ${user.name}`}
        onClick={() => {
          if (window.confirm(`¿Quitar a ${user.name} de la aplicación?`))
            run(() => removeAppUserAction(appId, user.id));
        }}
        className={BTN_DANGER}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </button>
      {kioskEnabled && user.status !== 'disabled' && (
        <PinControl appId={appId} user={user} busy={busy} />
      )}
    </li>
  );
}

export function UsersTab({ data }: { data: AppEditorData }) {
  const { app, roles, appUsers, entryPath, kiosk, attributeValues } = data;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState(roles[0]?.key ?? '');
  const [attrs, setAttrs] = useState('');
  // Portal: el valor de cada atributo que el rol elegido necesita (con los valores reales de su columna).
  const [required, setRequired] = useState<Record<string, string>>({});
  const [csv, setCsv] = useState('');
  const needs = requiredAttributesOf(
    roles.find((r) => r.key === roleKey)?.permissions ?? {
      tables: {},
      export: false,
    },
  );
  const [entryUrl, setEntryUrl] = useState(entryPath);
  useEffect(() => setEntryUrl(`${window.location.origin}${entryPath}`), [entryPath]);

  const run: Run = (task) => {
    setError(null);
    setNote(null);
    start(async () => {
      const res = await task();
      if (!res.ok) return setError(res.error ?? 'No se pudo.');
      router.refresh();
    });
  };

  /** «cliente=Andina, sede=Norte» → {cliente: 'Andina', sede: 'Norte'} */
  function parseAttrs(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of text.split(',')) {
      const [k, ...v] = part.split('=');
      if (k?.trim() && v.length) out[k.trim()] = v.join('=').trim();
    }
    return out;
  }

  return (
    <div className="space-y-5">
      <p className="max-w-2xl text-xs leading-relaxed text-ink-muted">
        Aquí invitas a quien no tiene cuenta de Cortex: operarios, clientes. Les llega un correo con
        el enlace, escriben su correo y reciben un código para entrar. No cuentan como asientos del
        plan.{' '}
        {app.status !== 'published' &&
          'La app está en borrador: publícala para que el enlace abra.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded-pill bg-surface-2 px-3 py-1.5 text-micro text-ink-muted">
          {entryUrl}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(entryUrl);
            setNote('Enlace copiado.');
          }}
          className={BTN_SECONDARY}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden /> Copiar enlace
        </button>
      </div>
      <ErrorLine error={error} />
      {note && (
        <p className="rounded-card bg-emerald-soft px-3 py-2 text-xs text-emerald">{note}</p>
      )}

      <KioskPanel appId={app.id} kiosk={kiosk} />

      {appUsers.length === 0 ? (
        <p className="rounded-card border border-dashed border-border-strong bg-surface/40 p-6 text-center text-sm text-ink-muted">
          Todavía no invitaste a nadie de afuera.
        </p>
      ) : (
        <ul className="space-y-2">
          {appUsers.map((u) => (
            <UserRow
              key={`${u.id}:${u.roleKey}:${u.status}`}
              appId={app.id}
              user={u}
              roles={roles}
              busy={pending}
              run={run}
              kioskEnabled={kiosk.enabled}
            />
          ))}
        </ul>
      )}

      <form
        className={clsx(CARD, 'space-y-3')}
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          setNote(null);
          start(async () => {
            const res = await inviteAppUserAction(app.id, {
              name,
              email,
              roleKey,
              attributes: {
                ...parseAttrs(attrs),
                ...Object.fromEntries(needs.map((a) => [a, (required[a] ?? '').trim()])),
              },
            });
            if (!res.ok) return setError(res.error);
            setNote(
              res.emailed
                ? `Invitación enviada a ${email}.`
                : `Quedó en la lista${res.note ? ` (${res.note})` : ''}. Puedes reenviarla.`,
            );
            setName('');
            setEmail('');
            setAttrs('');
            setRequired({});
            router.refresh();
          });
        }}
      >
        <h3 className="text-sm font-semibold text-ink">Invitar a una persona</h3>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 basis-40">
            <span className="mb-1 block text-micro font-semibold text-ink-muted">Nombre</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={clsx(INPUT, 'w-full')}
              required
              maxLength={80}
            />
          </label>
          <label className="min-w-0 flex-1 basis-48">
            <span className="mb-1 block text-micro font-semibold text-ink-muted">Correo</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={clsx(INPUT, 'w-full')}
              required
            />
          </label>
          <label>
            <span className="mb-1 block text-micro font-semibold text-ink-muted">Rol</span>
            <select value={roleKey} onChange={(e) => setRoleKey(e.target.value)} className={INPUT}>
              {roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          {needs.map((attr) => (
            <label key={attr} className="min-w-0 flex-1 basis-40">
              <span className="mb-1 block text-micro font-semibold text-ink-muted">
                {attr.charAt(0).toUpperCase() + attr.slice(1).replace(/_/g, ' ')} (de la persona)
              </span>
              <input
                value={required[attr] ?? ''}
                onChange={(e) => setRequired({ ...required, [attr]: e.target.value })}
                list={`valores-${attr}`}
                required
                maxLength={120}
                placeholder="Elige o escribe"
                className={clsx(INPUT, 'w-full')}
              />
              <datalist id={`valores-${attr}`}>
                {(attributeValues[attr] ?? []).map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </label>
          ))}
          <label className="min-w-0 flex-1 basis-48">
            <span className="mb-1 block text-micro font-semibold text-ink-muted">
              Otros atributos (opcional)
            </span>
            <input
              value={attrs}
              onChange={(e) => setAttrs(e.target.value)}
              placeholder="cliente=Andina, sede=Norte"
              className={clsx(INPUT, 'w-full')}
            />
          </label>
          <button
            type="submit"
            disabled={
              pending ||
              !name.trim() ||
              !email.trim() ||
              !roleKey ||
              needs.some((a) => !(required[a] ?? '').trim())
            }
            className={BTN_PRIMARY}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Invitar
          </button>
        </div>
      </form>

      <form
        className={clsx(CARD, 'space-y-3')}
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          setNote(null);
          start(async () => {
            const res = await importAppUsersAction(app.id, csv);
            if (!res.ok) return setError(res.error);
            setNote(
              `${res.invited} invitados, ${res.emailed} correos enviados${
                res.skipped.length
                  ? `. Se saltaron ${res.skipped.length}: ${res.skipped
                      .slice(0, 3)
                      .map((s) => `fila ${s.line} (${s.reason})`)
                      .join('; ')}`
                  : ''
              }.`,
            );
            setCsv('');
            router.refresh();
          });
        }}
      >
        <h3 className="text-sm font-semibold text-ink">Importar una lista (CSV)</h3>
        <p className="text-micro text-ink-muted">
          Primera fila con las columnas <strong>nombre, correo, rol</strong>; cualquier otra columna
          (por ejemplo «cliente») es un atributo. Pega el contenido o elige el archivo.
        </p>
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={4}
          placeholder={'nombre,correo,rol,cliente\nAna Pérez,ana@empresa.com,operario,Andina'}
          className="w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:border-primary"
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className={clsx(BTN_SECONDARY, 'cursor-pointer')}>
            <Upload className="h-3.5 w-3.5" aria-hidden /> Elegir archivo
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setCsv(await file.text());
              }}
            />
          </label>
          <button type="submit" disabled={pending || !csv.trim()} className={BTN_PRIMARY}>
            Importar e invitar
          </button>
        </div>
      </form>
    </div>
  );
}
