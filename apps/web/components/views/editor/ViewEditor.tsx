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
import {
  DEVICE_LABEL,
  DEVICE_WIDTH,
  type DropSpot,
  type StudioDevice,
  blocksOfPage,
  copyPages,
  deviceColumns,
  deviceSpan,
  insertBlockAt,
  locateDrop,
  pagesOf,
  pagesOfBlock,
  prunePages,
  relativeTime,
  studioSuggestions,
  togglePage,
} from '@/lib/views/studio';
import type { ComputedBlock, ComputedView, ViewBlock, ViewSpec } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  CircleHelp,
  Copy,
  Files,
  History as HistoryIcon,
  Loader2,
  Monitor,
  PanelRightOpen,
  Pencil,
  Play,
  Redo2,
  Share2,
  Smartphone,
  Table2,
  Tablet,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ViewBlockPreview, ViewCanvas } from '../ViewCanvas';
import { ShareDialog, type ToolbarView } from '../ViewToolbar';
import { ViewCover } from '../blocks/ViewChrome';
import { useBrandScope, useViewBrand } from '../blocks/brand';
import { BlockLibrary, libraryPieces } from '../studio/BlockLibrary';
import { CommandBar } from '../studio/CommandBar';
import { type CatalogSource, DataPanel } from '../studio/DataPanel';
import { LayersPanel } from '../studio/LayersPanel';
import { PagesPanel } from '../studio/PagesPanel';
import { ShortcutsDialog } from '../studio/ShortcutsDialog';
import { type RailTab, StudioDock, StudioRail, StudioSheet } from '../studio/StudioRail';
import { useDraftAutosave } from '../studio/useDraftAutosave';
import { useDesigner } from '../useDesigner';
import { AddBlockPalette } from './AddBlockPalette';
import { BlockInspector } from './BlockInspector';
import { EditorCanvas, measureBlocks } from './EditorCanvas';
import { InspectorPanel } from './InspectorPanel';
import { ViewSettings } from './ViewSettings';
import { blockIcon, blockLabel } from './block-meta';
import { useEditorServices } from './services';

