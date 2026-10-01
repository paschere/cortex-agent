'use client';

import { BLOCK_LABEL } from '@/lib/views/editor-shape';
import {
  type EditorCatalog,
  type EditorDraft,
  type EditorProblem,
  type PaletteType,
  canAddBlock,
  duplicateBlock,
  insertBlock,
  moveBlock,
  newBlock,
  problemsByBlock,
  removeBlock,
  sourceOf,
  titleOf,
  updateBlock,
  withDraftSources,
} from '@/lib/views/editor-spec';
import type { ComputedBlock, ComputedView, ViewSpec } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  PencilRuler,
  Plus,
  Redo2,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PromptBar } from '../PromptBar';
import { useDesigner } from '../useDesigner';
import { AddBlockPalette } from './AddBlockPalette';
import { BlockInspector } from './BlockInspector';
import { EditorCanvas } from './EditorCanvas';
import { InspectorPanel } from './InspectorPanel';
import { ViewSettings } from './ViewSettings';
import { useEditorServices } from './services';

/**
 * EL LIENZO: EDITAR UNA VISTA CON LAS MANOS.
 *
 * Hasta aquí una vista sólo cambiaba escribiéndole a Cortex. Eso sirve para
 * «arma un tablero de cartera», no para «este gráfico un poco más ancho» o
 * «quita ese filtro»: para eso está el lienzo. Cada bloque se arrastra, se
 * ensancha, se duplica o se borra; al elegirlo, el inspector muestra sus
 * propiedades con controles de verdad. La caja de Cortex sigue abajo y cambia
 * ESTE borrador, así que se puede mezclar: pedir un tablero hablando y
 * acomodarlo a mano.
 *
 * LO QUE NO HACE. No guarda nada solo. Todo cambio es local hasta «Guardar»,
 * que pasa por `saveViewAction` —el mismo contrato, el mismo catálogo, una
 * versión nueva en el historial y el mismo conflicto si alguien guardó
 * mientras tanto—. «Cancelar» lo bota todo.
 *
 * LA VISTA PREVIA es de verdad: cada cambio (450 ms después del último) va a
 * /api/views/preview, que comprueba el spec como lo comprobaría el guardado y
 * lo calcula con las filas reales. Los problemas vuelven atados a su bloque y
 * se pintan en su marco y en su inspector; «Guardar» espera a que no quede
 * ninguno. Mientras tanto se ve el último cálculo bueno, atenuado.
 *
 * DESHACER guarda specs enteros (hasta 60). Las teclas de un mismo campo de
 * texto se agrupan en un solo paso, si no deshacer un título sería deshacerlo
 * letra por letra. Borrar un bloque además ofrece «Deshacer» en un aviso.
 */

const PREVIEW_DELAY = 450;
const HISTORY = 60;
const COALESCE_MS = 1200;

export type SaveOutcome = { ok: true } | { ok: false; error: string };

interface History {
  draft: EditorDraft;
  past: EditorDraft[];
  future: EditorDraft[];
  lastKey: string | null;
  lastAt: number;
}

interface Toast {
  id: number;
  message: string;
  restore?: EditorDraft;
}

