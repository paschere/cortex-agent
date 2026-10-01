'use client';

import { saveViewAction } from '@/lib/views/actions';
import type { EditorDraft, NewTrackerDraft } from '@/lib/views/editor-spec';
import type { ComputedView, ViewSpec } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Check, Loader2, PencilRuler, Sparkles, Table2, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { LiveViewCanvas } from './LiveViewCanvas';
import { PromptBar } from './PromptBar';
import { ViewCanvas } from './ViewCanvas';
import type { ToolbarView } from './ViewToolbar';
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
 * EL ESTUDIO (el lienzo) es pantalla completa y guardar NO lo cierra: se
 * sigue editando, y «Guardado» lo dice arriba. Una vista nueva, al guardarse
 * por primera vez, pasa a su dirección (/views/<slug>?editar=1) para que
 * recargar la página no la pierda.
 *
 * Una vista nueva entra por `launch` desde /views (la galería de «Nueva
 * vista»: una plantilla ya armada, una que Cortex arma con `autoPrompt`, o el
 * lienzo en blanco). Sin vista y sin `launch` no se pinta nada.
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

/** Cómo abre el estudio una vista nueva desde /views. */
export interface StudioLaunch {
  draft: EditorDraft;
  explanation?: string | null;
  /** Una frase que se le manda a Cortex apenas abre. */
  autoPrompt?: string | null;
}

export const BLANK: EditorDraft = {
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
        markdown: 'Una línea que explique para qué sirve esta vista y quién la mira.',
      },
    ],
  },
};

export function ViewStudio({
  view,
  initial,
  share = null,
  launch = null,
  onExit,
}: {
  view?: StudioView;
  initial?: ComputedView;
  /** Lo que necesita «Compartir» dentro del estudio (sólo una vista guardada). */
  share?: ToolbarView | null;
  launch?: StudioLaunch | null;
  /** Cerrar el estudio de una vista nueva (vuelve a /views). */
  onExit?: () => void;
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

  /** Guardó algo mientras el estudio estaba abierto: al salir hay que releer la vista. */
  const savedInStudio = useRef(false);

  function leaveEditor() {
    setCanvas(null);
    if (wantsEdit) router.replace(pathname, { scroll: false });
    if (savedInStudio.current) router.refresh();
    if (!view) onExit?.();
  }

  async function persist(
    d: { name: string; description: string; spec: unknown; newTrackers: NewTrackerDraft[] },
    prompts: string[],
    options: { stay?: boolean } = {},
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
    if (options.stay) {
      // El estudio sigue abierto: sólo cambia la versión sobre la que se guarda.
      setBaseVersion(res.version);
      setHistory([]);
      savedInStudio.current = true;
      if (!view || res.slug !== view.slug)
        router.replace(`/views/${res.slug}?editar=1`, { scroll: false });
      return { ok: true };
    }
    reset();
    if (!view || res.slug !== view.slug) router.push(`/views/${res.slug}`);
    else {
      setBaseVersion(res.version);
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

  // ---- El lienzo ------------------------------------------------------------

  const editorDraft: EditorDraft | null = canvas
    ? canvas.draft
    : !view && launch
      ? launch.draft
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
        version={view ? baseVersion : null}
        isNew={!view}
        share={share}
        autoPrompt={!view && !canvas ? (launch?.autoPrompt ?? null) : null}
        explanation={canvas?.explanation ?? draft?.explanation ?? launch?.explanation ?? null}
        onSave={(d, prompts) => persist(d, [...history, ...prompts], { stay: true })}
        onCancel={() => {
          reset();
          leaveEditor();
        }}
      />
    );
  }

  // ---- La vista (o el borrador de Cortex) -----------------------------------

  // Una vista nueva sólo existe dentro del estudio (ver `launch`).
  if (!view) return null;

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

      {shown && (
        <div
          className={clsx('transition-opacity duration-200', designer.designing && 'opacity-60')}
        >
          {!draft ? (
            <LiveViewCanvas
              initial={shown}
              target={{ kind: 'app', viewId: view.id }}
              dataUrl={`/api/views/${view.id}/data`}
              heading={{ title: view.name, subtitle: view.spec.subtitle ?? view.description }}
            />
          ) : (
            <ViewCanvas view={shown} target={{ kind: 'preview' }} />
          )}
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
            : 'Pídele un cambio a Cortex: «agrupa por ciudad», «agrega un formulario»…'
        }
      />
    </div>
  );
}
