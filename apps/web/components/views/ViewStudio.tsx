'use client';

import { saveViewAction } from '@/lib/views/actions';
import type { EditorDraft, NewTrackerDraft } from '@/lib/views/editor-spec';
import { STARTER_TEMPLATES, type StarterTemplate } from '@/lib/views/starter-templates';
import type { ComputedView, ViewSpec } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  Check,
  Inbox,
  Loader2,
  PencilRuler,
  Sparkles,
  SquareDashed,
  Table2,
  TrendingUp,
  Truck,
  Wallet,
  X,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { LiveViewCanvas } from './LiveViewCanvas';
import { PromptBar } from './PromptBar';
import { ViewCanvas } from './ViewCanvas';
import { type SaveOutcome, ViewEditor } from './editor/ViewEditor';
import { type DesignDraft, useDesigner } from './useDesigner';

/**
 * EL ESTUDIO: UNA VISTA, UNA CAJA PARA PEDIRLE CAMBIOS Y UN LIENZO.
 *
 * El mismo componente crea una vista nueva (/views) y cambia una existente
 * (/views/<slug>). Dos maneras de cambiarla, que se mezclan:
 *
 *   - HABLANDO: lo que se escribe va a /api/views/design, que devuelve un
 *     BORRADOR con su vista previa ya calculada con los datos de verdad.
 *     Mientras hay borrador, se ve el borrador con un aviso arriba que dice qué
 *     cambió, y tres botones: guardar, descartar o seguir en el lienzo.
 *   - CON LAS MANOS: «Editar» (en la barra de la vista, `?editar=1`) abre el
 *     lienzo (components/views/editor): arrastrar, ensanchar, elegir fuentes y
 *     campos en menús. La caja de Cortex sigue ahí y cambia ese borrador.
 *
 * Nada se guarda sin el clic. Guardar crea una versión; la anterior queda en
 * el historial y se restaura desde ahí. Si alguien guardó mientras tanto, el
 * guardado choca (`expectedVersion`) y lo dice en vez de pisar su cambio.
 *
 * Vacío, en /views, ofrece plantillas: dos ya armadas sobre datos de Cortex
 * que abren directo en el lienzo, dos que se le piden a Cortex porque
 * dependen de las tablas de cada empresa, y un lienzo en blanco.
 */

type Draft = DesignDraft;

export interface StudioView {
  id: string;
  slug: string;
  version: number;
  name: string;
  description: string;
  spec: ViewSpec;
}

const STARTER_ICON = { truck: Truck, wallet: Wallet, trending: TrendingUp, inbox: Inbox } as const;

const BLANK: EditorDraft = {
  name: 'Vista nueva',
  description: '',
  newTrackers: [],
  spec: {
    version: 1,
    accent: 'primary',
    refreshSeconds: 30,
    editing: 'off',
    alerts: [],
    blocks: [
      {
        id: 'titulo',
        type: 'text',
        width: 'full',
        markdown: '## Vista nueva\n\nAgrega bloques con «Agregar bloque» y ajústalos a la derecha.',
      },
    ],
  },
};

