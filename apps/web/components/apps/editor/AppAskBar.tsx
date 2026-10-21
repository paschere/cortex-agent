'use client';

import { saveViewAction } from '@/lib/views/actions';
import type { ViewSpec } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { ArrowUp, Check, Loader2, Minus, Pencil, Plus, Sparkles, Undo2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * «PÍDELE A CORTEX UN CAMBIO…» EN EL EDITOR DE LA APP.
 *
 * Una frase («en la atención, que se registren ahí mismo los equipos usados») se
 * manda con el contexto de la app y de la pantalla elegida a /api/apps/<id>/ask.
 * Vuelve una PROPUESTA con la comparación en español (bloques que se agregan,
 * quitan o cambian, listas de ítems, permisos de pantalla): nada se guarda hasta
 * «Aplicar», que guarda como una versión más de la pantalla (con la versión
 * esperada: si alguien guardó mientras tanto, choca en vez de pisar) y deja un
 * «Deshacer» que vuelve a guardar lo de antes. Es el mismo diseñador de las
 * vistas; los cambios de roles o de tablas se piden en el chat.
 */

interface Draft {
  name: string;
  description: string;
  spec: unknown;
  newTrackers: unknown[];
}
interface Proposal {
  viewId: string;
  baseVersion: number;
  explanation: string;
  lines: Array<{ kind: 'added' | 'removed' | 'changed'; text: string }>;
  newTrackers: Array<{ slug: string; name: string }>;
  draft: Draft;
  previous: { name: string; description: string; spec: unknown };
}
type Reply =
  | ({ status: 'ready' } & Proposal)
  | { status: 'needs_input'; explanation: string; questions: string[] }
  | { error: string };

const ICON = { added: Plus, removed: Minus, changed: Pencil } as const;
const TONE = {
  added: 'bg-emerald-soft text-emerald',
  removed: 'bg-rose-soft text-rose',
  changed: 'bg-amber-soft text-amber',
} as const;

export function AppAskBar({
  appId,
  screens,
  initialScreen,
}: {
  appId: string;
  screens: Array<{ slug: string; title: string }>;
  initialScreen?: string;
}) {
  const router = useRouter();
  const [screen, setScreen] = useState(initialScreen ?? screens[0]?.slug ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<{ explanation: string; items: string[] } | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<{
    version: number;
    previous: Proposal['previous'];
    viewId: string;
  } | null>(null);
  const [undone, setUndone] = useState(false);
  const title = screens.find((s) => s.slug === screen)?.title ?? '';

  async function ask() {
    const instruction = text.trim();
    if (instruction.length < 4 || busy || !screen) return;
    setBusy(true);
    setError(null);
    setQuestions(null);
    setProposal(null);
    setApplied(null);
    setUndone(false);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction, screen }),
      });
      const body = (await res.json().catch(() => ({ error: 'Respuesta inválida.' }))) as Reply;
      if ('error' in body) setError(body.error);
      else if (body.status === 'needs_input')
        setQuestions({ explanation: body.explanation, items: body.questions });
      else setProposal(body);
    } catch {
      setError('Sin conexión con Cortex. Inténtalo otra vez.');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!proposal || applying) return;
    setApplying(true);
    setError(null);
    const res = await saveViewAction({
      viewId: proposal.viewId,
      expectedVersion: proposal.baseVersion,
      name: proposal.draft.name,
      description: proposal.draft.description,
      spec: proposal.draft.spec,
      newTrackers: proposal.draft.newTrackers as never,
      prompt: text.trim().slice(0, 500),
    }).catch(() => ({ ok: false as const, error: 'Sin conexión. Inténtalo otra vez.' }));
    setApplying(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setApplied({ version: res.version, previous: proposal.previous, viewId: proposal.viewId });
    setProposal(null);
    setText('');
    router.refresh();
  }

  async function undo() {
    if (!applied || applying) return;
    setApplying(true);
    const res = await saveViewAction({
      viewId: applied.viewId,
      expectedVersion: applied.version,
      name: applied.previous.name,
      description: applied.previous.description,
      spec: applied.previous.spec as ViewSpec,
      newTrackers: [],
      prompt: 'Deshacer el cambio pedido a Cortex',
    }).catch(() => ({ ok: false as const, error: 'Sin conexión. Inténtalo otra vez.' }));
    setApplying(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setUndone(true);
    setApplied(null);
    router.refresh();
  }

  return (
    <div className="sticky bottom-0 z-30 mt-6 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
      <div className="mx-auto w-full max-w-3xl space-y-2">
        {error && (
          <p
            role="alert"
            className="rounded-card border border-rose/40 bg-surface px-4 py-3 text-sm text-rose shadow-pop"
          >
            {error}
          </p>
        )}
        {questions && (
          <div
            className="rounded-card border border-border bg-surface px-4 py-3 text-sm shadow-pop"
            aria-live="polite"
          >
            <p className="text-ink-muted">{questions.explanation}</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-ink">
              {questions.items.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </div>
        )}
        {proposal && (
          <section
            aria-label="Propuesta de Cortex"
            className="rounded-card border border-primary/40 bg-surface p-4 shadow-pop"
          >
            <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-field text-primary-ink">
              <Sparkles className="h-3.5 w-3.5" aria-hidden /> Propuesta para «{title}»
            </p>
            {proposal.explanation && (
              <p className="mt-1.5 text-sm text-ink">{proposal.explanation}</p>
            )}
            {proposal.lines.length > 0 ? (
              <ul className="mt-2.5 space-y-1.5">
                {proposal.lines.map((l) => {
                  const Icon = ICON[l.kind];
                  return (
                    <li key={l.text} className="flex items-start gap-2 text-sm text-ink">
                      <span
                        className={clsx(
                          'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-pill',
                          TONE[l.kind],
                        )}
                      >
                        <Icon className="h-3 w-3" aria-hidden />
                      </span>
                      <span className="min-w-0 [overflow-wrap:anywhere]">{l.text}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-ink-muted">
                No veo cambios con lo que ya está guardado.
              </p>
            )}
            {proposal.newTrackers.length > 0 && (
              <p className="mt-2 text-xs text-ink-muted">
                Tablas nuevas que se crean (si no existen):{' '}
                {proposal.newTrackers.map((t) => `«${t.name}»`).join(', ')}.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={applying || proposal.lines.length === 0}
                onClick={apply}
                className="cortex-primary-button inline-flex min-h-11 items-center gap-1.5 rounded-pill bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
              >
                {applying ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Check className="h-4 w-4" aria-hidden />
                )}
                Aplicar
              </button>
              <button
                type="button"
                onClick={() => setProposal(null)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-pill border border-border-strong px-4 text-sm font-semibold text-ink hover:bg-surface-2"
              >
                <X className="h-4 w-4" aria-hidden /> Descartar
              </button>
            </div>
          </section>
        )}
        {(applied || undone) && (
          <output className="flex flex-wrap items-center gap-3 rounded-card border border-emerald/30 bg-emerald-soft px-4 py-3 text-sm font-semibold text-emerald shadow-pop">
            <span className="inline-flex items-center gap-1.5">
              <Check className="h-4 w-4" aria-hidden />
              {undone ? 'Cambio deshecho.' : 'Cambio aplicado.'}
            </span>
            {applied && (
              <button
                type="button"
                disabled={applying}
                onClick={undo}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-pill border border-emerald/40 bg-surface px-3.5 text-xs font-semibold text-ink hover:bg-surface-2"
              >
                {applying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Undo2 className="h-3.5 w-3.5" aria-hidden />
                )}
                Deshacer
              </button>
            )}
          </output>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
          className="flex flex-wrap items-end gap-2 rounded-card border border-border-strong bg-surface p-2 shadow-pop"
        >
          <Sparkles className="mb-2.5 ml-2 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <textarea
            rows={1}
            value={text}
            aria-label="Pídele a Cortex un cambio"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
            maxLength={2000}
            placeholder="Pídele a Cortex un cambio…"
            className="max-h-40 min-h-[2.5rem] min-w-[10rem] flex-1 resize-none bg-transparent px-1 py-2 text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          {screens.length > 1 && (
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              <span className="sr-only sm:not-sr-only">En</span>
              <select
                aria-label="Pantalla a cambiar"
                value={screen}
                onChange={(e) => setScreen(e.target.value)}
                className="max-w-[10rem] rounded-sm border border-border-strong bg-surface px-2 py-1.5 text-xs text-ink"
              >
                {screens.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="submit"
            disabled={busy || text.trim().length < 4}
            aria-label="Enviar a Cortex"
            className="cortex-primary-button grid h-9 w-9 shrink-0 place-items-center rounded-pill bg-primary text-white transition-all duration-150 hover:bg-primary-strong disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}