/**
 * EL ESTUDIO: EDITAR UNA VISTA EN PANTALLA COMPLETA.
 *
 * Hasta aquí una vista sólo cambiaba escribiéndole a Cortex. Eso sirve para
 * «arma un tablero de cartera», no para «este gráfico un poco más ancho» o
 * «quita ese filtro»: para eso está el estudio. Es un espacio de trabajo
 * entero, como el editor de interfaces de Airtable o de Retool, pero para
 * quien nunca ha visto uno:
 *
 *   - ARRIBA: salir, el nombre (se cambia escribiendo encima), si hay cambios
 *     sin guardar, deshacer/rehacer, cómo se ve en computador, tableta o
 *     celular, «Probar» (usar la vista con datos reales, sin poder romper
 *     nada), «Compartir» (el mismo diálogo de la barra de la vista) y
 *     «Guardar».
 *   - IZQUIERDA: «Agregar» (la biblioteca de piezas, que se arrastran al
 *     lienzo o se tocan), «Datos» (las tablas y sus campos, con un botón para
 *     poner una pieza sobre cada una), «Capas» (los bloques como lista) y
 *     «Páginas» cuando la vista tiene pestañas.
 *   - CENTRO: el lienzo, dentro del marco del dispositivo, con las columnas de
 *     la rejilla a la vista al arrastrar. Cada bloque se arrastra, se ensancha
 *     con el asa, se duplica o se borra.
 *   - DERECHA: el inspector del bloque elegido o de la vista entera; se pliega.
 *   - ABAJO, FLOTANDO: la caja de Cortex (⌘K), con frases sugeridas a partir
 *     de esta vista. Cambia ESTE borrador: se puede pedir un tablero hablando y
 *     acomodarlo a mano, y se deshace igual.
 *
 * En el teléfono no caben tres columnas: el lienzo ocupa la pantalla, el
 * inspector y los paneles suben como hojas, y una barra de pestañas abajo los
 * abre.
 *
 * LO QUE NO HACE. No guarda nada solo en el servidor. Todo cambio es local
 * hasta «Guardar», que pasa por `saveViewAction` —el mismo contrato, el mismo
 * catálogo, una versión nueva en el historial y el mismo conflicto si alguien
 * guardó mientras tanto—. Lo que sí hace es copiar el borrador a este
 * navegador mientras hay cambios (`useDraftAutosave`) y ofrecer recuperarlo si
 * la pestaña se cerró.
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

interface LibraryDrag {
  type: PaletteType;
  x: number;
  y: number;
  spot: DropSpot | null;
}

const DEVICE_ICON = { desktop: Monitor, tablet: Tablet, phone: Smartphone } as const;

const TOP_BUTTON =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill px-2.5 text-xs font-semibold transition-all duration-150 disabled:opacity-40 motion-reduce:transition-none';
const ICON_BUTTON =
  'grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-35';

/** Menos de 768 px de ventana: el lienzo es siempre el de un celular. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return narrow;
}

export function ViewEditor({
  initial,
  initialPreview,
  viewId,
  version = null,
  isNew,
  explanation,
  share = null,
  autoPrompt = null,
  onSave,
  onCancel,
}: {
  initial: EditorDraft;
  initialPreview: ComputedView | null;
  viewId?: string;
  /** La versión guardada sobre la que se edita (para el borrador del navegador). */
  version?: number | null;
  isNew: boolean;
  /** Lo que Cortex dijo de un borrador que llega al estudio desde una frase. */
  explanation?: string | null;
  /** Lo que necesita «Compartir». Sin él (una vista nueva) el botón espera al primer guardado. */
  share?: ToolbarView | null;
  /** Una frase para mandarle a Cortex apenas abre el estudio (plantillas «Cortex la arma»). */
  autoPrompt?: string | null;
  onSave: (draft: EditorDraft, prompts: string[]) => Promise<SaveOutcome>;
  onCancel: () => void;
}) {
  const services = useEditorServices();
  const brand = useViewBrand();
  const brandScope = useBrandScope();
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
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(explanation ?? null);
  const [announcement, setAnnouncement] = useState('');
  const [prompt, setPrompt] = useState('');
  const [prompts, setPrompts] = useState<string[]>([]);
  const [chosenDevice, setDevice] = useState<StudioDevice>('desktop');
  const [mode, setMode] = useState<'edit' | 'test'>('edit');
  const [railTab, setRailTab] = useState<RailTab | null>('add');
  const [mobileTab, setMobileTab] = useState<RailTab | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [pageId, setPageId] = useState<string | null>(null);
  const [libDrag, setLibDrag] = useState<LibraryDrag | null>(null);
  const designer = useDesigner(viewId);
  const narrow = useNarrow();
  const device: StudioDevice = narrow ? 'phone' : chosenDevice;

  const initialJson = useRef(JSON.stringify(initial));
  /** El spec que produjo la vista previa que se está mostrando. */
  const previewedJson = useRef(initialPreview ? JSON.stringify(initial.spec) : '');
  const commandInput = useRef<HTMLTextAreaElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const libStart = useRef<{ type: PaletteType; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const autoAsked = useRef(false);

  const sources = useMemo(() => withDraftSources(catalog, draft), [catalog, draft]);
  const dirty = JSON.stringify(draft) !== initialJson.current;
  const autosave = useDraftAutosave({
    viewId,
    version,
    draft,
    dirty,
    initialJson: initialJson.current,
  });

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

  // ---- Páginas -------------------------------------------------------------

  const pages = pagesOf(spec);
  const currentPage = pages.length
    ? (pages.find((p) => p.id === pageId)?.id ?? pages[0]?.id ?? null)
    : null;
  const pageBlocks = useMemo(() => blocksOfPage(spec, currentPage), [spec, currentPage]);
  const pageSpec = useMemo(
    () => (pageBlocks === spec.blocks ? spec : { ...spec, blocks: pageBlocks }),
    [spec, pageBlocks],
  );
  const pageCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pages) m.set(p.id, blocksOfPage(spec, p.id).length);
    return m;
  }, [spec, pages]);

  /** De un índice de la página que se ve a uno del spec entero. */
  function globalIndex(local: number): number {
    const block = pageBlocks[local];
    return block ? spec.blocks.findIndex((b) => b.id === block.id) : spec.blocks.length;
  }

  // ---- Acciones del lienzo ------------------------------------------------

  const selectedIndex = spec.blocks.findIndex((b) => b.id === selectedId);
  const selected = spec.blocks[selectedIndex] ?? null;
  const localIndex = pageBlocks.findIndex((b) => b.id === selectedId);

  function moveLocal(from: number, to: number) {
    const a = globalIndex(from);
    const b = globalIndex(to);
    if (a < 0 || b < 0 || b >= spec.blocks.length) return;
    setSpec(moveBlock(spec, a, b));
  }

  function moveSelected(step: number) {
    const to = localIndex + step;
    if (localIndex < 0 || to < 0 || to >= pageBlocks.length) return;
    moveLocal(localIndex, to);
    setAnnouncement(`Movido a la posición ${to + 1} de ${pageBlocks.length}.`);
  }

  function select(id: string, options: { sheet?: boolean } = {}) {
    setSelectedId(id);
    setTab('block');
    if (options.sheet !== false) setSheetOpen(true);
    if (!inspectorOpen) setInspectorOpen(true);
  }

  function reveal(id: string) {
    window.requestAnimationFrame(() =>
      document
        .querySelector(`[data-block-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    );
  }

  /**
   * Pone en la página que se ve lo que se acaba de crear. En la primera no
   * hace falta nombrarlo (lo suelto sale ahí), salvo que la primera nombre sus
   * bloques uno por uno, como la arma «Agregar página».
   */
  function intoPage(next: ViewSpec, id: string): ViewSpec {
    if (!currentPage) return next;
    const first = pages[0];
    if (currentPage === first?.id && !first.blockIds.length) return next;
    return togglePage(next, id, currentPage, true);
  }

  function duplicate(id: string) {
    const res = duplicateBlock(spec, id);
    if (!res.id) return;
    setSpec(copyPages(res.spec, id, res.id));
    select(res.id, { sheet: false });
    setAnnouncement('Bloque duplicado.');
  }

  function addBlock(type: PaletteType, options: { at?: number; source?: string | null } = {}) {
    const block = newBlock(
      type,
      spec,
      sources,
      options.source ?? (selected ? sourceOf(selected) : null),
    );
    setPaletteOpen(false);
    setMobileTab(null);
    if (!block) return;
    const placed =
      options.at !== undefined
        ? insertBlockAt(spec, block, globalIndex(options.at))
        : insertBlock(spec, block, selectedId ?? pageBlocks.at(-1)?.id ?? null);
    setSpec(intoPage(placed, block.id));
    select(block.id, { sheet: false });
    setAnnouncement(`${BLOCK_LABEL[type] ?? blockLabel(type)} agregado.`);
    reveal(block.id);
  }

  function remove(id: string) {
    const before = draft;
    const res = removeBlock(spec, id);
    if (!res.removed) return;
    setSpec(prunePages(res.spec));
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

  async function askCortex(text?: string) {
    const ask = (text ?? prompt).trim();
    if (ask.length < 4) return;
    setPrompt(ask);
    const ready = await designer.design(ask, {
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
    setPrompts((p) => [...p, ask]);
    setPrompt('');
    if (selectedId && !(ready.draft.spec as ViewSpec).blocks.some((b) => b.id === selectedId))
      setSelectedId(null);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: una sola vez al abrir.
  useEffect(() => {
    if (!autoPrompt || autoAsked.current) return;
    autoAsked.current = true;
    void askCortex(autoPrompt);
  }, []);

  const blocking = problems.length;
  const named = draft.name.trim().length > 0;
  const canSave =
    !saving && !previewing && !designer.designing && blocking === 0 && named && (dirty || isNew);

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    const res = await onSave(draft, prompts.length ? prompts : ['Editada en el estudio']);
    setSaving(false);
    if (!res.ok) {
      setSaveError(res.error);
      return;
    }
    initialJson.current = JSON.stringify(draft);
    autosave.clear();
    setPrompts([]);
    setSavedAt(Date.now());
  }

  function exit() {
    if (
      dirty &&
      !window.confirm(
        '¿Salir sin guardar? Tus cambios quedan en este navegador y te ofrecemos recuperarlos cuando vuelvas.',
      )
    )
      return;
    onCancel();
  }

  function openViewSettings() {
    setTab('view');
    setInspectorOpen(true);
    setMobileTab(null);
    setSheetOpen(true);
  }

  function focusCortex() {
    setMobileTab(null);
    setSheetOpen(false);
    commandInput.current?.focus();
  }

  // ---- Arrastrar piezas de la biblioteca al lienzo ------------------------

  function overCanvas(x: number, y: number): boolean {
    const r = scroller.current?.getBoundingClientRect();
    return Boolean(r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  }

  function libraryDragProps(type: PaletteType): React.HTMLAttributes<HTMLButtonElement> {
    return {
      onPointerDown(e) {
        if (e.button !== 0 || e.pointerType === 'touch') return;
        e.currentTarget.setPointerCapture(e.pointerId);
        libStart.current = { type, x: e.clientX, y: e.clientY };
      },
      onPointerMove(e) {
        const s = libStart.current;
        if (!s) return;
        if (!libDrag && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 5) return;
        const spot = overCanvas(e.clientX, e.clientY)
          ? locateDrop(e.clientX, e.clientY, measureBlocks(gridRef.current), null)
          : null;
        setLibDrag({ type: s.type, x: e.clientX, y: e.clientY, spot });
      },
      onPointerUp() {
        const s = libStart.current;
        libStart.current = null;
        // Sin arrastre fue un clic: lo atiende el `onClick` de la tarjeta.
        if (!libDrag || !s) return;
        const at = libDrag.spot?.insert;
        setLibDrag(null);
        if (at !== null && at !== undefined) addBlock(s.type, { at });
        // El clic que el navegador manda después de soltar no debe agregar otra.
        suppressClick.current = true;
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      },
      onPointerCancel() {
        libStart.current = null;
        setLibDrag(null);
      },
    };
  }

  // ---- Teclado y salida sin guardar --------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (helpOpen || paletteOpen || shareOpen) return;
      const el = e.target instanceof Element ? e.target : null;
      const typing = Boolean(el?.closest('input, textarea, select, [contenteditable="true"]'));
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === 's') {
        e.preventDefault();
        void save();
      } else if (mod && key === 'k') {
        e.preventDefault();
        focusCortex();
      } else if (mod && key === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && key === 'y' && !typing) {
        e.preventDefault();
        redo();
      } else if (typing || e.defaultPrevented) {
        return;
      } else if (mod && key === 'd' && selected) {
        e.preventDefault();
        duplicate(selected.id);
      } else if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) {
        e.preventDefault();
        setHelpOpen(true);
      } else if (e.key === '/' && !mod) {
        e.preventDefault();
        focusCortex();
      } else if (key === 'p' && !mod && !e.altKey) {
        e.preventDefault();
        setMode((m) => (m === 'edit' ? 'test' : 'edit'));
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && mode === 'edit') {
        e.preventDefault();
        remove(selected.id);
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && selected) {
        e.preventDefault();
        moveSelected(e.key === 'ArrowUp' ? -1 : 1);
      } else if (e.key === 'Escape') {
        if (mode === 'test') setMode('edit');
        else if (mobileTab) setMobileTab(null);
        else if (sheetOpen) setSheetOpen(false);
        else if (selectedId) setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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

  // En una pantalla de menos de 1600 px, los dos paneles abiertos dejan el
  // lienzo del computador más angosto que cualquier vista de verdad (un tercio
  // nunca baja de ~310 px en la app). Arranca con el inspector plegado; elegir
  // un bloque lo abre.
  // Y en una tableta, el lienzo arranca mostrando la vista como se verá ahí.
  useEffect(() => {
    if (window.innerWidth < 1600) setInspectorOpen(false);
    if (window.innerWidth < 1100) setDevice('tablet');
  }, []);

  // El estudio tapa la app: que la página de atrás no se desplace con la rueda.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // ---- Lo que se pinta ----------------------------------------------------

  const pieces = useMemo(
    () =>
      libraryPieces(spec, sources, catalog?.blockTypes ?? [], selected ? sourceOf(selected) : null),
    [spec, sources, catalog, selected],
  );
  const used = useMemo(
    () => new Set(spec.blocks.map(sourceOf).filter((s): s is string => Boolean(s))),
    [spec],
  );
  const suggestions = useMemo(
    () => studioSuggestions(spec, sources, selected ? titleOf(selected) : null),
    [spec, sources, selected],
  );
  const railTabs: RailTab[] = pages.length
    ? ['add', 'data', 'layers', 'pages']
    : ['add', 'data', 'layers'];

  const status = saving ? (
    <span className="inline-flex items-center gap-1">
      <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Guardando…
    </span>
  ) : designer.designing ? (
    <span className="inline-flex items-center gap-1 text-primary">
      <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Cortex está armando el cambio…
    </span>
  ) : previewing ? (
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
    <span className="inline-flex items-center gap-1.5 text-ink-muted">
      <span className="h-1.5 w-1.5 rounded-pill bg-amber" aria-hidden /> Cambios sin guardar
    </span>
  ) : isNew && !savedAt ? (
    'Sin guardar todavía'
  ) : (
    <span className="inline-flex items-center gap-1 text-emerald">
      <Check className="h-3 w-3" aria-hidden /> Guardado
    </span>
  );

  const railContent = (which: RailTab | null, inSheet: boolean) => {
    switch (which) {
      case 'add':
        return (
          <BlockLibrary
            pieces={pieces}
            loading={!catalog && !catalogError}
            canAdd={canAddBlock(spec)}
            onAdd={(type) => {
              if (suppressClick.current) return;
              addBlock(type);
            }}
            dragProps={inSheet ? undefined : libraryDragProps}
          />
        );
      case 'data':
        return (
          <DataPanel
            sources={sources as CatalogSource[]}
            loading={!catalog && !catalogError}
            error={catalogError}
            used={used}
            canAdd={canAddBlock(spec)}
            onAdd={(type, source) => addBlock(type, { source })}
          />
        );
      case 'layers':
        return (
          <>
            <LayersPanel
              spec={pageSpec}
              selectedId={selectedId}
              problems={byBlock}
              onSelect={(id) => {
                select(id, { sheet: false });
                setMobileTab(null);
                reveal(id);
              }}
              onMove={(from, to) => moveLocal(from, to)}
              onChange={(id, next) => setSpec(updateBlock(spec, id, next), `rename:${id}`)}
            />
            {!pages.length && (
              <button
                type="button"
                onClick={openViewSettings}
                className="mt-4 inline-flex items-center gap-1.5 text-micro font-semibold text-ink-muted transition-colors hover:text-primary"
              >
                <Files className="h-3.5 w-3.5" aria-hidden /> ¿Pestañas? Agrega páginas en los
                ajustes de la vista
              </button>
            )}
          </>
        );
      case 'pages':
        return (
          <PagesPanel
            pages={pages}
            current={currentPage}
            counts={pageCounts}
            selectedTitle={selected ? titleOf(selected) : null}
            selectedPages={selected ? pagesOfBlock(spec, selected.id) : []}
            selectedLoose={
              Boolean(selected) && !pages.some((p) => selected && p.blockIds.includes(selected.id))
            }
            onPick={(id) => {
              setPageId(id);
              setSelectedId(null);
              setMobileTab(null);
            }}
            onToggle={(page, on) => {
              if (selected) setSpec(togglePage(spec, selected.id, page, on));
            }}
            onManage={openViewSettings}
          />
        );
      default:
        return null;
    }
  };

  const SelectedIcon = selected ? blockIcon(selected.type) : null;

  return (
    <section
      className="fixed inset-0 z-[45] flex flex-col bg-canvas text-ink"
      aria-label={`Estudio de «${draft.name || 'vista nueva'}»`}
    >
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {/* ---- Barra de arriba -------------------------------------------- */}
      <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-border bg-surface/90 px-2 backdrop-blur-md sm:gap-2 sm:px-3">
        <button
          type="button"
          onClick={exit}
          className={ICON_BUTTON}
          aria-label="Salir del estudio"
          title="Salir del estudio"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 md:max-w-[22rem] md:flex-none">
          <label className="group flex items-center gap-1.5">
            <span className="sr-only">Nombre de la vista</span>
            <input
              value={draft.name}
              onChange={(e) => commit({ ...draft, name: e.target.value }, 'name')}
              maxLength={80}
              placeholder="Ponle un nombre"
              className={clsx(
                'min-w-0 flex-1 truncate rounded-sm border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-semibold text-ink outline-none transition-colors hover:border-border focus:border-primary focus:bg-surface',
                !named && 'border-amber/60',
              )}
            />
            <Pencil
              className="hidden h-3 w-3 shrink-0 text-ink-faint group-hover:block"
              aria-hidden
            />
          </label>
          <p className="truncate px-1.5 text-micro text-ink-faint" aria-live="polite">
            {status}
          </p>
        </div>

        {mode === 'edit' && (
          <div className="flex items-center">
            <button
              type="button"
              onClick={undo}
              disabled={!history.past.length}
              aria-label="Deshacer"
              title="Deshacer (⌘Z)"
              className={ICON_BUTTON}
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!history.future.length}
              aria-label="Rehacer"
              title="Rehacer (⇧⌘Z)"
              className={clsx(ICON_BUTTON, 'hidden sm:grid')}
            >
              <Redo2 className="h-4 w-4" />
            </button>
          </div>
        )}

        <fieldset className="mx-auto hidden items-center gap-0.5 rounded-pill bg-surface-2 p-0.5 md:flex">
          <legend className="sr-only">Ver como</legend>
          {(['desktop', 'tablet', 'phone'] as const).map((d) => {
            const Icon = DEVICE_ICON[d];
            return (
              <button
                key={d}
                type="button"
                aria-pressed={chosenDevice === d}
                onClick={() => setDevice(d)}
                title={`${DEVICE_LABEL[d]} · ${DEVICE_WIDTH[d]} px`}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-semibold transition-colors duration-150',
                  chosenDevice === d
                    ? 'bg-surface text-ink shadow-card'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                <span className="hidden xl:inline">{DEVICE_LABEL[d]}</span>
              </button>
            );
          })}
        </fieldset>

        <div className="ml-auto flex items-center gap-1 sm:gap-1.5 md:ml-0">
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className={clsx(ICON_BUTTON, 'hidden sm:grid')}
            aria-label="Atajos de teclado"
            title="Atajos de teclado (?)"
          >
            <CircleHelp className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-pressed={mode === 'test'}
            onClick={() => setMode((m) => (m === 'edit' ? 'test' : 'edit'))}
            title={mode === 'test' ? 'Volver a editar (P)' : 'Probar con datos reales (P)'}
            className={clsx(
              TOP_BUTTON,
              mode === 'test'
                ? 'bg-primary-soft text-primary'
                : 'border border-border-strong bg-surface text-ink shadow-card hover:-translate-y-px hover:bg-surface-2',
            )}
          >
            {mode === 'test' ? (
              <Pencil className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">{mode === 'test' ? 'Editar' : 'Probar'}</span>
          </button>
          {share ? (
            <ShareDialog
              view={share}
              open={shareOpen}
              onOpenChange={setShareOpen}
              trigger={
                <button
                  type="button"
                  title="Compartir"
                  className={clsx(
                    TOP_BUTTON,
                    'border border-border-strong bg-surface text-ink shadow-card hover:-translate-y-px hover:bg-surface-2',
                  )}
                >
                  <Share2 className="h-3.5 w-3.5" />
                  <span className="hidden lg:inline">Compartir</span>
                </button>
              }
            />
          ) : (
            <button
              type="button"
              disabled
              title="Guarda la vista para compartirla"
              className={clsx(
                TOP_BUTTON,
                'hidden border border-border bg-surface text-ink-muted sm:inline-flex',
              )}
            >
              <Share2 className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">Compartir</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            title={
              blocking
                ? 'Corrige lo marcado en amarillo para guardar'
                : !named
                  ? 'Ponle un nombre a la vista'
                  : 'Guardar (⌘S)'
            }
            className={clsx(
              TOP_BUTTON,
              'cortex-primary-button bg-primary px-3.5 text-white hover:bg-primary-strong',
            )}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {isNew && !savedAt ? 'Crear' : 'Guardar'}
          </button>
        </div>
      </header>

      {/* ---- Avisos de una línea ------------------------------------------ */}
      {(autosave.offer ||
        saveError ||
        catalogError ||
        draft.newTrackers.length > 0 ||
        viewProblems.length > 0) &&
        mode === 'edit' && (
          <div className="shrink-0 space-y-px border-b border-border bg-surface/70 text-xs">
            {autosave.offer && (
              <div className="flex flex-wrap items-center gap-2 bg-primary-soft/60 px-4 py-2 text-ink">
                <HistoryIcon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1">
                  Tienes cambios sin guardar de {relativeTime(autosave.offer.at)} en este navegador.
                  {autosave.offer.version !== null &&
                  version !== null &&
                  autosave.offer.version !== version
                    ? ' La vista cambió desde entonces: revisa antes de guardar.'
                    : ''}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const stored = autosave.offer;
                    autosave.accept();
                    if (stored) commit(stored.draft as EditorDraft);
                  }}
                  className="rounded-pill bg-primary px-2.5 py-1 font-semibold text-white"
                >
                  Recuperar
                </button>
                <button
                  type="button"
                  onClick={autosave.dismiss}
                  className="rounded-pill px-2.5 py-1 font-semibold text-ink-muted hover:bg-surface-2 hover:text-ink"
                >
                  Descartar
                </button>
              </div>
            )}
            {saveError && (
              <p role="alert" className="flex items-center gap-2 bg-rose-soft px-4 py-2 text-rose">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden /> {saveError}
              </p>
            )}
            {viewProblems.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setTab('view');
                  setSheetOpen(true);
                  setInspectorOpen(true);
                }}
                className="flex w-full items-center gap-2 bg-amber-soft px-4 py-2 text-left text-ink"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{viewProblems[0]?.message}</span>
              </button>
            )}
            {draft.newTrackers.map((t) => (
              <p key={t.slug} className="flex items-center gap-2 px-4 py-2 text-ink-muted">
                <Table2 className="h-3.5 w-3.5 shrink-0 text-emerald" aria-hidden />
                <span>
                  Al guardar se crea la tabla <strong className="text-ink">{t.name}</strong> con{' '}
                  {t.fields.map((f) => f.label).join(', ')}.
                </span>
              </p>
            ))}
            {catalogError && <p className="px-4 py-2 text-rose">{catalogError}</p>}
          </div>
        )}

      {/* ---- El espacio de trabajo ---------------------------------------- */}
      <div className="flex min-h-0 flex-1">
        {mode === 'edit' && (
          <StudioRail tab={railTab} tabs={railTabs} onTab={setRailTab}>
            {railContent(railTab, false)}
          </StudioRail>
        )}

        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: soltar la selección con el teclado es Escape. */}
          <div
            ref={scroller}
            className={clsx(
              'scroll-slim min-h-0 flex-1 overflow-auto bg-[radial-gradient(rgb(var(--border-strong)/0.45)_1px,transparent_1px)] bg-[length:22px_22px]',
              narrow ? 'px-3 pb-36 pt-4' : 'px-4 pb-40 pt-6 lg:px-10 lg:pt-8',
            )}
            onClick={(e) => {
              // Un clic en el fondo, fuera de todo bloque, suelta la selección.
              const el = e.target as HTMLElement;
              if (el === e.currentTarget || el.hasAttribute('data-canvas-bg')) setSelectedId(null);
            }}
          >
            <div
              data-canvas-bg
              className="mx-auto transition-[max-width] duration-200 ease-out motion-reduce:transition-none"
              style={{ maxWidth: narrow ? undefined : DEVICE_WIDTH[device] }}
            >
              {!narrow && (
                <div className="mb-2 flex items-center justify-between gap-2 px-1 text-micro text-ink-faint">
                  <span className="inline-flex items-center gap-1.5">
                    {(() => {
                      const Icon = DEVICE_ICON[device];
                      return <Icon className="h-3 w-3" aria-hidden />;
                    })()}
                    {DEVICE_LABEL[device]}
                    <span className="tabular font-mono">
                      {device === 'desktop'
                        ? `hasta ${DEVICE_WIDTH.desktop}`
                        : DEVICE_WIDTH[device]}{' '}
                      px
                    </span>
                  </span>
                  {mode === 'test' ? (
                    <span className="inline-flex items-center gap-1 rounded-pill bg-emerald-soft px-2 py-0.5 font-semibold text-emerald">
                      <Play className="h-3 w-3" aria-hidden /> Probando con datos reales · sin
                      guardar nada
                    </span>
                  ) : (
                    <span>
                      {pageBlocks.length} {pageBlocks.length === 1 ? 'bloque' : 'bloques'}
                    </span>
                  )}
                </div>
              )}
              <div
                data-canvas-bg
                style={brandScope.style}
                className={clsx(
                  brandScope.className,
                  'relative bg-canvas shadow-pop ring-1 ring-border transition-[border-radius,padding] duration-200 motion-reduce:transition-none',
                  narrow
                    ? 'rounded-card p-3'
                    : device === 'phone'
                      ? 'rounded-[2rem] p-3 ring-[6px] ring-surface-2'
                      : 'rounded-card p-4 sm:p-6',
                )}
              >
                {/* La cabecera como la verá la vista guardada (la grande, si el tema la pide). */}
                <div className="mb-5 px-1">
                  <ViewCover
                    title={draft.name || 'Vista sin nombre'}
                    subtitle={spec.subtitle ?? draft.description}
                    theme={preview?.theme}
                    brand={brand}
                  />
                  {/* Probando en el computador, las pestañas son las de la vista misma. */}
                  {pages.length > 0 && !(mode === 'test' && device === 'desktop' && !narrow) && (
                    <div
                      role="tablist"
                      aria-label="Páginas"
                      className="mt-4 flex gap-1 overflow-x-auto"
                    >
                      {pages.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          role="tab"
                          aria-selected={currentPage === p.id}
                          onClick={() => {
                            setPageId(p.id);
                            setSelectedId(null);
                          }}
                          className={clsx(
                            'shrink-0 rounded-pill px-3 py-1 text-xs font-semibold transition-colors duration-150',
                            currentPage === p.id
                              ? 'bg-primary-soft text-primary'
                              : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                          )}
                        >
                          {p.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {mode === 'edit' ? (
                  <div
                    className={clsx(
                      'transition-opacity duration-200',
                      designer.designing && 'opacity-50',
                    )}
                  >
                    <EditorCanvas
                      spec={pageSpec}
                      computed={computed}
                      problems={byBlock}
                      selectedId={selectedId}
                      stale={previewing || designer.designing}
                      canAdd={canAddBlock(spec)}
                      device={device}
                      external={libDrag?.spot ?? null}
                      gridRef={gridRef}
                      onSelect={(id) => select(id)}
                      onMove={moveLocal}
                      onWidth={(id, width) => {
                        const block = spec.blocks.find((b) => b.id === id);
                        if (block) setSpec(updateBlock(spec, id, { ...block, width } as ViewBlock));
                      }}
                      onDuplicate={duplicate}
                      onRemove={remove}
                      onAdd={() => setPaletteOpen(true)}
                      onAsk={focusCortex}
                      announce={setAnnouncement}
                    />
                  </div>
                ) : preview ? (
                  device === 'desktop' && !narrow ? (
                    <ViewCanvas
                      view={preview}
                      target={{ kind: 'preview' }}
                      page={{ current: currentPage, onSelect: setPageId }}
                    />
                  ) : (
                    // Tableta y celular: la misma pieza interactiva, en las columnas del marco.
                    <div className={clsx('grid gap-4', deviceColumns(device))}>
                      {preview.blocks
                        .filter((b) => pageBlocks.some((p) => p.id === b.id))
                        .map((b) => (
                          <section
                            key={b.id}
                            className={clsx('min-w-0', deviceSpan(b.width, device))}
                          >
                            <ViewBlockPreview block={b} />
                          </section>
                        ))}
                    </div>
                  )
                ) : (
                  <p className="grid h-40 place-items-center text-sm text-ink-muted">
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Calculando la vista
                      con tus datos…
                    </span>
                  </p>
                )}
              </div>
            </div>
          </div>

          {mode === 'edit' && (
            <CommandBar
              value={prompt}
              onChange={setPrompt}
              onSubmit={(text) => void askCortex(text)}
              busy={designer.designing}
              error={designer.error}
              questions={designer.questions}
              note={note}
              onDismissNote={() => {
                setNote(null);
                designer.clear();
              }}
              suggestions={suggestions}
              inputRef={commandInput}
            />
          )}

          {mode === 'edit' && !inspectorOpen && (
            <button
              type="button"
              onClick={() => setInspectorOpen(true)}
              aria-label="Mostrar el panel de ajustes"
              title="Mostrar el panel de ajustes"
              className="absolute right-3 top-3 z-20 hidden h-9 w-9 place-items-center rounded-pill border border-border-strong bg-surface text-ink-muted shadow-card transition-colors hover:text-ink lg:grid"
            >
              <PanelRightOpen className="h-4 w-4" />
            </button>
          )}
        </main>

        {mode === 'edit' && (
          <div className={clsx('contents', !inspectorOpen && 'lg:hidden')}>
            <InspectorPanel
              tab={tab}
              onTab={setTab}
              hasBlock={Boolean(selected)}
              blockTitle={selected ? titleOf(selected) : null}
              open={sheetOpen}
              onClose={() => setSheetOpen(false)}
              onCollapse={() => setInspectorOpen(false)}
              scrollKey={`${tab}:${selectedId ?? ''}`}
              summary={
                <p className="flex min-w-0 items-center gap-1.5 text-micro text-ink-faint">
                  {tab === 'block' && selected && SelectedIcon ? (
                    <>
                      <SelectedIcon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                      <span className="shrink-0 font-semibold text-ink-muted">
                        {blockLabel(selected.type)}
                      </span>
                      <span className="truncate">{titleOf(selected)}</span>
                    </>
                  ) : (
                    <span className="truncate">Ajustes de «{draft.name || 'la vista'}»</span>
                  )}
                </p>
              }
            >
              {tab === 'block' && selected ? (
                <>
                  {/* En el teléfono la hoja tapa la barra flotante del marco: las mismas acciones, aquí. */}
                  <div className="mb-4 grid grid-cols-4 gap-1.5 lg:hidden">
                    {(
                      [
                        ['Antes', ChevronUp, localIndex <= 0, () => moveSelected(-1)],
                        [
                          'Después',
                          ChevronDown,
                          localIndex >= pageBlocks.length - 1,
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
                  team={catalog?.team ?? []}
                  problems={viewProblems.concat(problems.filter((p) => p.alertId))}
                  onChange={commit}
                />
              )}
            </InspectorPanel>
          </div>
        )}
      </div>

      {mode === 'edit' && (
        <StudioDock
          tabs={railTabs}
          active={mobileTab}
          onTab={(t) => {
            setSheetOpen(false);
            setMobileTab(mobileTab === t ? null : t);
          }}
          onSettings={() => {
            setMobileTab(null);
            if (!selected) setTab('view');
            setSheetOpen(!sheetOpen);
          }}
          settingsActive={sheetOpen}
        />
      )}
      <StudioSheet tab={mobileTab} onClose={() => setMobileTab(null)}>
        {railContent(mobileTab, true)}
      </StudioSheet>

      <AddBlockPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sources={sources}
        blockTypes={catalog?.blockTypes ?? []}
        prefer={selected ? sourceOf(selected) : null}
        loading={!catalog && !catalogError}
        onPick={(type) => addBlock(type)}
      />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />

      {libDrag && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[60] flex items-center gap-2 rounded-pill border border-primary/50 bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-pop"
          style={{ left: libDrag.x + 14, top: libDrag.y + 14 }}
        >
          {(() => {
            const Icon = blockIcon(libDrag.type);
            return <Icon className="h-3.5 w-3.5 text-primary" />;
          })()}
          {blockLabel(libDrag.type)}
          <span className="font-normal text-ink-faint">
            {libDrag.spot ? 'Suelta para agregar' : 'Llévala al lienzo'}
          </span>
        </div>
      )}

      {toast && (
        <div
          aria-live="polite"
          className="fixed bottom-24 left-1/2 z-50 flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 shadow-pop"
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
    </section>
  );
}