export function ViewStudio({
  view,
  initial,
  suggestions = [],
}: {
  view?: StudioView;
  initial?: ComputedView;
  suggestions?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [prompt, setPrompt] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<ComputedView | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | null>(view?.version ?? null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  /** El lienzo abierto sin `?editar=1`: un borrador nuevo o una plantilla. */
  const [canvas, setCanvas] = useState<{ draft: EditorDraft; explanation: string | null } | null>(
    null,
  );
  const designer = useDesigner(view?.id);
  const input = useRef<HTMLTextAreaElement>(null);

  const wantsEdit = Boolean(view) && params.get('editar') === '1';

  async function design(text: string) {
    const ready = await designer.design(
      text,
      draft
        ? {
            name: draft.name,
            description: draft.description,
            spec: draft.spec,
            newTrackers: draft.newTrackers,
          }
        : undefined,
    );
    if (!ready) return;
    setDraft(ready.draft);
    setPreview(ready.preview);
    if (!draft) setBaseVersion(ready.baseVersion);
    setHistory((h) => [...h, text.trim()]);
    setPrompt('');
  }

  function reset() {
    setDraft(null);
    setPreview(null);
    setHistory([]);
    setCanvas(null);
    setSaveError(null);
    designer.clear();
  }

  function leaveEditor() {
    setCanvas(null);
    if (wantsEdit) router.replace(pathname, { scroll: false });
  }

  async function persist(
    d: { name: string; description: string; spec: unknown; newTrackers: NewTrackerDraft[] },
    prompts: string[],
  ): Promise<SaveOutcome> {
    const res = await saveViewAction({
      viewId: view?.id,
      expectedVersion: view ? (baseVersion ?? undefined) : undefined,
      name: d.name,
      description: d.description,
      spec: d.spec,
      newTrackers: d.newTrackers,
      prompt: prompts.join(' → ').slice(0, 2000) || undefined,
    });
    if (!res.ok) return res;
    reset();
    if (!view || res.slug !== view.slug) router.push(`/views/${res.slug}`);
    else {
      setBaseVersion(res.version);
      if (wantsEdit) router.replace(pathname, { scroll: false });
      router.refresh();
    }
    return { ok: true };
  }

  function saveDraft() {
    if (!draft) return;
    setSaveError(null);
    startSave(async () => {
      const res = await persist(draft, history);
      if (!res.ok) setSaveError(res.error);
    });
  }

  function openTemplate(t: StarterTemplate) {
    if (t.kind === 'spec') {
      setCanvas({
        draft: { name: t.name, description: t.description, spec: t.spec, newTrackers: [] },
        explanation: `Plantilla «${t.title}» con datos reales de Cortex. Ajústala y guárdala cuando te sirva.`,
      });
      return;
    }
    setPrompt(t.prompt);
    void design(t.prompt);
  }

  // ---- El lienzo ------------------------------------------------------------

  const editorDraft: EditorDraft | null = canvas
    ? canvas.draft
    : wantsEdit && view
      ? draft
        ? {
            name: draft.name,
            description: draft.description,
            spec: draft.spec as ViewSpec,
            newTrackers: draft.newTrackers,
          }
        : { name: view.name, description: view.description, spec: view.spec, newTrackers: [] }
      : null;

  if (editorDraft) {
    return (
      <ViewEditor
        initial={editorDraft}
        initialPreview={
          canvas
            ? canvas.draft.spec === draft?.spec
              ? preview
              : null
            : (preview ?? initial ?? null)
        }
        viewId={view?.id}
        isNew={!view}
        explanation={canvas?.explanation ?? draft?.explanation ?? null}
        onSave={(d, prompts) => persist(d, [...history, ...prompts])}
        onCancel={() => {
          reset();
          leaveEditor();
        }}
      />
    );
  }

  // ---- La vista (o el borrador de Cortex) -----------------------------------

  const shown = preview ?? initial ?? null;
  const error = saveError ?? designer.error;

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
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={reset}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <X className="h-3.5 w-3.5" /> Descartar
              </button>
              <button
                type="button"
                onClick={() =>
                  setCanvas({
                    draft: {
                      name: draft.name,
                      description: draft.description,
                      spec: draft.spec as ViewSpec,
                      newTrackers: draft.newTrackers,
                    },
                    explanation: draft.explanation || null,
                  })
                }
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2"
              >
                <PencilRuler className="h-3.5 w-3.5" /> Ajustar en el lienzo
              </button>
              <button
                type="button"
                onClick={saveDraft}
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
        <div
          className={clsx('transition-opacity duration-200', designer.designing && 'opacity-60')}
        >
          {view && !draft ? (
            <LiveViewCanvas
              initial={shown}
              target={{ kind: 'app', viewId: view.id }}
              dataUrl={`/api/views/${view.id}/data`}
            />
          ) : (
            <ViewCanvas view={shown} target={{ kind: 'preview' }} />
          )}
        </div>
      ) : (
        !designer.designing && (
          <StarterGallery
            suggestions={suggestions}
            onTemplate={openTemplate}
            onBlank={() => setCanvas({ draft: BLANK, explanation: null })}
            onSuggestion={(s) => {
              setPrompt(s);
              input.current?.focus();
            }}
          />
        )
      )}
      {designer.designing && !shown && (
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

      <PromptBar
        inputRef={input}
        value={prompt}
        onChange={setPrompt}
        onSubmit={() => void design(prompt)}
        busy={designer.designing}
        error={error}
        questions={designer.questions}
        placeholder={
          draft
            ? 'Sigue afinando el borrador…'
            : view
              ? 'Pídele un cambio a Cortex: «agrupa por ciudad», «agrega un formulario»…'
              : 'Describe la vista: «tablero de remates con el total por ciudad y los que vencen esta semana»'
        }
      />
    </div>
  );
}

/**
 * EL PRIMER CLIC. Una pantalla vacía es una invitación a actuar: cuatro
 * plantillas con nombre de lo que la gente hace (no de cómo está hecho), un
 * lienzo en blanco para quien prefiere armar a mano, y las frases sugeridas
 * a partir de las tablas que el espacio ya tiene.
 */
function StarterGallery({
  suggestions,
  onTemplate,
  onBlank,
  onSuggestion,
}: {
  suggestions: string[];
  onTemplate: (t: StarterTemplate) => void;
  onBlank: () => void;
  onSuggestion: (s: string) => void;
}) {
  return (
    <div className="rounded-card border border-dashed border-border-strong bg-surface/50 p-4 sm:p-6">
      <div className="max-w-2xl">
        <p className="text-base font-semibold text-ink">Empieza con una plantilla</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-muted">
          Ábrela, cámbiale lo que quieras en el lienzo y guárdala. También puedes describir la
          pantalla abajo y Cortex la arma con las tablas de tu empresa.
        </p>
      </div>
      <ul className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {STARTER_TEMPLATES.map((t) => {
          const Icon = STARTER_ICON[t.icon];
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onTemplate(t)}
                className="group flex h-full w-full items-start gap-3 rounded-card border border-border bg-surface p-3 text-left shadow-card transition-all duration-150 hover:-translate-y-px hover:border-primary/40 hover:shadow-pop sm:flex-col sm:gap-2 sm:p-4"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="flex min-w-0 flex-1 flex-col items-start gap-1 self-stretch sm:gap-2">
                  <span className="text-sm font-semibold text-ink group-hover:text-primary">
                    {t.title}
                  </span>
                  <span className="text-xs leading-relaxed text-ink-muted">{t.body}</span>
                  <span
                    className={clsx(
                      'mt-auto inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-micro font-semibold',
                      t.kind === 'spec'
                        ? 'bg-emerald-soft text-emerald'
                        : 'bg-primary-soft text-primary',
                    )}
                  >
                    {t.kind === 'spec' ? (
                      <>
                        <Check className="h-3 w-3" aria-hidden /> Lista, con tus datos
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3 w-3" aria-hidden /> Cortex la arma
                      </>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={onBlank}
            className="group flex h-full w-full items-start gap-3 rounded-card border border-dashed border-border-strong bg-transparent p-3 text-left transition-all duration-150 hover:-translate-y-px hover:border-primary/50 hover:bg-primary-soft/20 sm:flex-col sm:gap-2 sm:p-4"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-surface-2 text-ink-muted group-hover:text-primary">
              <SquareDashed className="h-4 w-4" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-col gap-1 sm:gap-2">
              <span className="text-sm font-semibold text-ink group-hover:text-primary">
                Lienzo en blanco
              </span>
              <span className="text-xs leading-relaxed text-ink-muted">
                Arma la vista bloque por bloque: cifras, tablas, gráficos y formularios.
              </span>
            </span>
          </button>
        </li>
      </ul>
      {suggestions.length > 0 && (
        <div className="mt-5">
          <p className="field-label mb-2">O pídesela a Cortex</p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSuggestion(s)}
                className="rounded-pill border border-border bg-surface px-3 py-1.5 text-left text-xs text-ink-muted shadow-card transition-all duration-150 hover:-translate-y-px hover:border-border-strong hover:text-ink"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
