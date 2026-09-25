'use client';

import {
  archiveViewAction,
  restoreViewVersionAction,
  setViewAccessAction,
  setViewPinnedAction,
} from '@/lib/views/actions';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import {
  Archive,
  Check,
  Copy,
  Globe,
  History,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  Pin,
  PinOff,
  RefreshCw,
  Users,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Las acciones de una vista: fijar en Inicio, compartir, historial y archivar.
 *
 * COMPARTIR es la única con peso. Las tres puertas se explican con lo que ve
 * quien recibe el enlace, no con cómo está hecho, y la advertencia está antes
 * del botón y no después: quien abre la puerta tiene que saber que saca filas
 * de la empresa. La contraseña se escribe aquí y en ningún otro sitio — no pasa
 * por el chat, porque lo que pasa por el chat queda en la auditoría.
 */

type Visibility = 'workspace' | 'link' | 'password';

export interface ToolbarView {
  id: string;
  name: string;
  version: number;
  visibility: Visibility;
  pinned: boolean;
  publicUrl: string | null;
  expiresAt: string | null;
  opens: number;
  canManage: boolean;
  /**
   * Por qué esta vista no puede salir de Cortex (usa una fuente interna de la
   * plataforma), o null. El servidor lo rechaza igual; esto lo dice antes.
   */
  shareBlocked: string | null;
}

export interface ToolbarVersion {
  version: number;
  prompt: string | null;
  when: string;
}

const PILL =
  'inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2 disabled:opacity-45 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary';

export function ViewToolbar({ view, versions }: { view: ToolbarView; versions: ToolbarVersion[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={PILL}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await setViewPinnedAction(view.id, !view.pinned);
            if (!res.ok) setError(res.error);
            router.refresh();
          })
        }
      >
        {view.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        {view.pinned ? 'Quitar de Inicio' : 'Fijar en Inicio'}
      </button>
      <ShareDialog view={view} />
      <HistoryDialog view={view} versions={versions} />
      {view.canManage && (
        <button
          type="button"
          className={clsx(PILL, 'text-ink-muted')}
          disabled={pending}
          onClick={() => {
            if (
              !window.confirm(
                `¿Archivar «${view.name}»? Desaparece de la lista y su enlace deja de abrir. Los datos no se tocan.`,
              )
            )
              return;
            start(async () => {
              const res = await archiveViewAction(view.id);
              if (res.ok) router.push('/views');
              else setError(res.error);
            });
          }}
        >
          <Archive className="h-3.5 w-3.5" /> Archivar
        </button>
      )}
      {error && <p className="w-full text-xs text-rose">{error}</p>}
    </div>
  );
}

const DOORS: Array<{ id: Visibility; icon: typeof Users; title: string; body: string }> = [
  {
    id: 'workspace',
    icon: Users,
    title: 'Sólo el equipo',
    body: 'La ven las personas de este espacio, dentro de Cortex.',
  },
  {
    id: 'link',
    icon: Globe,
    title: 'Cualquiera con el enlace',
    body: 'Sin cuenta. Sirve para clientes, proveedores o conductores.',
  },
  {
    id: 'password',
    icon: Lock,
    title: 'Enlace con contraseña',
    body: 'Como el enlace, pero pide una contraseña que tú das aparte.',
  },
];

