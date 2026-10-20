'use client';

import {
  type NoticesView,
  loadNoticesAction,
  markNoticesReadAction,
  setNoticePrefsAction,
} from '@/lib/apps/notice-actions';
import type { NoticeGroup } from '@cortex/agent-tools';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import {
  Bell,
  BellOff,
  BadgeCheck,
  CheckCheck,
  ClipboardPlus,
  Plus,
  UserCheck,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { BrandScope } from '@/components/views/blocks/brand';
import { PushToggle } from './AppAutomationBar';
import { useAppToast } from './AppToast';

/**
 * LOS AVISOS AUTOMÁTICOS DENTRO DE LA APP (0231).
 *
 * Nadie crea reglas: cuando otro rol registra o cambia algo de lo que esta
 * persona depende, o le asignan o le dejan algo por aprobar, el servidor deja un
 * aviso en su bandeja (apps/notices). Aquí se ve:
 *   - un número por pantalla en la navegación («3 nuevos»);
 *   - la campana con la bandeja agrupada («5 nuevos en Atenciones»), marcar
 *     leído y las preferencias de la persona (todo / sólo lo mío / nada,
 *     silenciar, correo, push);
 *   - un aviso en pantalla (toast) cuando llega algo mientras la app está abierta.
 * Se revisa cada 30 s mientras la pestaña está visible y al volver a ella; abrir
 * una pantalla marca como leído lo que apuntaba a ella. Sin proveedor (vista
 * previa, «Ver como…», panel) todo esto no pinta nada.
 */

const POLL_MS = 30_000;

interface NoticesApi {
  view: NoticesView | null;
  refresh: () => void;
  markRead: (what: { ids: string[] } | { screen: string | null } | { all: true }) => Promise<void>;
  setPrefs: (patch: {
    level?: 'all' | 'mine' | 'none';
    email?: boolean;
    mute?: '1h' | '8h' | 'tomorrow' | 'off';
  }) => Promise<string | null>;
  appId: string;
  base: string;
  suffix: string;
}

const Ctx = createContext<NoticesApi | null>(null);

export function useNotices(): NoticesApi | null {
  return useContext(Ctx);
}

export function AppNoticesProvider({
  appId,
  base,
  suffix = '',
  current,
  enabled,
  children,
}: {
  appId: string;
  base: string;
  suffix?: string;
  current: string;
  enabled: boolean;
  children: ReactNode;
}) {
  const [view, setView] = useState<NoticesView | null>(null);
  const toast = useAppToast();
  const router = useRouter();
  const since = useRef<string | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(() => {
    if (!enabled || busy.current) return;
    busy.current = true;
    loadNoticesAction(appId, since.current)
      .then((res) => {
        if (!res.ok) return;
        const first = since.current === null;
        since.current = res.view.now;
        setView(res.view);
        // El primer vistazo al abrir no «grita» lo que ya estaba: sólo lo que llega después.
        if (first) return;
        for (const n of res.view.fresh) {
          toast({
            tone: 'info',
            text: n.title,
            action: {
              label: 'Abrir',
              run: () =>
                router.push(
                  `${base}/${n.screen ?? ''}${n.rowId ? `?fila=${encodeURIComponent(n.rowId)}` : ''}`,
                ),
            },
          });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        busy.current = false;
      });
  }, [enabled, appId, toast, router, base]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const tick = () => document.visibilityState === 'visible' && refresh();
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('cortex:refresh-view', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('cortex:refresh-view', refresh);
    };
  }, [enabled, refresh]);

  const markRead = useCallback<NoticesApi['markRead']>(
    async (what) => {
      // Se descuenta de inmediato; el servidor confirma en el siguiente vistazo.
      setView((v) => {
        if (!v) return v;
        const ids = 'ids' in what ? new Set(what.ids) : null;
        const groups = v.groups.map((g) =>
          'all' in what ||
          (ids && g.ids.every((i) => ids.has(i))) ||
          ('screen' in what && g.screen === what.screen)
            ? { ...g, unread: false }
            : g,
        );
        const byScreen = { ...v.byScreen };
        if ('screen' in what) delete byScreen[what.screen ?? ''];
        if ('all' in what) for (const k of Object.keys(byScreen)) delete byScreen[k];
        const unread =
          'ids' in what
            ? Math.max(0, v.unread - what.ids.length)
            : Object.values(byScreen).reduce((a, b) => a + b, 0);
        return { ...v, groups, byScreen, unread };
      });
      await markNoticesReadAction(appId, what);
      refresh();
    },
    [appId, refresh],
  );

  const setPrefs = useCallback<NoticesApi['setPrefs']>(
    async (patch) => {
      const res = await setNoticePrefsAction(appId, patch);
      if (!res.ok) return res.error;
      setView((v) => (v ? { ...v, prefs: res.prefs } : v));
      return null;
    },
    [appId],
  );

  // Abrir una pantalla marca como leído lo que apuntaba a ella.
  const unreadHere = view?.byScreen[current] ?? 0;
  useEffect(() => {
    if (!unreadHere) return;
    const t = window.setTimeout(() => void markRead({ screen: current }), 1500);
    return () => window.clearTimeout(t);
  }, [unreadHere, current, markRead]);

  const value = useMemo<NoticesApi | null>(
    () => (enabled ? { view, refresh, markRead, setPrefs, appId, base, suffix } : null),
    [enabled, view, refresh, markRead, setPrefs, appId, base, suffix],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** «3» en el ícono de una pantalla (o la suma de varias, para «Más»). */
export function NoticeBadge({
  slugs,
  className,
}: {
  slugs: string[];
  className?: string;
}) {
  const api = useNotices();
  const n = slugs.reduce((sum, s) => sum + (api?.view?.byScreen[s] ?? 0), 0);
  if (!n) return null;
  return (
    <span
      role="status"
      aria-label={`${n} ${n === 1 ? 'aviso nuevo' : 'avisos nuevos'}`}
      className={clsx(
        'grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-pill bg-rose px-1 text-[0.6875rem] font-extrabold leading-none text-white ring-2 ring-surface',
        className,
      )}
    >
      {n > 9 ? '9+' : n}
    </span>
  );
}

const KIND_ICON = {
  new: Plus,
  assigned: UserCheck,
  approval: BadgeCheck,
  changed: ClipboardPlus,
} as const;

const LEVELS = [
  {
    id: 'all',
    label: 'Todo lo que me toque',
    hint: 'Lo nuevo de lo que uso, lo que me asignen y lo que deba aprobar.',
  },
  { id: 'mine', label: 'Sólo lo mío y lo que me asignen', hint: 'Sin «nuevos» de los demás.' },
  { id: 'none', label: 'Nada', hint: 'No recibo avisos de esta app.' },
] as const;

const MUTES = [
  { id: '1h', label: '1 hora' },
  { id: '8h', label: '8 horas' },
  { id: 'tomorrow', label: 'Hasta mañana 7 a. m.' },
] as const;

function since(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

/** La campana: abre la bandeja y las preferencias. `row` es la fila del menú; `icon` el botón de la cabecera. */
export function NoticesBell({ variant }: { variant: 'row' | 'icon' }) {
  const api = useNotices();
  const [open, setOpen] = useState(false);
  if (!api) return null;
  const unread = api.view?.unread ?? 0;
  const muted = Boolean(
    api.view?.prefs.mutedUntil && Date.parse(api.view.prefs.mutedUntil) > Date.now(),
  );
  const off = api.view?.prefs.level === 'none';
  const Icon = muted || off ? BellOff : Bell;
  return (
    <>
      {variant === 'icon' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={unread ? `Avisos, ${unread} sin leer` : 'Avisos'}
          className="app-press relative grid h-11 w-11 place-items-center rounded-pill text-ink-muted hover:bg-surface-2"
        >
          <Icon className="h-5 w-5" aria-hidden />
          {unread > 0 && <NoticeCount n={unread} className="absolute right-1 top-1" />}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="app-press inline-flex min-h-11 w-full items-center gap-2 text-sm font-semibold text-ink hover:text-primary"
        >
          <Icon className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
          <span>Avisos</span>
          {unread > 0 && <NoticeCount n={unread} />}
        </button>
      )}
      <NoticesSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

function NoticeCount({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={clsx(
        'grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-pill bg-rose px-1 text-[0.6875rem] font-extrabold leading-none text-white',
        className,
      )}
    >
      {n > 9 ? '9+' : n}
    </span>
  );
}

function NoticesSheet({
  open,
  onOpenChange,
}: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const api = useNotices();
  const router = useRouter();
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) api?.refresh();
  }, [open, api]);
  if (!api) return null;
  const view = api.view;
  const hrefOf = (g: NoticeGroup) =>
    `${api.base}/${g.screen ?? ''}${g.rowId ? `?fila=${encodeURIComponent(g.rowId)}` : ''}${g.rowId ? '' : api.suffix}`;

  async function change(patch: Parameters<NoticesApi['setPrefs']>[0]) {
    setError((await api?.setPrefs(patch)) ?? null);
  }
  const muted = Boolean(view?.prefs.mutedUntil && Date.parse(view.prefs.mutedUntil) > Date.now());

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <BrandScope>
          <Dialog.Overlay className="app-overlay fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
          <Dialog.Content
            aria-describedby={undefined}
            className="app-sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-[1.75rem] bg-surface pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-pop md:inset-x-auto md:bottom-0 md:right-0 md:top-0 md:max-h-none md:w-[26rem] md:rounded-none md:rounded-l-[1.75rem] md:pb-4"
          >
            <div className="px-4 pt-3">
              <div
                aria-hidden
                className="mx-auto mb-3 h-1.5 w-10 rounded-pill bg-border-strong md:hidden"
              />
              <div className="flex items-center gap-2">
                <Dialog.Title className="min-w-0 flex-1 text-lg font-extrabold tracking-tight text-ink">
                  Avisos
                </Dialog.Title>
                {(view?.unread ?? 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => void api.markRead({ all: true })}
                    className="app-press inline-flex min-h-11 items-center gap-1.5 rounded-pill px-3 text-xs font-semibold text-primary hover:bg-primary-soft"
                  >
                    <CheckCheck className="h-4 w-4" aria-hidden /> Marcar todo leído
                  </button>
                )}
                <Dialog.Close
                  aria-label="Cerrar"
                  className="app-press grid h-11 w-11 place-items-center rounded-pill bg-surface-2 text-ink-muted"
                >
                  <X className="h-5 w-5" aria-hidden />
                </Dialog.Close>
              </div>
              {muted && (
                <p className="mt-1 flex items-center gap-1.5 text-micro font-semibold text-amber">
                  <BellOff className="h-3.5 w-3.5" aria-hidden /> Silenciados: llegan aquí pero no
                  suenan.{' '}
                  <button
                    type="button"
                    onClick={() => void change({ mute: 'off' })}
                    className="underline"
                  >
                    Quitar
                  </button>
                </p>
              )}
            </div>

            <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-4">
              {!view ? (
                <p className="py-8 text-center text-sm text-ink-muted">Buscando avisos…</p>
              ) : view.groups.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <Bell className="h-8 w-8 text-ink-faint" aria-hidden />
                  <p className="text-sm font-semibold text-ink">Todo al día</p>
                  <p className="max-w-xs text-xs leading-relaxed text-ink-muted">
                    Aquí te avisamos cuando alguien registre algo de lo que usas, te asignen algo o
                    haya algo por aprobar.
                  </p>
                </div>
              ) : (
                <ul className="space-y-1.5 pb-2">
                  {view.groups.map((g) => {
                    const Icon = KIND_ICON[g.kind];
                    return (
                      <li key={g.ids[0]}>
                        <Link
                          href={hrefOf(g)}
                          onClick={() => {
                            void api.markRead({ ids: g.ids });
                            onOpenChange(false);
                            router.refresh();
                          }}
                          className={clsx(
                            'app-press flex min-h-14 items-start gap-3 rounded-card border px-3 py-2.5',
                            g.unread
                              ? 'border-primary/30 bg-primary-soft/50'
                              : 'border-border bg-surface',
                          )}
                        >
                          <span
                            className={clsx(
                              'mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-sm',
                              g.unread ? 'bg-surface text-primary' : 'bg-surface-2 text-ink-muted',
                            )}
                          >
                            <Icon className="h-4 w-4" aria-hidden />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              className={clsx(
                                'block text-sm leading-snug text-ink',
                                g.unread ? 'font-bold' : 'font-semibold',
                              )}
                            >
                              {g.title}
                            </span>
                            {g.body && (
                              <span className="mt-0.5 block text-xs leading-snug text-ink-muted">
                                {g.body}
                              </span>
                            )}
                            <span className="mt-1 block text-micro text-ink-faint">
                              {since(g.createdAt)}
                            </span>
                          </span>
                          {g.unread && (
                            <span
                              aria-hidden
                              className="mt-2 h-2 w-2 shrink-0 rounded-pill bg-primary"
                            />
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="mt-1 border-t border-border px-4 pt-3">
              <button
                type="button"
                aria-expanded={prefsOpen}
                onClick={() => setPrefsOpen((v) => !v)}
                className="app-press flex min-h-11 w-full items-center justify-between text-xs font-semibold text-ink-muted hover:text-ink"
              >
                <span>¿Qué avisos quiero recibir?</span>
                <span aria-hidden>{prefsOpen ? '–' : '+'}</span>
              </button>
              {prefsOpen && view && (
                <div className="space-y-3 pb-1 pt-1">
                  <fieldset className="space-y-1.5">
                    <legend className="sr-only">Qué avisos recibir</legend>
                    {LEVELS.map((l) => (
                      <label
                        key={l.id}
                        className={clsx(
                          'flex min-h-11 cursor-pointer items-start gap-2.5 rounded-card border px-3 py-2',
                          view.prefs.level === l.id
                            ? 'border-primary/40 bg-primary-soft/50'
                            : 'border-border',
                        )}
                      >
                        <input
                          type="radio"
                          name="notice-level"
                          checked={view.prefs.level === l.id}
                          onChange={() => void change({ level: l.id })}
                          className="mt-1 accent-primary"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-ink">{l.label}</span>
                          <span className="block text-micro text-ink-muted">{l.hint}</span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <div>
                    <p className="mb-1 text-micro font-semibold text-ink-muted">
                      Silenciar por un rato
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {MUTES.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => void change({ mute: m.id })}
                          className="app-press min-h-9 rounded-pill border border-border px-3 text-xs font-semibold text-ink hover:bg-surface-2"
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={view.prefs.email}
                      onChange={(e) => void change({ email: e.target.checked })}
                      className="h-4 w-4 accent-primary"
                    />
                    <span>
                      También por correo cuando no pueda llegarme al teléfono
                      <span className="block text-micro text-ink-muted">
                        Asignaciones y aprobaciones siempre llegan por correo si no hay push.
                      </span>
                    </span>
                  </label>
                  {view.pushOn ? (
                    <PushToggle appId={api.appId} />
                  ) : (
                    <p className="flex items-start gap-1.5 text-micro leading-snug text-ink-muted">
                      <BellOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                      Las notificaciones del teléfono están apagadas en este servidor. Los avisos te
                      llegan aquí y, los de asignar y aprobar, por correo.
                    </p>
                  )}
                  {error && <p className="text-micro text-rose">{error}</p>}
                </div>
              )}
            </div>
          </Dialog.Content>
        </BrandScope>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
