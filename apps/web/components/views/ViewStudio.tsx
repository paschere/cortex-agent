'use client';

import { saveViewAction } from '@/lib/views/actions';
import type { ComputedView, TrackerField } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { ArrowUp, Check, Loader2, Sparkles, Table2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { ViewCanvas } from './ViewCanvas';

/**
 * EL ESTUDIO: UNA VISTA Y UNA CAJA PARA PEDIRLE CAMBIOS.
 *
 * El mismo componente crea una vista nueva (/views) y cambia una existente
 * (/views/<slug>). Lo que se escribe va a /api/views/design, que devuelve un
 * BORRADOR con su vista previa ya calculada con los datos de verdad. Mientras
 * hay borrador, el lienzo muestra el borrador — con un aviso arriba que dice
 * qué cambió y qué tablas nuevas crearía — y dos botones: guardar o descartar.
 * Se puede seguir afinando el borrador con otra frase antes de guardar.
 *
 * Nada se guarda sin el clic. Guardar crea una versión; la versión anterior
 * queda en el historial y se restaura desde ahí.
 */

interface NewTrackerDraft {
  slug: string;
  name: string;
  description: string;
  fields: TrackerField[];
}

interface Draft {
  name: string;
  description: string;
  explanation: string;
  spec: unknown;
  newTrackers: NewTrackerDraft[];
}

type DesignResponse =
  | { status: 'ready'; draft: Draft; preview: ComputedView; baseVersion: number | null }
  | { status: 'needs_input'; explanation: string; questions: string[] }
  | { error: string };

export function ViewStudio({
  view,
  initial,
  suggestions = [],
}: {
  view?: { id: string; slug: string; version: number };
  initial?: ComputedView;
  suggestions?: string[];
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<ComputedView | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | null>(view?.version ?? null);
  const [questions, setQuestions] = useState<{ explanation: string; items: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [designing, setDesigning] = useState(false);
  const [saving, startSave] = useTransition();
  const input = useRef<HTMLTextAreaElement>(null);

  async function design(text: string) {
    const ask = text.trim();
    if (ask.length < 4 || designing) return;
    setDesigning(true);
    setError(null);
    setQuestions(null);
    try {
      const res = await fetch('/api/views/design', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: ask,
          viewId: view?.id,
          draft: draft
            ? {
                name: draft.name,
                description: draft.description,
                spec: draft.spec,
                newTrackers: draft.newTrackers,
              }
            : undefined,
        }),
      });
      const body = (await res
        .json()
        .catch(() => ({ error: 'Respuesta inválida.' }))) as DesignResponse;
      if ('error' in body) setError(body.error);
      else if (body.status === 'needs_input')
        setQuestions({ explanation: body.explanation, items: body.questions });
      else {
        setDraft(body.draft);
        setPreview(body.preview);
        if (!draft) setBaseVersion(body.baseVersion);
        setHistory((h) => [...h, ask]);
        setPrompt('');
      }
    } catch {
      setError('Sin conexión con Cortex. Inténtalo otra vez.');
    } finally {
      setDesigning(false);
    }
  }

  function save() {
    if (!draft) return;
    startSave(async () => {
      const res = await saveViewAction({
        viewId: view?.id,
        expectedVersion: view ? (baseVersion ?? undefined) : undefined,
        name: draft.name,
        description: draft.description,
        spec: draft.spec,
        newTrackers: draft.newTrackers,
        prompt: history.join(' → ').slice(0, 2000),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDraft(null);
      setPreview(null);
      setHistory([]);
      if (!view || res.slug !== view.slug) router.push(`/views/${res.slug}`);
      else {
        setBaseVersion(res.version);
        router.refresh();
      }
    });
  }

  function discard() {
    setDraft(null);
    setPreview(null);
    setHistory([]);
    setError(null);
    setBaseVersion(view?.version ?? null);
  }

  const shown = preview ?? initial ?? null;

  return (
    <div>
      {draft && (
        <div className="mb-5 rounded-card border border-primary/30 bg-primary-soft/50 p-4 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 max-w-2xl">
              <p className="flex items-center gap-1.5 text-micro font-semibold uppercase tracking-field text-primary">
                <Sparkles className="h-3.5 w-3.5" /> Borrador · {draft.name}
              </p>
              {draft.explanation && (
                <p className="mt-1.5 text-sm leading-relaxed text-ink">{draft.explanation}</p>
              )}
              {draft.newTrackers.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {draft.newTrackers.map((t) => (
                    <li key={t.slug} className="flex items-start gap-1.5 text-xs text-ink-muted">
                      <Table2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald" />
                      <span>
                        Al guardar se crea la tabla <strong className="text-ink">{t.name}</strong>{' '}
                        con {t.fields.map((f) => f.label).join(', ')}.
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={discard}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <X className="h-3.5 w-3.5" /> Descartar
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="cortex-primary-button inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-1.5 text-xs font-semibold text-white transition-all duration-150 hover:bg-primary-strong disabled:opacity-45"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                {view ? 'Guardar cambios' : 'Crear vista'}
              </button>
            </div>
          </div>
        </div>
      )}

      {shown ? (
        <div className={clsx('transition-opacity duration-200', designing && 'opacity-60')}>
          <ViewCanvas
            view={shown}
            target={draft || !view ? { kind: 'preview' } : { kind: 'app', viewId: view.id }}
          />
        </div>
      ) : (
        !designing && (
          <div className="rounded-card border border-dashed border-border-strong bg-surface/60 px-6 py-10 text-center">
            <p className="text-base font-semibold text-ink">Describe la pantalla que necesitas</p>
            <p className="mx-auto mt-1.5 max-w-lg text-sm leading-relaxed text-ink-muted">
              Cortex la arma con las tablas de tu empresa: cifras, gráficos, tableros por estado,
              listas con buscador y formularios. Si falta una tabla, la propone. Ves el resultado
              antes de guardarlo.
            </p>
            {suggestions.length > 0 && (
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setPrompt(s);
                      input.current?.focus();
                    }}
                    className="rounded-pill border border-border bg-surface px-3 py-1.5 text-xs text-ink-muted shadow-card transition-all duration-150 hover:-translate-y-px hover:border-border-strong hover:text-ink"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      )}
      {designing && !shown && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-6" aria-hidden>
          {[
            'md:col-span-2',
            'md:col-span-2',
            'md:col-span-2',
            'md:col-span-3',
            'md:col-span-3',
            'md:col-span-6',
          ].map((span, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: esqueleto fijo.
              key={i}
              className={clsx(
                'h-32 animate-pulse rounded-card bg-surface-2',
                span,
                i === 5 && 'h-56',
              )}
            />
          ))}
        </div>
      )}

      {/* Pegada al fondo del área que hace scroll, no `fixed`: así respeta el
          ancho del rail y del panel lateral sin saber cuánto miden. */}
      <div className="sticky bottom-0 z-30 mt-6 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
        <div className="mx-auto w-full max-w-3xl">
          {(error || questions) && (
            <div
              aria-live="polite"
              className={clsx(
                'mb-2 rounded-card border px-4 py-3 text-sm shadow-pop',
                error ? 'border-rose/40 bg-surface text-rose' : 'border-border bg-surface text-ink',
              )}
            >
              {error ?? (
                <>
                  <p className="text-ink-muted">{questions?.explanation}</p>
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                    {questions?.items.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void design(prompt);
            }}
            className="flex items-end gap-2 rounded-card border border-border-strong bg-surface p-2 shadow-pop"
          >
            <Sparkles className="mb-2.5 ml-2 h-4 w-4 shrink-0 text-primary" />
            <textarea
              ref={input}
              rows={1}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void design(prompt);
                }
              }}
              maxLength={4000}
              placeholder={
                draft
                  ? 'Sigue afinando el borrador…'
                  : view
                    ? 'Pídele un cambio a Cortex: «agrupa por ciudad», «agrega un formulario»…'
                    : 'Describe la vista: «tablero de remates con el total por ciudad y los que vencen esta semana»'
              }
              className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent px-1 py-2 text-sm text-ink outline-none placeholder:text-ink-faint"
            />
            <button
              type="submit"
              disabled={designing || prompt.trim().length < 4}
              aria-label="Enviar a Cortex"
              className="cortex-primary-button grid h-9 w-9 shrink-0 place-items-center rounded-pill bg-primary text-white transition-all duration-150 hover:bg-primary-strong disabled:opacity-40"
            >
              {designing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