function ShareDialog({ view }: { view: ToolbarView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [door, setDoor] = useState<Visibility>(view.visibility);
  const [password, setPassword] = useState('');
  const [days, setDays] = useState<string>('none');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  const apply = (rotate = false) =>
    start(async () => {
      setError(null);
      const res = await setViewAccessAction(view.id, {
        visibility: door,
        password: door === 'password' ? password : undefined,
        days: door === 'workspace' ? undefined : days === 'none' ? null : Number(days),
        rotate,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPassword('');
      router.refresh();
    });

  const changed =
    door !== view.visibility ||
    (door === 'password' && password.length > 0) ||
    (door !== 'workspace' && days !== 'none');
  const Icon =
    view.visibility === 'workspace' ? Users : view.visibility === 'link' ? Link2 : KeyRound;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className={PILL}>
        <Icon className="h-3.5 w-3.5" />
        {view.visibility === 'workspace'
          ? 'Compartir'
          : view.visibility === 'link'
            ? 'Con enlace'
            : 'Con contraseña'}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(520px,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <Dialog.Title className="text-sm font-bold text-ink">
                Compartir «{view.name}»
              </Dialog.Title>
              <Dialog.Description className="text-micro text-ink-faint">
                Quién puede abrir esta vista y cómo.
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="grid h-8 w-8 place-items-center rounded-card text-ink-faint hover:bg-surface-2 hover:text-ink"
              aria-label="Cerrar"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="scroll-slim min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
            {!view.canManage && (
              <p className="rounded-sm bg-surface-2 px-3 py-2 text-xs text-ink-muted">
                Sólo quien creó la vista o un administrador puede cambiar cómo se comparte.
              </p>
            )}
            {view.shareBlocked && (
              <p className="rounded-sm border border-amber/25 bg-amber-soft px-3 py-2 text-xs leading-relaxed text-amber">
                {view.shareBlocked}
              </p>
            )}
            <fieldset className="space-y-2" disabled={!view.canManage || pending}>
              {DOORS.map((d) => {
                const locked = Boolean(view.shareBlocked) && d.id !== 'workspace';
                return (
                  <label
                    key={d.id}
                    className={clsx(
                      'flex items-start gap-3 rounded-sm border px-3 py-2.5 transition-colors',
                      locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                      door === d.id
                        ? 'border-primary bg-primary-soft/40'
                        : 'border-border hover:bg-surface-2',
                    )}
                  >
                    <input
                      type="radio"
                      name="door"
                      className="sr-only"
                      checked={door === d.id}
                      disabled={locked}
                      onChange={() => setDoor(d.id)}
                    />
                    <d.icon
                      className={clsx(
                        'mt-0.5 h-4 w-4 shrink-0',
                        door === d.id ? 'text-primary' : 'text-ink-faint',
                      )}
                    />
                    <span>
                      <span className="block text-sm font-semibold text-ink">{d.title}</span>
                      <span className="block text-xs text-ink-muted">{d.body}</span>
                    </span>
                    {door === d.id && <Check className="ml-auto mt-0.5 h-4 w-4 text-primary" />}
                  </label>
                );
              })}
            </fieldset>

            {door !== 'workspace' && view.canManage && (
              <div className="space-y-3">
                {door === 'password' && (
                  <label className="block">
                    <span className="field-label mb-1 block">
                      {view.visibility === 'password'
                        ? 'Nueva contraseña (opcional)'
                        : 'Contraseña'}
                    </span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      minLength={6}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Mínimo 6 caracteres"
                      className="w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-primary"
                    />
                  </label>
                )}
                <label className="block">
                  <span className="field-label mb-1 block">Vence</span>
                  <select
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                    className="w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-primary"
                  >
                    <option value="none">
                      {view.expiresAt ? 'Quitar el vencimiento' : 'No vence'}
                    </option>
                    <option value="7">En 7 días</option>
                    <option value="30">En 30 días</option>
                    <option value="90">En 90 días</option>
                  </select>
                </label>
                <p className="rounded-sm border border-amber/40 bg-amber-soft/50 px-3 py-2 text-xs leading-relaxed text-ink">
                  Quien abra el enlace ve lo que muestra esta vista —sus cifras, tablas y tableros—
                  con los datos del momento, y puede usar sus formularios. No ve nada más de Cortex.
                </p>
              </div>
            )}

            {view.publicUrl && (
              <div className="rounded-sm border border-border bg-surface-2 p-3">
                <p className="field-label mb-1.5">Enlace activo</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                    {view.publicUrl}
                  </code>
                  <button
                    type="button"
                    className={PILL}
                    onClick={async () => {
                      await navigator.clipboard.writeText(view.publicUrl ?? '');
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? 'Copiado' : 'Copiar'}
                  </button>
                </div>
                <p className="mt-2 text-micro text-ink-faint">
                  Abierto {view.opens} {view.opens === 1 ? 'vez' : 'veces'}
                  {view.expiresAt
                    ? ` · vence el ${new Date(view.expiresAt).toLocaleDateString('es-CO', { dateStyle: 'long' })}`
                    : ' · no vence'}
                  .
                </p>
                {view.canManage && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => apply(true)}
                    className="mt-2 inline-flex items-center gap-1 text-micro font-semibold text-ink-muted hover:text-ink"
                  >
                    <RefreshCw className="h-3 w-3" /> Cambiar el enlace (el anterior deja de abrir)
                  </button>
                )}
              </div>
            )}
            {error && <p className="text-xs text-rose">{error}</p>}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            <Dialog.Close className="rounded-pill px-3 py-1.5 text-xs font-semibold text-ink-muted hover:bg-surface-2 hover:text-ink">
              Cerrar
            </Dialog.Close>
            {view.canManage && (
              <button
                type="button"
                disabled={
                  pending ||
                  !changed ||
                  (door === 'password' && view.visibility !== 'password' && password.length < 6)
                }
                onClick={() => apply(false)}
                className="cortex-primary-button inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-1.5 text-xs font-semibold text-white hover:bg-primary-strong disabled:opacity-45"
              >
                {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Guardar acceso
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HistoryDialog({ view, versions }: { view: ToolbarView; versions: ToolbarVersion[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog.Root>
      <Dialog.Trigger className={PILL}>
        <History className="h-3.5 w-3.5" /> v{view.version}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[min(480px,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <Dialog.Title className="text-sm font-bold text-ink">Historial</Dialog.Title>
              <Dialog.Description className="text-micro text-ink-faint">
                Cada cambio es una versión. Restaurar crea una versión nueva; no se borra nada.
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="grid h-8 w-8 place-items-center rounded-card text-ink-faint hover:bg-surface-2 hover:text-ink"
              aria-label="Cerrar"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <ol className="scroll-slim min-h-0 flex-1 divide-y divide-border overflow-auto">
            {versions.map((v) => (
              <li key={v.version} className="flex items-start gap-3 px-5 py-3">
                <span className="tabular mt-0.5 rounded-pill bg-surface-2 px-2 py-0.5 font-mono text-micro text-ink-muted">
                  v{v.version}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">{v.prompt ?? 'Sin descripción'}</p>
                  <p className="text-micro text-ink-faint">{v.when}</p>
                </div>
                {v.version === view.version ? (
                  <span className="text-micro font-semibold text-emerald">Actual</span>
                ) : (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const res = await restoreViewVersionAction(view.id, v.version);
                        if (res.ok) router.refresh();
                        else setError(res.error);
                      })
                    }
                    className="text-xs font-semibold text-primary hover:underline disabled:opacity-45"
                  >
                    Restaurar
                  </button>
                )}
              </li>
            ))}
          </ol>
          {error && <p className="px-5 pb-3 text-xs text-rose">{error}</p>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