export function ViewEditor({
  initial,
  initialPreview,
  viewId,
  isNew,
  explanation,
  onSave,
  onCancel,
}: {
  initial: EditorDraft;
  initialPreview: ComputedView | null;
  viewId?: string;
  isNew: boolean;
  /** Lo que Cortex dijo de un borrador que llega al lienzo desde una frase. */
  explanation?: string | null;
  onSave: (draft: EditorDraft, prompts: string[]) => Promise<SaveOutcome>;
  onCancel: () => void;
}) {
  const services = useEditorServices();
  const [history, setHistory] = useState<History>({
    draft: initial,
    past: [],
    future: [],
    lastKey: null,
    lastAt: 0,
  });
  const draft = history.draft;
  const spec = draft.spec;

  const [catalog, setCatalog] = useState<EditorCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ComputedView | null>(initialPreview);
  const [problems, setProblems] = useState<EditorProblem[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'block' | 'view'>('view');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(explanation ?? null);
  const [announcement, setAnnouncement] = useState('');
  const [prompt, setPrompt] = useState('');
  const [prompts, setPrompts] = useState<string[]>([]);
  const designer = useDesigner(viewId);
  const initialJson = useRef(JSON.stringify(initial));
  /** El spec que produjo la vista previa que se está mostrando. */
  const previewedJson = useRef(initialPreview ? JSON.stringify(initial.spec) : '');

  const sources = useMemo(() => withDraftSources(catalog, draft), [catalog, draft]);
  const dirty = JSON.stringify(draft) !== initialJson.current;

  // ---- Cambios y deshacer -------------------------------------------------

  const commit = useCallback((next: EditorDraft, coalesce?: string) => {
    setHistory((h) => {
      const now = Date.now();
      const merge = Boolean(coalesce) && coalesce === h.lastKey && now - h.lastAt < COALESCE_MS;
      return {
        draft: next,
        past: merge ? h.past : [...h.past, h.draft].slice(-HISTORY),
        future: [],
        lastKey: coalesce ?? null,
        lastAt: now,
      };
    });
  }, []);
  const setSpec = useCallback(
    (next: ViewSpec, coalesce?: string) => commit({ ...draft, spec: next }, coalesce),
    [commit, draft],
  );
  const undo = useCallback(() => {
    setHistory((h) => {
      const prev = h.past.at(-1);
      if (!prev) return h;
      return {
        draft: prev,
        past: h.past.slice(0, -1),
        future: [h.draft, ...h.future],
        lastKey: null,
        lastAt: 0,
      };
    });
  }, []);
  const redo = useCallback(() => {
    setHistory((h) => {
      const [next, ...rest] = h.future;
      if (!next) return h;
      return { draft: next, past: [...h.past, h.draft], future: rest, lastKey: null, lastAt: 0 };
    });
  }, []);

  // ---- Catálogo y vista previa -------------------------------------------

  useEffect(() => {
    let alive = true;
    services
      .loadCatalog(viewId)
      .then((c) => alive && setCatalog(c))
      .catch(
        (err: unknown) =>
          alive &&
          setCatalogError(err instanceof Error ? err.message : 'No se pudieron leer las tablas.'),
      );
    return () => {
      alive = false;
    };
  }, [services, viewId]);

  const specJson = JSON.stringify(spec);
  const trackersJson = JSON.stringify(draft.newTrackers);
  useEffect(() => {
    if (specJson === previewedJson.current) {
      // Deshacer hasta lo último calculado: la vista previa ya es ésa.
      setPreviewing(false);
      return;
    }
    const controller = new AbortController();
    setPreviewing(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await services.preview(
          { spec: JSON.parse(specJson), viewId, newTrackers: JSON.parse(trackersJson) },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (result.ok) {
          if (result.view) setPreview(result.view);
          setProblems(result.problems);
          setPreviewError(null);
          previewedJson.current = specJson;
        } else setPreviewError(result.error);
      } catch {
        /* Abortada por un cambio más nuevo: ése trae su propia vista previa. */
      } finally {
        if (!controller.signal.aborted) setPreviewing(false);
      }
    }, PREVIEW_DELAY);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [specJson, trackersJson, services, viewId]);

  const computed = useMemo(() => {
    const map = new Map<string, ComputedBlock>();
    for (const b of preview?.blocks ?? []) map.set(b.id, b);
    return map;
  }, [preview]);
  const byBlock = useMemo(() => problemsByBlock(problems), [problems]);
  const viewProblems = problems.filter((p) => !p.blockId);

  // ---- Teclado y salida sin guardar --------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el?.closest('input, textarea, select, [contenteditable="true"]');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key === 'Escape' && sheetOpen && !paletteOpen) {
        setSheetOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, sheetOpen, paletteOpen]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 7000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // ---- Acciones del lienzo ------------------------------------------------

  const selectedIndex = spec.blocks.findIndex((b) => b.id === selectedId);
  const selected = spec.blocks[selectedIndex] ?? null;

  function moveSelected(step: number) {
    const to = selectedIndex + step;
    if (selectedIndex < 0 || to < 0 || to >= spec.blocks.length) return;
    setSpec(moveBlock(spec, selectedIndex, to));
    setAnnouncement(`Movido a la posición ${to + 1} de ${spec.blocks.length}.`);
  }

  function duplicate(id: string) {
    const res = duplicateBlock(spec, id);
    if (!res.id) return;
    setSpec(res.spec);
    select(res.id);
  }

  function select(id: string) {
    setSelectedId(id);
    setTab('block');
    setSheetOpen(true);
  }

  function addBlock(type: PaletteType) {
    const block = newBlock(type, spec, sources, selected ? sourceOf(selected) : null);
    setPaletteOpen(false);
    if (!block) return;
    setSpec(insertBlock(spec, block, selectedId));
    select(block.id);
    setAnnouncement(`${BLOCK_LABEL[type] ?? 'Bloque'} agregado.`);
    // Que se vea dónde quedó.
    window.requestAnimationFrame(() =>
      document
        .querySelector(`[data-block-id="${CSS.escape(block.id)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    );
  }

  function remove(id: string) {
    const before = draft;
    const res = removeBlock(spec, id);
    if (!res.removed) return;
    setSpec(res.spec);
    if (selectedId === id) {
      setSelectedId(null);
      setSheetOpen(false);
    }
    setToast({
      id: Date.now(),
      message: `Eliminaste «${titleOf(res.removed)}».`,
      restore: before,
    });
  }

  async function askCortex() {
    const text = prompt.trim();
    const ready = await designer.design(text, {
      name: draft.name,
      description: draft.description,
      spec: draft.spec,
      newTrackers: draft.newTrackers,
    });
    if (!ready) return;
    commit({
      name: ready.draft.name,
      description: ready.draft.description,
      spec: ready.draft.spec as ViewSpec,
      newTrackers: ready.draft.newTrackers,
    });
    // El diseñador ya la calculó: no hace falta pedirla otra vez.
    previewedJson.current = JSON.stringify(ready.draft.spec);
    setPreview(ready.preview);
    setProblems([]);
    setNote(ready.draft.explanation || null);
    setPrompts((p) => [...p, text]);
    setPrompt('');
    if (selectedId && !(ready.draft.spec as ViewSpec).blocks.some((b) => b.id === selectedId))
      setSelectedId(null);
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    const res = await onSave(draft, prompts.length ? prompts : ['Editada en el lienzo']);
    setSaving(false);
    if (!res.ok) setSaveError(res.error);
    else initialJson.current = JSON.stringify(draft);
  }

  function cancel() {
    if (dirty && !window.confirm('¿Descartar los cambios sin guardar?')) return;
    onCancel();
  }

  const blocking = problems.length;
  const canSave = !saving && !previewing && blocking === 0 && (dirty || isNew);

  return (
    <div className="relative">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {/* La barra del lienzo: pegada arriba mientras se baja por la vista. */}
      <div className="sticky top-0 z-30 -mx-4 mb-4 border-b border-border bg-canvas/85 px-4 py-2.5 backdrop-blur-md md:-mx-8 md:px-8">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-pill bg-primary-soft px-2.5 py-1 text-micro font-semibold text-primary">
            <PencilRuler className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only sm:not-sr-only">Editando</span>
          </span>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            disabled={!canAddBlock(spec)}
            className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2 disabled:opacity-45"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>
              Agregar<span className="hidden sm:inline"> bloque</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('view');
              setSheetOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2"
            aria-label="Ajustes de la vista"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Ajustes de la vista</span>
          </button>
          <div className="flex items-center">
            <button
              type="button"
              onClick={undo}
              disabled={!history.past.length}
              aria-label="Deshacer"
              title="Deshacer (⌘Z)"
              className="grid h-8 w-8 place-items-center rounded-pill text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-35"
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!history.future.length}
              aria-label="Rehacer"
              title="Rehacer (⇧⌘Z)"
              className="grid h-8 w-8 place-items-center rounded-pill text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-35"
            >
              <Redo2 className="h-4 w-4" />
            </button>
          </div>
          <span className="min-w-0 flex-1 truncate text-micro text-ink-faint" aria-live="polite">
            {previewing ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Calculando…
              </span>
            ) : blocking ? (
              <span className="inline-flex items-center gap-1 text-amber">
                <AlertTriangle className="h-3 w-3" aria-hidden />
                {blocking === 1 ? '1 cosa por corregir' : `${blocking} cosas por corregir`}
              </span>
            ) : previewError ? (
              <span className="text-amber">{previewError}</span>
            ) : dirty ? (
              'Cambios sin guardar'
            ) : isNew ? (
              'Todavía no está guardada'
            ) : (
              'Sin cambios'
            )}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-pill px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" /> Cancelar
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!canSave}
              title={blocking ? 'Corrige lo marcado en amarillo para guardar' : undefined}
              className="cortex-primary-button inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-1.5 text-xs font-semibold text-white transition-all duration-150 hover:bg-primary-strong disabled:opacity-45"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              {isNew ? 'Crear vista' : 'Guardar'}
            </button>
          </div>
        </div>
        {saveError && (
          <p role="alert" className="mt-2 text-xs text-rose">
            {saveError}
          </p>
        )}
      </div>

      {(note || catalogError || draft.newTrackers.length > 0) && (
        <div className="mb-4 space-y-1.5 rounded-card border border-primary/30 bg-primary-soft/40 px-4 py-3 text-sm">
          {note && (
            <p className="flex gap-2 leading-relaxed text-ink">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span>{note}</span>
            </p>
          )}
          {draft.newTrackers.map((t) => (
            <p key={t.slug} className="text-xs text-ink-muted">
              Al guardar se crea la tabla <strong className="text-ink">{t.name}</strong> con{' '}
              {t.fields.map((f) => f.label).join(', ')}.
            </p>
          ))}
          {catalogError && <p className="text-xs text-rose">{catalogError}</p>}
        </div>
      )}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
        <div className="min-w-0">
          {viewProblems.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setTab('view');
                setSheetOpen(true);
              }}
              className="mb-4 flex w-full items-start gap-2 rounded-card border border-amber/40 bg-amber-soft px-4 py-3 text-left text-xs leading-relaxed text-ink"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
              <span>{viewProblems[0]?.message}</span>
            </button>
          )}
          <EditorCanvas
            spec={spec}
            computed={computed}
            problems={byBlock}
            selectedId={selectedId}
            stale={previewing}
            canAdd={canAddBlock(spec)}
            onSelect={select}
            onMove={(from, to) => setSpec(moveBlock(spec, from, to))}
            onWidth={(id, width) => {
              const block = spec.blocks.find((b) => b.id === id);
              if (block) setSpec(updateBlock(spec, id, { ...block, width }));
            }}
            onDuplicate={duplicate}
            onRemove={remove}
            onAdd={() => setPaletteOpen(true)}
            announce={setAnnouncement}
          />
          <PromptBar
            value={prompt}
            onChange={setPrompt}
            onSubmit={() => void askCortex()}
            busy={designer.designing}
            error={designer.error}
            questions={designer.questions}
            placeholder="Pídele un cambio a Cortex: «agrupa por ciudad», «agrega un formulario»…"
          />
        </div>

        <InspectorPanel
          tab={tab}
          onTab={setTab}
          hasBlock={Boolean(selected)}
          blockTitle={selected ? titleOf(selected) : null}
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          scrollKey={`${tab}:${selectedId ?? ''}`}
        >
          {tab === 'block' && selected ? (
            <>
              {/* En el teléfono la hoja tapa la barra flotante del marco: las mismas acciones, aquí. */}
              <div className="mb-4 grid grid-cols-4 gap-1.5 lg:hidden">
                {(
                  [
                    ['Antes', ChevronUp, selectedIndex <= 0, () => moveSelected(-1)],
                    [
                      'Después',
                      ChevronDown,
                      selectedIndex >= spec.blocks.length - 1,
                      () => moveSelected(1),
                    ],
                    ['Duplicar', Copy, !canAddBlock(spec), () => duplicate(selected.id)],
                    ['Eliminar', Trash2, spec.blocks.length <= 1, () => remove(selected.id)],
                  ] as const
                ).map(([label, Icon, disabled, run]) => (
                  <button
                    key={label}
                    type="button"
                    disabled={disabled}
                    onClick={run}
                    className={clsx(
                      'flex flex-col items-center gap-0.5 rounded-sm border border-border bg-surface-2/60 px-1 py-1.5 text-micro font-semibold text-ink-muted transition-colors duration-150 hover:text-ink disabled:opacity-35',
                      label === 'Eliminar' && 'hover:border-rose/40 hover:text-rose',
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {label}
                  </button>
                ))}
              </div>
              <BlockInspector
                key={selected.id}
                block={selected}
                sources={sources}
                problems={byBlock.get(selected.id) ?? []}
                editing={spec.editing}
                onChange={(next, coalesce) =>
                  setSpec(updateBlock(spec, selected.id, next), coalesce)
                }
                onAllowEditing={() => setSpec({ ...spec, editing: 'team' })}
              />
            </>
          ) : (
            <ViewSettings
              draft={draft}
              sources={sources}
              problems={viewProblems.concat(problems.filter((p) => p.alertId))}
              onChange={commit}
            />
          )}
        </InspectorPanel>
      </div>

      <AddBlockPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sources={sources}
        blockTypes={catalog?.blockTypes ?? []}
        prefer={selected ? sourceOf(selected) : null}
        loading={!catalog && !catalogError}
        onPick={addBlock}
      />

      {toast && (
        <div
          aria-live="polite"
          className={clsx(
            'fixed bottom-24 left-1/2 z-50 flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 shadow-pop',
          )}
        >
          <p className="min-w-0 flex-1 truncate text-sm text-ink">{toast.message}</p>
          {toast.restore && (
            <button
              type="button"
              onClick={() => {
                if (toast.restore) commit(toast.restore);
                setToast(null);
              }}
              className="shrink-0 rounded-pill px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary-soft"
            >
              Deshacer
            </button>
          )}
          <button
            type="button"
            aria-label="Cerrar aviso"
            onClick={() => setToast(null)}
            className="shrink-0 text-ink-faint hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
