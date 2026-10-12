'use client';

import { SNOOZE_LABEL, type SnoozeChoice } from '@/lib/hoy/snooze';
import type { DoneView, TodoView } from '@/lib/hoy/view';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { AlarmClock, Check, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

export type DecideFn = (input: {
  itemId: string;
  decision: 'approve' | 'dismiss';
  contentHash: string;
}) => Promise<{ ok: boolean; note: string }>;

export type SnoozeFn = (input: {
  key: string;
  choice: SnoozeChoice;
  title?: string;
}) => Promise<{ ok: boolean; note: string }>;

/**
 * «PARA TI, HOY»: lo que espera tu decisión, como una lista de pendientes. Lo
 * que viene del piloto se aprueba o descarta aquí mismo con la misma acción que
 * /piloto (la huella viaja con el clic y el servidor vuelve a comprobar quién
 * puede); lo demás lleva a su pantalla. Aprobar un correo es enviarlo, así que
 * el círculo nunca decide solo: sólo los botones.
 */
export function TodoList({
  todos,
  done,
  canDecide,
  decide,
  snooze,
  snoozed = 0,
  more,
  moreHref,
}: {
  todos: TodoView[];
  done: DoneView[];
  canDecide: boolean;
  decide: DecideFn;
  /** Posponer («Mañana» / «La otra semana»); sin ella no se ofrece. */
  snooze?: SnoozeFn;
  /** Cuántas cosas pospuestas siguen escondidas. */
  snoozed?: number;
  more: number;
  moreHref: string | null;
}) {
  // Teclado: j/k mueven la selección; a, e y x actúan sobre la seleccionada.
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    if (todos.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        setActive((cur) => {
          if (cur === null) return e.key === 'j' ? 0 : todos.length - 1;
          return Math.min(todos.length - 1, Math.max(0, cur + (e.key === 'j' ? 1 : -1)));
        });
      } else if (e.key === 'Escape') {
        setActive(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [todos.length]);

  return (
    <section aria-label="Para ti, hoy" className="flex flex-col gap-1">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="title-display text-[1.75rem] leading-tight text-ink">Para ti, hoy</h2>
        {todos.length > 0 && (
          <p className="hidden items-center gap-2 text-xs text-ink-faint sm:flex" aria-hidden>
            <Hint k="j / k" text="mover" />
            {canDecide && <Hint k="a" text="aprobar" />}
            <Hint k="e" text="editar" />
            {canDecide && <Hint k="x" text="descartar" />}
            {snooze && <Hint k="m" text="posponer (M: la otra semana)" />}
          </p>
        )}
      </div>
      {todos.length === 0 && done.length === 0 && (
        <p className="rounded-card border border-dashed border-border px-4 py-6 text-sm text-ink-muted">
          Nada te espera por ahora. Cuando haya algo que decidir, aparece aquí con todo listo.
          {snoozed > 0 &&
            ` Tienes ${snoozed} ${snoozed === 1 ? 'cosa pospuesta' : 'cosas pospuestas'} que volver${snoozed === 1 ? 'á' : 'án'} solas.`}
        </p>
      )}
      <ul className="flex flex-col">
        {todos.map((t, i) => (
          <Todo
            key={t.id}
            t={t}
            first={i === 0}
            active={active === i}
            canDecide={canDecide}
            decide={decide}
            snooze={snooze}
          />
        ))}
        {done.map((d) => (
          <li
            key={d.id}
            className="flex items-center gap-3.5 border-t border-border px-4 py-3 text-ink-faint"
          >
            <span
              aria-hidden
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-pill bg-primary text-white"
            >
              <Check className="h-3 w-3" strokeWidth={3} />
            </span>
            <span className="min-w-0 flex-1 truncate line-through">
              {d.href ? (
                <Link href={d.href} className="hover:text-ink-muted">
                  {d.title}
                </Link>
              ) : (
                d.title
              )}
            </span>
            <span className="sr-only">Hecho por Cortex</span>
            {d.timeLabel && <span className="shrink-0 text-xs">{d.timeLabel}</span>}
          </li>
        ))}
      </ul>
      {snoozed > 0 && todos.length + done.length > 0 && (
        <p className="flex items-center gap-1.5 px-4 pt-2 text-xs text-ink-faint">
          <AlarmClock className="h-3.5 w-3.5" aria-hidden />
          {snoozed} {snoozed === 1 ? 'pospuesta' : 'pospuestas'}:{' '}
          {snoozed === 1 ? 'vuelve' : 'vuelven'} solas a la hora que elegiste.
        </p>
      )}
      {more > 0 && (
        <p className="px-4 pt-2 text-sm text-ink-muted">
          Y {more} más.{' '}
          {moreHref && (
            <Link href={moreHref} className="font-semibold text-primary-ink hover:underline">
              Verlas todas
            </Link>
          )}
        </p>
      )}
    </section>
  );
}

function Hint({ k, text }: { k: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <kbd className="rounded-sm border border-border bg-surface px-1.5 py-px font-mono text-micro text-ink-muted">
        {k}
      </kbd>
      {text}
    </span>
  );
}

function Todo({
  t,
  first,
  active,
  canDecide,
  decide,
  snooze,
}: {
  t: TodoView;
  first: boolean;
  active: boolean;
  canDecide: boolean;
  decide: DecideFn;
  snooze?: SnoozeFn;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [which, setWhich] = useState<'approve' | 'dismiss' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (decision: 'approve' | 'dismiss') => {
    if (!t.decide) return;
    setWhich(decision);
    start(async () => {
      const r = await decide({
        itemId: t.decide?.itemId ?? '',
        decision,
        contentHash: t.decide?.contentHash ?? '',
      });
      setNote({ ok: r.ok, text: r.note });
      if (r.ok) router.refresh();
    });
  };
  const open = Boolean(t.preview);
  const [snoozeMenu, setSnoozeMenu] = useState(false);
  const postpone = (choice: SnoozeChoice) => {
    if (!snooze) return;
    setSnoozeMenu(false);
    setWhich(null);
    start(async () => {
      const r = await snooze({ key: t.id, choice, title: t.title });
      setNote({ ok: r.ok, text: r.note });
      if (r.ok) router.refresh();
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` se rehace en cada render y sólo lee `t`.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || pending) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (e.key === 'a' && t.decide && canDecide) run('approve');
      else if (e.key === 'x' && t.decide && canDecide) run('dismiss');
      else if (e.key === 'e' && t.href) router.push(t.href);
      else if (e.key === 'm' && snooze) postpone('tomorrow');
      else if (e.key === 'M' && snooze) postpone('next_week');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, pending, t, canDecide, router, snooze]);

  if (note?.ok)
    return (
      <li className="flex items-center gap-3.5 border-t border-border px-4 py-3 first:border-t-0">
        <span
          aria-hidden
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-pill bg-primary text-white"
        >
          <Check className="h-3 w-3" strokeWidth={3} />
        </span>
        <output className="text-sm font-semibold text-emerald">{note.text}</output>
      </li>
    );

  return (
    <li
      ref={(el) => {
        if (active) el?.scrollIntoView({ block: 'nearest' });
      }}
      aria-current={active ? 'true' : undefined}
      className={clsx(
        open
          ? 'rounded-card bg-surface-2/60 px-4 py-3.5 ring-1 ring-border'
          : `px-4 py-3.5 ${first ? '' : 'border-t border-border'}`,
        active && 'rounded-card bg-primary-soft/40 ring-2 ring-primary/50',
      )}
    >
      <div className="flex items-start gap-3.5">
        <span
          aria-hidden
          className="mt-0.5 h-5 w-5 shrink-0 rounded-pill border-[1.75px] border-border-strong"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
            <div className="min-w-0 flex-1">
              <p className="font-semibold leading-snug text-ink">{t.title}</p>
              {t.detail && (
                <p className="mt-0.5 text-[0.8125rem] leading-snug text-ink-faint">{t.detail}</p>
              )}
              {t.ageLabel && <p className="mt-0.5 text-xs text-ink-faint">{t.ageLabel}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {t.risk && <span className={chipClass(t.risk.tone)}>{t.risk.label}</span>}
              {t.badge && <span className={chipClass(t.badge.tone)}>{t.badge.label}</span>}
            </div>
          </div>

          {t.preview && (
            <blockquote className="font-display rounded-sm bg-surface px-3.5 py-3 text-base leading-relaxed text-ink-muted ring-1 ring-border">
              <span className="sr-only">
                Correo a {t.preview.to}, asunto {t.preview.subject}.{' '}
              </span>
              «
              {t.preview.body.length > 220
                ? `${t.preview.body.slice(0, 219).trimEnd()}…`
                : t.preview.body}
              »
            </blockquote>
          )}

          {(t.decide && canDecide) || t.href || snooze ? (
            <div className="flex flex-wrap items-center gap-2">
              {t.decide && canDecide && (
                <>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run('approve')}
                    className="cortex-primary-button inline-flex h-9 items-center gap-1.5 rounded-pill bg-primary px-4 text-[0.8125rem] font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
                  >
                    {pending && which === 'approve' && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    )}
                    {t.decide.approveLabel}
                  </button>
                  {t.href && (
                    <Link
                      href={t.href}
                      className="inline-flex h-9 items-center rounded-pill bg-surface-2 px-3.5 text-[0.8125rem] font-semibold text-ink hover:bg-border"
                    >
                      {t.hrefLabel}
                    </Link>
                  )}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run('dismiss')}
                    className="inline-flex h-9 items-center gap-1.5 rounded-pill px-3 text-[0.8125rem] font-semibold text-ink-faint hover:text-ink disabled:opacity-50"
                  >
                    {pending && which === 'dismiss' && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    )}
                    Descartar
                  </button>
                </>
              )}
              {snooze && (
                <span className="relative inline-flex">
                  <button
                    type="button"
                    disabled={pending}
                    aria-expanded={snoozeMenu}
                    aria-haspopup="true"
                    onClick={() => setSnoozeMenu((v) => !v)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-pill px-3 text-[0.8125rem] font-semibold text-ink-faint hover:text-ink disabled:opacity-50"
                  >
                    <AlarmClock className="h-3.5 w-3.5" aria-hidden />
                    Posponer
                  </button>
                  {snoozeMenu && (
                    <span
                      role="menu"
                      aria-label="Posponer hasta"
                      className="absolute left-0 top-full z-10 mt-1 flex min-w-[10rem] flex-col rounded-card border border-border bg-surface p-1 shadow-card"
                    >
                      {(['tomorrow', 'next_week'] as const).map((c) => (
                        <button
                          key={c}
                          type="button"
                          role="menuitem"
                          onClick={() => postpone(c)}
                          className="rounded-sm px-3 py-2 text-left text-[0.8125rem] font-semibold text-ink hover:bg-surface-2"
                        >
                          {SNOOZE_LABEL[c]}
                        </button>
                      ))}
                    </span>
                  )}
                </span>
              )}
              {!(t.decide && canDecide) && t.href && (
                <Link
                  href={t.href}
                  className="text-[0.8125rem] font-semibold text-primary-ink hover:underline"
                >
                  {t.decide ? 'Revisarlo (lo decide un administrador)' : t.hrefLabel}
                </Link>
              )}
            </div>
          ) : null}
          {note && !note.ok && (
            <p role="alert" className="text-xs font-semibold text-rose">
              {note.text}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
