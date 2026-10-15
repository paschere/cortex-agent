'use client';

import type { TaskFile } from '@/lib/background-tasks/files';
import type { BrainSource } from '@/lib/brain-sources-shape';
import {
  type BrowserStep,
  type LiveSessionRef,
  browserSteps,
  liveSessionOf,
} from '@/lib/browser-live-steps';
import {
  APP_PANEL_MODE_KEY,
  APP_PANEL_WIDTH_KEY,
  type AppPanelMode,
  type AppRef,
  MIN_APP_PANEL,
  MIN_CHAT,
  clampAppPanelWidth,
  defaultAppPanelWidth,
  parseStoredMode,
  parseStoredWidth,
  shouldRefresh,
  shouldSwitchFromDraft,
  statusLabel,
} from '@/lib/chat-app-panel';
import {
  type ArtifactMeta,
  askMorePrompt,
  csvFileName,
  saveAsViewPrompt,
  toCsv,
} from '@/lib/chat-artifact';
import type { TurnInvocation } from '@/lib/chat-turn';
import { downloadBytes } from '@/lib/xlsx/download';
import { inferSheet } from '@/lib/xlsx/infer';
import { buildXlsx, xlsxFileName } from '@/lib/xlsx/write';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import {
  BookmarkPlus,
  Download,
  Globe,
  MessageSquareText,
  PanelRightOpen,
  Smartphone,
  X,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { FilesPanel } from '../tareas/FilesPanel';
import type { AppPanelFixture } from './AppSidePanel';
import { useChatCompose } from './ChatCompose';
import type { TurnMetrics } from './TaskRows';
import { ActivityTab, SourcesTab, useTurnRows } from './TurnPanel';

// La app al lado (iframes del editor y de la vista): sólo se baja si hay una app.
const AppSide = dynamic(() => import('./AppSidePanel').then((m) => m.AppSidePanel), {
  ssr: false,
});

// La pantalla viva pesa (canvas, socket, portapapeles): sólo se baja si hay pestaña.
const BrowserTabPanel = dynamic(() => import('./BrowserPanel'), { ssr: false });

/**
 * «LO QUE CORTEX ARMÓ»: EL PANEL DERECHO DEL CHAT.
 *
 * El resultado sigue dibujándose en la conversación, exactamente como antes
 * (`ArtifactFrame` sólo le añade una fila con «Abrir al lado»). Abrirlo lo
 * monta a tamaño completo en una hoja a la derecha —en el teléfono, una hoja
 * desde abajo— con las tres cosas que sí existen hoy: dejar «Guarda esto como
 * vista» escrito en el chat, bajar la tabla en CSV (que Excel abre) y seguir
 * preguntando sobre ello. Nada de eso inventa un protocolo: las dos primeras
 * son texto en el compositor y la tercera un archivo local.
 *
 * Sin proveedor (el showcase, una prueba), `ArtifactFrame` no dibuja la fila y
 * el resultado queda como siempre.
 */

export interface ChatArtifact extends ArtifactMeta {
  id: string;
  /** Vuelve a pintar el mismo resultado. Se llama en el panel, no en la conversación. */
  render: () => ReactNode;
}

export type PanelTab = 'app' | 'navegador' | 'resultado' | 'fuentes' | 'actividad' | 'archivos';

/** Lo que el último turno leyó y ejecutó, para las pestañas «Fuentes» y «Actividad». */
export interface TurnInsight {
  invocations: TurnInvocation[];
  brain: BrainSource[];
  metrics: TurnMetrics | null;
  /** Cortex sigue trabajando en este turno. */
  working?: boolean;
}

interface ArtifactsApi {
  current: ChatArtifact | null;
  open: (artifact: ChatArtifact) => void;
  close: () => void;
  /** El panel está abierto (con o sin un resultado dentro). */
  panelOpen: boolean;
  tab: PanelTab;
  openTab: (tab: PanelTab) => void;
  turn: TurnInsight | null;
  setTurn: (turn: TurnInsight | null) => void;
  /** La pestaña viva de esta conversación, si hay una abierta. */
  live: LiveSessionRef | null;
  /** Los pasos del navegador, en orden, con la hora en que se vieron. */
  steps: BrowserStep[];
  /** El paso al que otra pestaña quiere llevar la mirada. */
  focusStep: string | null;
  /** Abre «Navegador» y marca ese paso. */
  openStep: (id: string) => void;
  /** La pestaña se cerró (Detener, o murió): los pasos quedan. */
  stopLive: () => void;
  /** La conversación, para listar «Archivos» (todo lo producido durante ella). */
  conversationId: string | undefined;
  /** Archivos de muestra (pantallas de prueba): si vienen, la pestaña no consulta nada. */
  filesFixture: TaskFile[] | undefined;
  /** La app de esta conversación (la que Cortex creó o cambió, la que se leyó o se mencionó con @). */
  app: AppRef | null;
  appMode: AppPanelMode;
  setAppMode: (mode: AppPanelMode) => void;
  /** Sube cada vez que Cortex cambia la app desde el chat: el panel recarga. */
  appSync: number;
  /** Abre la app al lado, en «Vista» o «Editar». */
  openApp: (app: AppRef, mode?: AppPanelMode) => void;
  /** La conversación habla de esta app (resultado de una herramienta). `history` = al cargar. */
  syncConversationApp: (app: AppRef | null, history: boolean) => void;
  /** Se mencionó una app con @: aparece su chip sin abrir nada. */
  mentionApp: (app: { id: string; name: string }) => void;
  /** Datos de muestra (pantallas de prueba): el panel no consulta nada. */
  appFixture: AppPanelFixture | undefined;
  /** Ancho recordado del panel cuando muestra una app. */
  appWidth: number;
  setAppWidth: (width: number) => void;
}

const ArtifactsContext = createContext<ArtifactsApi | null>(null);

export function ChatArtifactsProvider({
  children,
  initial = null,
  initialTab,
  initialTurn = null,
  initialLive = null,
  initialSteps = [],
  conversationId,
  initialFiles,
  initialApp = null,
  initialAppMode,
  appFixture,
}: {
  children: ReactNode;
  conversationId?: string;
  initialFiles?: TaskFile[];
  initialApp?: AppRef | null;
  initialAppMode?: AppPanelMode;
  appFixture?: AppPanelFixture;
  initial?: ChatArtifact | null;
  initialTab?: PanelTab;
  initialTurn?: TurnInsight | null;
  initialLive?: LiveSessionRef | null;
  initialSteps?: BrowserStep[];
}) {
  const [current, setCurrent] = useState<ChatArtifact | null>(initial);
  const [app, setApp] = useState<AppRef | null>(initialApp);
  const [appMode, setAppModeState] = useState<AppPanelMode>(initialAppMode ?? 'vista');
  const [appSync, setAppSync] = useState(0);
  const [appWidth, setAppWidthState] = useState(() =>
    typeof window === 'undefined' ? 720 : defaultAppPanelWidth(window.innerWidth),
  );
  const [panelOpen, setPanelOpen] = useState(
    Boolean(initial) || Boolean(initialTab) || Boolean(initialApp && initialAppMode),
  );
  const [tab, setTab] = useState<PanelTab>(
    initialTab ?? (initialApp && initialAppMode ? 'app' : 'resultado'),
  );
  const appRef = useRef(app);
  appRef.current = app;
  const currentRef = useRef(current);
  currentRef.current = current;
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  // Lo recordado del navegador (modo y ancho) se lee después de montar: nada de sorpresas al hidratar.
  useEffect(() => {
    try {
      if (!initialAppMode)
        setAppModeState(parseStoredMode(localStorage.getItem(APP_PANEL_MODE_KEY)));
      setAppWidthState(
        parseStoredWidth(localStorage.getItem(APP_PANEL_WIDTH_KEY), window.innerWidth),
      );
    } catch {
      /* sin almacenamiento: valores por defecto */
    }
  }, [initialAppMode]);
  const setAppMode = useCallback((mode: AppPanelMode) => {
    setAppModeState(mode);
    try {
      localStorage.setItem(APP_PANEL_MODE_KEY, mode);
    } catch {
      /* ignorar */
    }
  }, []);
  const setAppWidth = useCallback((width: number) => {
    const next = clampAppPanelWidth(width, window.innerWidth);
    setAppWidthState(next);
    try {
      localStorage.setItem(APP_PANEL_WIDTH_KEY, String(next));
    } catch {
      /* ignorar */
    }
  }, []);
  const openApp = useCallback(
    (next: AppRef, mode?: AppPanelMode) => {
      setApp(next);
      if (mode) setAppMode(mode);
      setTab('app');
      setPanelOpen(true);
    },
    [setAppMode],
  );
  const syncConversationApp = useCallback((next: AppRef | null, history: boolean) => {
    const prev = appRef.current;
    if (!next) {
      if (prev && prev.source !== 'mention') setApp(null);
      return;
    }
    const draftOpen =
      panelOpenRef.current &&
      currentRef.current?.kind === 'summary' &&
      currentRef.current.title === 'Vista previa de la app';
    if (!history && shouldSwitchFromDraft(draftOpen, prev, next)) {
      // El borrador se creó: el panel pasa solo a la app de verdad.
      setApp(next);
      setCurrent(null);
      setTab('app');
      setPanelOpen(true);
      return;
    }
    if (!shouldRefresh(prev, next)) return;
    setApp(next);
    if (prev?.id === next.id && !history) setAppSync((n) => n + 1);
  }, []);
  const mentionApp = useCallback((m: { id: string; name: string }) => {
    if (appRef.current?.id === m.id) return;
    setApp({
      id: m.id,
      slug: m.id,
      name: m.name,
      icon: '▦',
      status: 'draft',
      version: null,
      source: 'mention',
      updatedAt: null,
    });
  }, []);
  const [turn, setTurnState] = useState<TurnInsight | null>(initialTurn);
  const [live, setLive] = useState<LiveSessionRef | null>(initialLive);
  const [steps, setSteps] = useState<BrowserStep[]>(initialSteps);
  const [focusStep, setFocusStep] = useState<string | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  // La pestaña que la persona cerró a mano: no se vuelve a abrir sola.
  const dismissed = useRef<string | null>(null);
  // La primera lectura del turno es la conversación tal como se cargó (historia):
  // no se abre nada solo ni se inventan horas para pasos que ya ocurrieron.
  const firstTurn = useRef(true);

  const setTurn = useCallback((next: TurnInsight | null) => {
    setTurnState(next);
    const history = firstTurn.current;
    firstTurn.current = false;
    if (!next) {
      setLive(null);
      setSteps([]);
      return;
    }
    const found = browserSteps(next.invocations);
    if (found.length === 0) return;
    const before = new Map(stepsRef.current.map((s) => [s.id, s]));
    const now = Date.now();
    const incoming = found.map((s) => ({
      ...s,
      at: before.get(s.id)?.at ?? (history ? undefined : now),
    }));
    const nextLive = liveSessionOf(next.invocations);
    const closed =
      !nextLive && incoming.some((s) => s.tool === 'browser_close_page' && s.status === 'ok');
    const key = nextLive?.sessionId ?? liveRef.current?.sessionId ?? null;
    const ids = new Set(incoming.map((s) => s.id));
    setSteps([
      ...stepsRef.current.filter((s) => !ids.has(s.id) && key !== null && s.sessionId === key),
      ...incoming,
    ]);
    if (closed) setLive(null);
    else if (nextLive && nextLive.sessionId !== liveRef.current?.sessionId) {
      setLive(nextLive);
      if (!history && dismissed.current !== nextLive.sessionId) {
        setTab('navegador');
        setPanelOpen(true);
      }
    } else if (nextLive && nextLive.checkpointId !== liveRef.current?.checkpointId) {
      setLive(nextLive);
    }
    // Un paso nuevo que espera a la persona (control, clave, código) la llama de vuelta.
    if (!history && incoming.some((s) => s.needsPerson && !before.has(s.id))) {
      dismissed.current = null;
      setTab('navegador');
      setPanelOpen(true);
    }
  }, []);
  const stopLive = useCallback(() => setLive(null), []);
  const openStep = useCallback((id: string) => {
    setFocusStep(id);
    setTab('navegador');
    setPanelOpen(true);
  }, []);
  const open = useCallback((artifact: ChatArtifact) => {
    if (artifact.app) {
      // Una app no es un resultado más: tiene su pestaña (vista y editor).
      setApp(artifact.app);
      setCurrent(null);
      setTab('app');
      setPanelOpen(true);
      return;
    }
    setCurrent(artifact);
    setTab('resultado');
    setPanelOpen(true);
  }, []);
  const close = useCallback(() => {
    setCurrent(null);
    setPanelOpen(false);
    if (liveRef.current) dismissed.current = liveRef.current.sessionId;
  }, []);
  const openTab = useCallback((next: PanelTab) => {
    setTab(next);
    setPanelOpen(true);
  }, []);
  const value = useMemo(
    () => ({
      current,
      open,
      close,
      panelOpen,
      tab,
      openTab,
      turn,
      setTurn,
      live,
      steps,
      focusStep,
      openStep,
      stopLive,
      conversationId,
      filesFixture: initialFiles,
      app,
      appMode,
      setAppMode,
      appSync,
      openApp,
      syncConversationApp,
      mentionApp,
      appFixture,
      appWidth,
      setAppWidth,
    }),
    [
      app,
      appMode,
      setAppMode,
      appSync,
      openApp,
      syncConversationApp,
      mentionApp,
      appFixture,
      appWidth,
      setAppWidth,
      current,
      open,
      close,
      panelOpen,
      tab,
      openTab,
      turn,
      setTurn,
      live,
      steps,
      focusStep,
      openStep,
      stopLive,
      conversationId,
      initialFiles,
    ],
  );
  return <ArtifactsContext.Provider value={value}>{children}</ArtifactsContext.Provider>;
}

export function useChatArtifacts(): ArtifactsApi | null {
  return useContext(ArtifactsContext);
}

/** La fila bajo cada resultado que se puede abrir al lado. */
export function ArtifactFrame({
  artifact,
  children,
}: { artifact: ChatArtifact; children: ReactNode }) {
  const api = useChatArtifacts();
  if (!api) return <>{children}</>;
  const isOpen = artifact.app
    ? api.panelOpen && api.tab === 'app' && api.app?.id === artifact.app.id
    : api.current?.id === artifact.id;
  return (
    <div>
      {children}
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          onClick={() => (isOpen ? api.close() : api.open(artifact))}
          aria-pressed={isOpen}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-xs font-medium transition-colors duration-150 motion-reduce:transition-none',
            isOpen
              ? 'bg-primary-soft text-primary-ink'
              : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
          )}
        >
          <PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
          {isOpen ? 'Abierto al lado' : 'Abrir al lado'}
        </button>
      </div>
    </div>
  );
}

