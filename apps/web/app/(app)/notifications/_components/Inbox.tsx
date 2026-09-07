'use client';

import {
  type GlobalNotificationView,
  NOTIFICATION_KIND_LABEL,
  repeatNote,
} from '@/lib/notifications-shape';
import { relativeTime } from '@/lib/relative-time';
import { workspaceHref } from '@/lib/workspace-context';
import { clsx } from 'clsx';
import { BellOff, Building2, Check, ChevronDown, Loader2, Radio, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

type Filter = 'all' | 'unread' | 'urgent';
const isUrgent = (item: GlobalNotificationView) =>
  item.readAt === null && (item.tone === 'bad' || item.tone === 'warning');

async function postRead(body: {
  targets?: Array<{ id: string; organizationId: string }>;
  all?: boolean;
}) {
  try {
    return (
      await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).ok;
  } catch {
    return false;
  }
}

function Notice({
  item,
  busy,
  open,
  read,
}: { item: GlobalNotificationView; busy: boolean; open: () => void; read: () => void }) {
  const unread = item.readAt === null;
  return (
    <li
      className={clsx('group border-b border-border last:border-0', unread && 'bg-primary-soft/20')}
    >
      <div className="flex items-start gap-3 px-4 py-4 sm:px-5">
        <span
          className={clsx(
            'mt-2 h-2 w-2 shrink-0 rounded-full',
            isUrgent(item) ? 'bg-rose' : unread ? 'bg-primary' : 'bg-border-strong',
          )}
        />
        <button
          type="button"
          onClick={open}
          disabled={busy}
          className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="inline-flex max-w-full items-center gap-1 rounded-pill border border-border bg-surface px-2 py-0.5 text-micro font-semibold text-ink-muted">
              {item.organizationKind === 'personal' ? (
                <UserRound className="h-3 w-3 shrink-0" />
              ) : (
                <Building2 className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate">{item.organizationName}</span>
            </span>
            {isUrgent(item) && (
              <span className="rounded-pill bg-rose-soft px-2 py-0.5 text-micro font-bold text-rose">
                Urgente
              </span>
            )}
          </div>
          <div
            className={clsx(
              'text-sm leading-snug text-ink',
              unread ? 'font-semibold' : 'font-medium',
            )}
          >
            {item.title}
          </div>
          {item.body && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-muted">{item.body}</p>
          )}
          <div className="tabular mt-2 flex flex-wrap gap-2 text-micro text-ink-faint">
            <span>{NOTIFICATION_KIND_LABEL[item.kind]}</span>
            <span>·</span>
            <span>{relativeTime(item.occurredAt)}</span>
            {repeatNote(item.occurrences) && (
              <>
                <span>·</span>
                <span>{repeatNote(item.occurrences)}</span>
              </>
            )}
          </div>
        </button>
        {unread && (
          <button
            type="button"
            onClick={read}
            disabled={busy}
            aria-label={`Marcar como leído: ${item.title}`}
            className="rounded-full p-2 text-ink-faint hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          </button>
        )}
      </div>
    </li>
  );
}

export function Inbox({ initial }: { initial: GlobalNotificationView[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [workspace, setWorkspace] = useState('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [digestOpen, setDigestOpen] = useState(true);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem('cortex.notifications.digestOpen');
    if (saved !== null) setDigestOpen(saved === 'true');
    const receive = (event: Event) => {
      const body = (
        event as CustomEvent<{
          notifications: GlobalNotificationView[];
          unread: number;
        }>
      ).detail;
      setItems(body.notifications);
      setLive(true);
    };
    window.addEventListener('cortex:notifications', receive);
    return () => window.removeEventListener('cortex:notifications', receive);
  }, []);

  const spaces = useMemo(
    () => Array.from(new Map(items.map((item) => [item.organizationId, item])).values()),
    [items],
  );
  const scoped = items.filter((item) => workspace === 'all' || item.organizationId === workspace);
  const urgent = scoped.filter(isUrgent);
  const rest = scoped.filter(
    (item) => !isUrgent(item) && (filter === 'all' || item.readAt === null),
  );
  const unread = items.filter((item) => item.readAt === null).length;
  const markLocal = (id: string) =>
    setItems((old) =>
      old.map((item) =>
        item.id === id ? { ...item, readAt: item.readAt ?? new Date().toISOString() } : item,
      ),
    );
  async function markOne(item: GlobalNotificationView) {
    setBusy(item.id);
    if (await postRead({ targets: [{ id: item.id, organizationId: item.organizationId }] }))
      markLocal(item.id);
    setBusy(null);
  }
  async function open(item: GlobalNotificationView) {
    if (item.readAt === null) await markOne(item);
    if (item.href) router.push(workspaceHref(item.organizationId, item.href));
  }
  async function markEverything() {
    setMarkingAll(true);
    if (await postRead({ all: true }))
      setItems((old) =>
        old.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })),
      );
    setMarkingAll(false);
  }
  function toggleDigest() {
    setDigestOpen((value) => {
      window.localStorage.setItem('cortex.notifications.digestOpen', String(!value));
      return !value;
    });
  }

  return (
    <div>
      <div className="flex flex-col gap-3 border-b border-border bg-surface-2/50 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-ink">
              {unread ? `${unread} sin leer` : 'Todo al día'}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-micro text-ink-faint">
              <Radio className={clsx('h-3 w-3', live && 'text-emerald')} />
              {live ? 'Actualización en vivo' : 'Reconectando'}
            </div>
          </div>
          {unread > 0 && (
            <button
              type="button"
              onClick={markEverything}
              disabled={markingAll}
              className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink-muted hover:border-border-strong hover:text-ink disabled:opacity-60"
            >
              {markingAll ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Marcar todo leído
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="notification-workspace">
            Espacio
          </label>
          <select
            id="notification-workspace"
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            className="min-w-44 max-w-full rounded-sm border border-border bg-surface px-3 py-2 text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="all">Todos los espacios</option>
            {spaces.map((space) => (
              <option key={space.organizationId} value={space.organizationId}>
                {space.organizationName}
              </option>
            ))}
          </select>
          <div
            className="flex rounded-sm border border-border bg-surface p-0.5"
            aria-label="Filtrar avisos"
          >
            {(['all', 'unread', 'urgent'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={clsx(
                  'rounded-[5px] px-3 py-1.5 text-xs font-semibold',
                  filter === value
                    ? 'bg-primary-soft text-primary-ink'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                {value === 'all' ? 'Todos' : value === 'unread' ? 'Sin leer' : 'Urgentes'}
              </button>
            ))}
          </div>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="px-6 py-14 text-center">
          <BellOff className="mx-auto h-7 w-7 text-ink-faint" />
          <h2 className="mt-3 text-base font-bold text-ink">Nada que contarte todavía</h2>
          <p className="mt-1 text-sm text-ink-muted">Los hechos de tus espacios aparecerán aquí.</p>
        </div>
      ) : (
        <>
          {(filter === 'all' || filter === 'unread' || filter === 'urgent') &&
            urgent.length > 0 && (
              <section aria-labelledby="urgent-title">
                <div className="border-b border-rose/20 bg-rose-soft/50 px-5 py-2.5">
                  <h2
                    id="urgent-title"
                    className="text-xs font-bold uppercase tracking-wide text-rose"
                  >
                    Requiere atención ahora · {urgent.length}
                  </h2>
                </div>
                <ul>
                  {urgent.map((item) => (
                    <Notice
                      key={`${item.organizationId}:${item.id}`}
                      item={item}
                      busy={busy === item.id}
                      open={() => void open(item)}
                      read={() => void markOne(item)}
                    />
                  ))}
                </ul>
              </section>
            )}
          {filter !== 'urgent' && (
            <section aria-labelledby="digest-title">
              <button
                type="button"
                onClick={toggleDigest}
                className="flex w-full items-center justify-between border-y border-border bg-surface px-5 py-3 text-left"
              >
                <span>
                  <span
                    id="digest-title"
                    className="text-xs font-bold uppercase tracking-wide text-ink-muted"
                  >
                    Resumen
                  </span>
                  <span className="ml-2 text-micro text-ink-faint">{rest.length} avisos</span>
                </span>
                <ChevronDown
                  className={clsx(
                    'h-4 w-4 text-ink-faint transition-transform',
                    digestOpen && 'rotate-180',
                  )}
                />
              </button>
              {digestOpen && (
                <ul>
                  {rest.map((item) => (
                    <Notice
                      key={`${item.organizationId}:${item.id}`}
                      item={item}
                      busy={busy === item.id}
                      open={() => void open(item)}
                      read={() => void markOne(item)}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
          {filter === 'urgent' && urgent.length === 0 && (
            <div className="px-6 py-12 text-center text-sm text-ink-muted">
              No hay avisos urgentes en esta vista.
            </div>
          )}
        </>
      )}
    </div>
  );
}