const DESKTOP = '(min-width: 1024px)';

export function useDesktop(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mq = window.matchMedia(DESKTOP);
      mq.addEventListener('change', notify);
      return () => mq.removeEventListener('change', notify);
    },
    () => window.matchMedia(DESKTOP).matches,
    () => false,
  );
}

function downloadXlsx(artifact: ChatArtifact) {
  if (!artifact.csv) return;
  downloadBytes(
    xlsxFileName(artifact.title),
    buildXlsx(inferSheet(artifact.title, artifact.csv.headers, artifact.csv.rows)),
  );
}

function downloadCsv(artifact: ChatArtifact) {
  if (!artifact.csv) return;
  const blob = new Blob([toCsv(artifact.csv)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = csvFileName(artifact.title);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const secondary =
  'inline-flex items-center gap-1.5 rounded-pill bg-surface-2 px-3.5 py-1.5 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-border motion-reduce:transition-none';

const TAB_LABEL: Record<PanelTab, string> = {
  app: 'App',
  navegador: 'Computadora',
  resultado: 'Resultado',
  fuentes: 'Fuentes',
  actividad: 'Actividad',
  archivos: 'Archivos',
};

function PanelBody({ onClose, sheet }: { onClose: () => void; sheet?: boolean }) {
  const Title = sheet ? Dialog.Title : 'h2';
  const compose = useChatCompose();
  const api = useChatArtifacts();
  const artifact = api?.current ?? null;
  const tab = api?.tab ?? 'resultado';
  const rows = useTurnRows(api?.turn ?? null);
  const hasBrowser = Boolean(api?.live) || (api?.steps.length ?? 0) > 0;
  const showComputer = hasBrowser || Boolean(api?.turn?.working && rows.activity.length > 0);
  const hasApp = Boolean(api?.app);
  const counts: Record<PanelTab, number | null> = {
    app: null,
    navegador: api?.steps.length ?? null,
    resultado: null,
    fuentes: rows.sources.length,
    actividad: rows.activity.length,
    archivos: api?.filesFixture?.length ?? null,
  };
  const base: PanelTab[] = showComputer
    ? ['navegador', 'resultado', 'fuentes', 'actividad', 'archivos']
    : ['resultado', 'fuentes', 'actividad', 'archivos'];
  const tabs: PanelTab[] = hasApp ? ['app', ...base] : base;
  const draftOpen = artifact?.title === 'Vista previa de la app';
  return (
    <>
      <div className="flex min-h-[3.5rem] shrink-0 items-center gap-2 border-b border-border px-4">
        <Title className="min-w-0 flex-1 truncate font-display text-lg text-ink">
          {tab === 'app' && api?.app
            ? api.app.name
            : tab === 'resultado' && artifact
              ? artifact.title
              : tab === 'navegador'
                ? hasBrowser
                  ? 'Cortex en el navegador'
                  : 'La computadora de Cortex'
                : 'Lo que Cortex armó'}
        </Title>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar panel (Esc)"
          title="Cerrar (Esc)"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink motion-reduce:transition-none"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div
        role="tablist"
        aria-label="Panel del turno"
        className="scroll-slim flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 pt-2"
      >
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`panel-tab-${t}`}
            aria-selected={tab === t}
            aria-controls="panel-tabpanel"
            onClick={() => api?.openTab(t)}
            className={clsx(
              '-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[0.8125rem] font-semibold transition-colors duration-150 motion-reduce:transition-none',
              tab === t
                ? 'border-primary text-ink'
                : 'border-transparent text-ink-faint hover:text-ink',
            )}
          >
            {t === 'navegador' && hasBrowser
              ? 'Navegador'
              : t === 'resultado' && draftOpen
                ? 'Borrador'
                : TAB_LABEL[t]}
            {counts[t] ? (
              <span className="tabular rounded-pill bg-surface-2 px-1.5 text-micro text-ink-muted">
                {counts[t]}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="panel-tabpanel"
        aria-labelledby={`panel-tab-${tab}`}
        className={clsx(
          'min-h-0 flex-1',
          tab === 'app' ? 'flex flex-col overflow-hidden' : 'scroll-slim overflow-y-auto p-4',
        )}
      >
        {tab === 'app' && <AppSide />}
        {tab === 'resultado' &&
          (artifact ? (
            artifact.render()
          ) : (
            <p className="rounded-card border border-dashed border-border px-4 py-6 text-sm text-ink-muted">
              Cuando Cortex arme una tabla o un gráfico, ábrelo con «Abrir al lado» y queda aquí.
            </p>
          ))}
        {tab === 'navegador' && <BrowserTabPanel />}
        {tab === 'fuentes' && <SourcesTab rows={rows.sources} />}
        {tab === 'archivos' && (
          <FilesPanel
            {...(api?.conversationId ? { conversationId: api.conversationId } : {})}
            {...(api?.filesFixture ? { initialFiles: api.filesFixture } : {})}
            compose={compose ? (text) => compose.compose(text) : null}
            {...(api?.turn?.working ? { refreshMs: 8000 } : {})}
          />
        )}
        {tab === 'actividad' && (
          <ActivityTab
            rows={rows.activity}
            toolIds={(api?.turn?.invocations ?? []).map((i) => i.toolName)}
            browserIds={new Set((api?.steps ?? []).map((s) => s.id))}
            {...(api ? { onOpenStep: api.openStep } : {})}
          />
        )}
      </div>
      {tab === 'resultado' && artifact && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={() => compose?.compose(saveAsViewPrompt(artifact.title))}
            className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3.5 py-1.5 text-xs font-semibold text-white shadow-card transition-colors duration-150 hover:bg-primary-strong motion-reduce:transition-none"
          >
            <BookmarkPlus className="h-3.5 w-3.5" aria-hidden />
            Guardar como vista
          </button>
          {artifact.csv && (
            <>
              <button type="button" onClick={() => downloadXlsx(artifact)} className={secondary}>
                <Download className="h-3.5 w-3.5" aria-hidden />
                Descargar Excel
              </button>
              <button type="button" onClick={() => downloadCsv(artifact)} className={secondary}>
                CSV
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => compose?.compose(askMorePrompt(artifact.title))}
            className={secondary}
          >
            <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
            Pregúntale más
          </button>
        </div>
      )}
    </>
  );
}

/** «Cortex está usando la computadora · ver»: en la cabecera del chat mientras trabaja. */
export function ComputerPill() {
  const api = useChatArtifacts();
  if (!api?.turn?.working || api.turn.invocations.length === 0) return null;
  if (api.panelOpen && api.tab === 'navegador') return null;
  return (
    <button
      type="button"
      onClick={() => api.openTab('navegador')}
      className="inline-flex min-w-0 shrink-0 items-center gap-2 rounded-pill bg-primary-soft px-3 py-1 text-xs font-semibold text-primary-ink transition-colors duration-150 hover:bg-surface-2 motion-reduce:transition-none"
    >
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
      <span className="truncate">Cortex está usando la computadora · ver</span>
    </button>
  );
}

/**
 * El divisor entre la conversación y el panel de la app: se arrastra (o se mueve
 * con las flechas) y el ancho se recuerda. El panel crece hacia la izquierda.
 */
function Splitter({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [active, setActive] = useState(false);
  return (
    // biome-ignore lint/a11y/useSemanticElements: un divisor que se arrastra y recibe foco no es un <hr>.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Ancho del panel de la app"
      aria-valuenow={width}
      aria-valuemin={MIN_APP_PANEL}
      tabIndex={0}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, w: width };
        setActive(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current) onChange(drag.current.w + (drag.current.x - e.clientX));
      }}
      onPointerUp={() => {
        drag.current = null;
        setActive(false);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 80 : 24;
        if (e.key === 'ArrowLeft') onChange(width + step);
        else if (e.key === 'ArrowRight') onChange(width - step);
        else return;
        e.preventDefault();
      }}
      onDoubleClick={() => onChange(defaultAppPanelWidth(window.innerWidth))}
      className={clsx(
        'group absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none outline-none',
        'focus-visible:bg-primary-soft',
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'absolute inset-y-3 left-0.5 w-0.5 rounded-full transition-colors duration-150 motion-reduce:transition-none',
          active ? 'bg-primary' : 'bg-transparent group-hover:bg-border-strong',
        )}
      />
    </div>
  );
}

/** «App · Borrador»: chip verde suave en la cabecera mientras la conversación tiene una app. */
export function AppPill() {
  const api = useChatArtifacts();
  if (!api?.app) return null;
  if (api.panelOpen && api.tab === 'app') return null;
  const { app } = api;
  return (
    <button
      type="button"
      onClick={() => api.openApp(app)}
      title={`Abrir «${app.name}» al lado`}
      className="inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-pill bg-emerald-soft px-2.5 text-micro font-semibold text-emerald transition-opacity duration-150 hover:opacity-80 motion-reduce:transition-none"
    >
      <Smartphone className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />
      <span className="truncate">
        App<span className="hidden sm:inline"> · {statusLabel(app.status, app.version)}</span>
      </span>
    </button>
  );
}

/** El panel mismo. Escritorio: hoja a la derecha. Teléfono y tableta: hoja desde abajo. */
export function ArtifactPanel() {
  const api = useChatArtifacts();
  const desktop = useDesktop();
  const isOpen = Boolean(api?.panelOpen);
  const close = api?.close;

  // Esc cierra el panel (la hoja del teléfono ya lo hace sola, vía Radix).
  useEffect(() => {
    if (!isOpen || !desktop || !close) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, [contenteditable="true"], [role="dialog"], [role="menu"]'))
        return;
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, desktop, close]);

  if (!api) return null;

  // Teléfono: con una pestaña viva y el panel cerrado, una píldora lleva a la hoja.
  if (!isOpen) {
    if (desktop || !api.live) return null;
    return (
      <button
        type="button"
        onClick={() => api.openTab('navegador')}
        className="fixed bottom-28 left-1/2 z-40 inline-flex -translate-x-1/2 items-center gap-2 rounded-pill bg-ink px-4 py-2 text-sm font-semibold text-surface shadow-pop"
      >
        <Globe className="h-4 w-4" aria-hidden />
        Ver navegador
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald" />
      </button>
    );
  }

  if (desktop) {
    const isApp = api.tab === 'app';
    return (
      <aside
        aria-label="Lo que Cortex armó"
        style={
          isApp
            ? { width: `min(${api.appWidth}px, calc(100% - ${MIN_CHAT + 280}px - 1rem))` }
            : undefined
        }
        className={clsx(
          'animate-rise relative hidden min-h-0 shrink-0 flex-col overflow-hidden rounded-[18px] bg-surface shadow-sheet lg:flex',
          !isApp && (api.tab === 'navegador' ? 'w-[min(44rem,52%)]' : 'w-[min(30rem,38%)]'),
        )}
      >
        {isApp && <Splitter width={api.appWidth} onChange={api.setAppWidth} />}
        <PanelBody onClose={api.close} />
      </aside>
    );
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && api.close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] animate-veil bg-ink/40 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className={clsx(
            'cortex-workspace fixed inset-x-0 bottom-0 z-[61] flex flex-col overflow-hidden bg-surface pb-[env(safe-area-inset-bottom)] shadow-pop focus:outline-none',
            api.tab === 'navegador' || api.tab === 'app'
              ? 'h-[100dvh] pt-[env(safe-area-inset-top)]'
              : 'max-h-[88dvh] rounded-t-[22px]',
          )}
        >
          <PanelBody onClose={api.close} sheet />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
