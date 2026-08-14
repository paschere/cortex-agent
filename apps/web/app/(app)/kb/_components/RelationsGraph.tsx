'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Maximize2, Minus, Plus, X } from 'lucide-react';
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type ViewBox,
  centreOn,
  fitView,
  litSet,
  neighbourMap,
  panBy,
  scaleOf,
  spread,
  toDrawing,
  viewBoxAttr,
  zoomAt,
} from '../_lib/view';
import { clock, num, plural } from './format';
import { usePrefersReducedMotion } from './motion';
import type { IntakeKey } from './types';

/**
 * What Brain Knowledge already knows about itself — and now an instrument
 * rather than a plate.
 *
 * WHY THIS IS NOT A GIMMICK. Every fragment has a vector, and two documents
 * about the same subject have been sitting next to each other in that space
 * since the day they were indexed. Nothing here is generated: an edge is a
 * cosine similarity over a threshold, or a person who demonstrably spoke in
 * both recordings. If neither holds, no line is drawn.
 *
 * WHY A CHORD DIAGRAM AND NOT A FORCE SIMULATION. A force layout is a ball of
 * string that moves while you are trying to read it, it costs a frame budget on
 * a phone, and it has to be specially disabled for reduced motion. A ring with
 * arcs is what a technical manual would print: deterministic, still, readable
 * at a glance, and it groups the four sources so that a line crossing the
 * middle means the thing worth seeing — a call and a document about the same
 * subject.
 *
 * WHAT THE INTERACTIONS ARE FOR. Four hundred arcs at rest are a hairball; the
 * point of pointing at one document is that every arc that is not its own goes
 * quiet, and the tangle becomes a sentence: *this call and those two documents
 * are about the same thing*. Zoom and drag exist for the same reason — on a
 * phone the ring is 340 pixels across and two neighbouring nodes are four
 * pixels apart.
 *
 * WHY THE viewBox IS NOT REACT STATE. Panning fires a pointer event every
 * frame. Routing that through `useState` would re-render sixty nodes and four
 * hundred arcs sixty times a second on a device that cannot afford it, so the
 * window lives in a ref and is written straight onto the `viewBox` attribute.
 * React state is kept for the things that actually change what is drawn — which
 * document is lit, and whether the ring is zoomed at all.
 */

interface GraphNode {
  id: string;
  title: string;
  source: IntakeKey;
  speakers: string[];
  durationSeconds: number | null;
  chunks: number;
  /** Where it is filed, so the ring can open it. Absent if the row vanished. */
  spaceId?: string;
  spaceName?: string;
}

interface Semantic {
  a: string;
  b: string;
  score: number;
}

interface People {
  a: string;
  b: string;
  names: string[];
}

interface Graph {
  nodes: GraphNode[];
  semantic: Semantic[];
  people: People[];
  considered: number;
  total: number;
  indexing: number;
  minSimilarity: number;
}

/** What the page asks of the graph when a document is opened from the ring. */
export interface OpenTarget {
  documentId: string;
  title: string;
  spaceId?: string;
  spaceName?: string;
}

export const SOURCE_LABEL: Record<IntakeKey, string> = {
  upload: 'Documentos',
  meeting: 'Reuniones',
  record: 'Grabaciones',
  drive: 'Google Drive',
};

const SOURCE_ONE: Record<IntakeKey, string> = {
  upload: 'documento',
  meeting: 'reunión',
  record: 'grabación',
  drive: 'archivo de Drive',
};

/** Four tonal steps of the one blue. A rainbow would say nothing extra. */
const SOURCE_TONE: Record<IntakeKey, number> = {
  upload: 1,
  meeting: 0.62,
  record: 0.38,
  drive: 0.16,
};

/** The order sources sit around the ring, so the groups never swap places. */
const RING_ORDER: IntakeKey[] = ['upload', 'meeting', 'record', 'drive'];

const SIZE = 420;
const CENTRE = SIZE / 2;
const RADIUS = 168;

/** Past this, a finger has dragged rather than tapped. */
const TAP_SLOP = 8;

async function fetchGraph(spaceId?: string, source?: IntakeKey): Promise<Graph> {
  const params = new URLSearchParams();
  if (spaceId) params.set('spaceId', spaceId);
  if (source) params.set('source', source);
  const r = await fetch(`/api/kb/graph?${params.toString()}`);
  if (!r.ok) throw new Error('No se pudieron leer las relaciones.');
  return (await r.json()) as Graph;
}

export function RelationsPanel({
  spaceId,
  source,
  onClose,
  onOpenDocument,
  /** Documents the current search landed on, lit before anything is opened. */
  found,
  query,
}: {
  spaceId?: string;
  source?: IntakeKey;
  onClose?: () => void;
  onOpenDocument?: (target: OpenTarget) => void;
  found?: Set<string>;
  query?: string;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['kb-graph', spaceId ?? 'all', source ?? 'all'],
    queryFn: () => fetchGraph(spaceId, source),
  });

  const title = source ? `Relaciones · ${SOURCE_LABEL[source]}` : 'Relaciones';

  return (
    <Panel>
      <PanelHead
        title={title}
        right={
          onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1 rounded-card px-1.5 py-0.5 text-micro font-semibold text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
              Cerrar
            </button>
          ) : data ? (
            `${plural(data.nodes.length, 'documento', 'documentos')}`
          ) : null
        }
      />
      <p className="px-5 pt-1 text-xs text-ink-muted">
        Lo que ya está indexado y de qué se parece a qué.
      </p>

      <div className="mt-3 border-t border-border">
        {isLoading ? (
          <p className="px-5 py-8 text-center text-xs text-ink-faint">
            Leyendo las relaciones…
          </p>
        ) : isError || !data ? (
          <p className="px-5 py-8 text-center text-xs text-rose">
            No se pudieron leer las relaciones. Vuelve a intentar.
          </p>
        ) : (
          <GraphBody
            data={data}
            onOpenDocument={onOpenDocument}
            found={found ?? null}
            query={query ?? ''}
          />
        )}
      </div>
    </Panel>
  );
}

function GraphBody({
  data,
  onOpenDocument,
  found,
  query,
}: {
  data: Graph;
  onOpenDocument?: (target: OpenTarget) => void;
  found: Set<string> | null;
  query: string;
}) {
  const { nodes, semantic, people } = data;
  const reduced = usePrefersReducedMotion();

  /** Pointed at with a mouse: the highlight follows and nothing is committed. */
  const [hovered, setHovered] = useState<string | null>(null);
  /** Chosen — by a tap, the select, or opening one. Survives the pointer. */
  const [chosen, setChosen] = useState<string | null>(null);
  /** Only whether the ring has been zoomed at all, which changes the gestures. */
  const [zoomed, setZoomed] = useState(false);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const view = useRef<ViewBox>(fitView(SIZE));
  const glide = useRef<number | null>(null);

  // Degree first, because it decides where a node sits inside its group: the
  // most connected documents end up next to the middle of their arc, which
  // keeps the busiest lines short.
  const layout = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of [...semantic, ...people]) {
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    }
    const ordered = RING_ORDER.flatMap((source) =>
      nodes
        .filter((n) => n.source === source)
        .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)),
    );
    const positions = new Map<string, { x: number; y: number; angle: number }>();
    ordered.forEach((n, i) => {
      // Start at the top and go clockwise; one full turn over every node.
      const angle = (i / Math.max(ordered.length, 1)) * Math.PI * 2 - Math.PI / 2;
      positions.set(n.id, {
        x: CENTRE + Math.cos(angle) * RADIUS,
        y: CENTRE + Math.sin(angle) * RADIUS,
        angle,
      });
    });
    return { ordered, positions, degree };
  }, [nodes, semantic, people]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // Built once per graph so that lighting a node is a lookup, not a scan of
  // four hundred edges on every pointer move.
  const neighbours = useMemo(() => neighbourMap(semantic, people), [semantic, people]);

  const lit = hovered ?? chosen;
  const litIds = useMemo(() => litSet(lit, neighbours), [lit, neighbours]);
  const detail = lit ? (byId.get(lit) ?? null) : null;

  /* --------------------------------------------------------------- viewBox */

  const apply = useCallback((next: ViewBox) => {
    view.current = next;
    svgRef.current?.setAttribute('viewBox', viewBoxAttr(next));
    setZoomed((was) => {
      const now = scaleOf(next, SIZE) > 1.02;
      return was === now ? was : now;
    });
  }, []);

  /** Glide the window to a target, or land on it at once if motion is off. */
  const settle = useCallback(
    (target: ViewBox) => {
      if (glide.current !== null) cancelAnimationFrame(glide.current);
      if (reduced) {
        apply(target);
        return;
      }
      const from = view.current;
      const started = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - started) / 420);
        // Ease out: fast where the eye is following, slow where it lands.
        const k = 1 - (1 - t) ** 3;
        apply({
          x: from.x + (target.x - from.x) * k,
          y: from.y + (target.y - from.y) * k,
          w: from.w + (target.w - from.w) * k,
          h: from.h + (target.h - from.h) * k,
        });
        if (t < 1) glide.current = requestAnimationFrame(step);
        else glide.current = null;
      };
      glide.current = requestAnimationFrame(step);
    },
    [apply, reduced],
  );

  useEffect(() => {
    return () => {
      if (glide.current !== null) cancelAnimationFrame(glide.current);
    };
  }, []);

  const centreNode = useCallback(
    (id: string) => {
      const at = layout.positions.get(id);
      if (!at) return;
      const current = view.current;
      // Coming in from "everything fits" also tightens a little, because
      // centring a node at full extent moves nothing anybody can see.
      const w = Math.min(current.w, SIZE / 1.9);
      settle(centreOn({ ...current, w, h: w }, SIZE, at.x, at.y));
    },
    [layout, settle],
  );

  /** The buttons zoom about the middle of what is on screen, not of the plate. */
  const step = useCallback(
    (factor: number) => {
      const at = view.current;
      settle(zoomAt(at, SIZE, factor, at.x + at.w / 2, at.y + at.h / 2));
    },
    [settle],
  );

  const open = useCallback(
    (id: string) => {
      const node = byId.get(id);
      if (!node) return;
      setChosen(id);
      centreNode(id);
      onOpenDocument?.({
        documentId: node.id,
        title: node.title,
        ...(node.spaceId ? { spaceId: node.spaceId } : {}),
        ...(node.spaceName ? { spaceName: node.spaceName } : {}),
      });
    },
    [byId, centreNode, onOpenDocument],
  );

  /* -------------------------------------------------------------- gestures */

  const pointers = useRef(new Map<number, { clientX: number; clientY: number }>());
  const drag = useRef<{
    id: number;
    clientX: number;
    clientY: number;
    from: ViewBox;
    node: string | null;
    kind: string;
    moved: boolean;
  } | null>(null);
  const pinch = useRef<number | null>(null);
  /** Set by a node's own handler, which runs before the surface's. */
  const pressed = useRef<string | null>(null);

  const rect = () => svgRef.current?.getBoundingClientRect() ?? null;

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    // A hand on the graph outranks a glide that is still finishing.
    if (glide.current !== null) {
      cancelAnimationFrame(glide.current);
      glide.current = null;
    }
    pointers.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    if (pointers.current.size === 1) {
      drag.current = {
        id: e.pointerId,
        clientX: e.clientX,
        clientY: e.clientY,
        from: view.current,
        node: pressed.current,
        kind: e.pointerType,
        moved: false,
      };
      svgRef.current?.setPointerCapture(e.pointerId);
    } else if (pointers.current.size === 2) {
      // Two fingers is a pinch, never a tap and never a drag.
      const [a, b] = [...pointers.current.values()];
      if (a && b) pinch.current = spread(a, b);
      drag.current = null;
    }
    pressed.current = null;
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    const box = rect();
    if (!box) return;

    if (pointers.current.size >= 2 && pinch.current !== null) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const now = spread(a, b);
      if (now <= 0 || pinch.current <= 0) return;
      const factor = now / pinch.current;
      pinch.current = now;
      const mid = toDrawing(
        view.current,
        box,
        (a.clientX + b.clientX) / 2,
        (a.clientY + b.clientY) / 2,
      );
      apply(zoomAt(view.current, SIZE, factor, mid.x, mid.y));
      return;
    }

    const held = drag.current;
    if (!held || held.id !== e.pointerId) return;
    const dxClient = e.clientX - held.clientX;
    const dyClient = e.clientY - held.clientY;
    if (!held.moved && Math.hypot(dxClient, dyClient) < TAP_SLOP) return;
    held.moved = true;
    // Client pixels into drawing units, so a finger keeps the point it grabbed.
    const dx = (dxClient / box.width) * held.from.w;
    const dy = (dyClient / box.height) * held.from.h;
    apply(panBy(held.from, dx, dy, SIZE));
  }

  function endPointer(e: ReactPointerEvent<SVGSVGElement>, cancelled: boolean) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    // Releasing a capture that was never taken throws, and a cancelled pointer
    // has usually had it taken away already.
    if (svgRef.current?.hasPointerCapture(e.pointerId)) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }

    const held = drag.current;
    if (!held || held.id !== e.pointerId) return;
    drag.current = null;
    if (cancelled || held.moved || !held.node) return;

    // A mouse click is a decision — it opens. A finger has no hover, so the
    // first tap does the lighting-up a mouse gets for free and the second one
    // opens, which is the same two steps in the same order.
    if (held.kind === 'mouse' || !onOpenDocument) {
      if (onOpenDocument) open(held.node);
      else setChosen((was) => (was === held.node ? null : held.node));
      return;
    }
    if (chosen === held.node) open(held.node);
    else setChosen(held.node);
  }

  // Wheel has to be a native listener: React's is passive, and a passive
  // listener cannot stop the page from scrolling while the graph zooms.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      // A page scrolled with the wheel must not be caught and zoomed by a
      // graph that happens to be under the cursor. It takes the wheel only
      // when asked — Ctrl or Cmd held, which is also how a trackpad pinch
      // arrives — or once it is already zoomed and clearly the thing in use.
      const asked = e.ctrlKey || e.metaKey;
      if (!asked && scaleOf(view.current, SIZE) <= 1.02) return;
      e.preventDefault();
      const box = svg.getBoundingClientRect();
      const at = toDrawing(view.current, box, e.clientX, e.clientY);
      const factor = Math.exp(-e.deltaY * (asked ? 0.01 : 0.0022));
      apply(zoomAt(view.current, SIZE, factor, at.x, at.y));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [apply]);

  /* ----------------------------------------------------------------- empty */

  if (nodes.length === 0) {
    return (
      <p className="px-5 py-8 text-xs leading-relaxed text-ink-muted">
        Todavía no hay nada indexado aquí.{' '}
        {data.indexing > 0
          ? `${plural(data.indexing, 'documento está', 'documentos están')} en proceso: sus vectores aún no existen.`
          : 'Añade un documento y en un minuto aparecen sus relaciones.'}
      </p>
    );
  }

  if (nodes.length === 1) {
    return (
      <p className="px-5 py-8 text-xs leading-relaxed text-ink-muted">
        Con un solo documento no hay relaciones que mostrar. Añade otro del mismo tema y la línea
        aparece sola.
      </p>
    );
  }

  const noEdges = semantic.length === 0 && people.length === 0;
  const hits = found ? nodes.filter((n) => found.has(n.id)).length : 0;

  /** Quiet unless it is the lit neighbourhood, or a search hit when nothing is lit. */
  const isDim = (id: string): boolean => {
    if (litIds) return !litIds.has(id);
    if (found && found.size > 0) return !found.has(id);
    return false;
  };
  const edgeDim = (a: string, b: string): boolean => {
    if (litIds) return !(litIds.has(a) && litIds.has(b));
    if (found && found.size > 0) return !(found.has(a) || found.has(b));
    return false;
  };

  return (
    <div>
      <div className="grid gap-px bg-border lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
        <div className="bg-surface px-4 py-4">
          <div className="relative">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              className={clsx('w-full select-none text-primary', zoomed && 'cursor-grab')}
              // At rest the ring has nothing to pan to, so a thumb scrolls the
              // page as it should. Once it is zoomed the gestures are the
              // graph's, and "Reencuadrar" is the way back out.
              style={{ touchAction: zoomed ? 'none' : 'pan-y' }}
              aria-hidden="true"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => endPointer(e, false)}
              onPointerCancel={(e) => endPointer(e, true)}
              onPointerLeave={() => setHovered(null)}
            >
              {/* The ring the documents sit on. Structure, so it is a hairline. */}
              <circle
                cx={CENTRE}
                cy={CENTRE}
                r={RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth={0.5}
                opacity={0.22}
                vectorEffect="non-scaling-stroke"
              />

              {/* People first, underneath: a fact should not hide an inference. */}
              {people.map((e) => {
                const from = layout.positions.get(e.a);
                const to = layout.positions.get(e.b);
                if (!from || !to) return null;
                const dim = edgeDim(e.a, e.b);
                return (
                  <path
                    key={`p-${e.a}-${e.b}`}
                    d={arc(from, to, 0.82)}
                    fill="none"
                    className="text-ink"
                    stroke="currentColor"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                    opacity={dim ? 0.06 : 0.34}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}

              {semantic.map((e) => {
                const from = layout.positions.get(e.a);
                const to = layout.positions.get(e.b);
                if (!from || !to) return null;
                const dim = edgeDim(e.a, e.b);
                return (
                  <path
                    key={`s-${e.a}-${e.b}`}
                    d={arc(from, to, 0.62 + (1 - e.score) * 0.33)}
                    fill="none"
                    stroke="currentColor"
                    // The weight is the similarity, so a thick line means more.
                    strokeWidth={0.5 + e.score * 1.6}
                    opacity={dim ? 0.06 : 0.2 + e.score * 0.55}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}

              {layout.ordered.map((n) => {
                const at = layout.positions.get(n.id);
                if (!at) return null;
                const side = 5 + Math.min(7, Math.sqrt(n.chunks) * 1.6);
                const on = lit === n.id;
                const dim = isDim(n.id);
                const isHit = found?.has(n.id) ?? false;
                return (
                  <g
                    key={n.id}
                    onPointerDown={() => {
                      pressed.current = n.id;
                    }}
                    onPointerEnter={(e) => {
                      if (e.pointerType === 'mouse') setHovered(n.id);
                    }}
                    onPointerLeave={(e) => {
                      if (e.pointerType === 'mouse')
                        setHovered((was) => (was === n.id ? null : was));
                    }}
                    className="cursor-pointer"
                  >
                    <title>{n.title}</title>
                    {/* A search hit wears a ring of its own, so it stays
                        findable even while another document is lit. */}
                    {isHit && (
                      <circle
                        cx={at.x}
                        cy={at.y}
                        r={side * 0.9 + 3}
                        fill="none"
                        className="text-amber"
                        stroke="currentColor"
                        strokeWidth={1.4}
                        opacity={dim ? 0.5 : 0.95}
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                    <rect
                      x={at.x - side / 2}
                      y={at.y - side / 2}
                      width={side}
                      height={side}
                      fill="currentColor"
                      opacity={dim ? 0.12 : SOURCE_TONE[n.source]}
                      stroke="currentColor"
                      strokeWidth={on ? 2 : n.source === 'drive' ? 0.8 : 0}
                      vectorEffect="non-scaling-stroke"
                    />
                    {/* A generous invisible target: these are tapped on a phone. */}
                    <circle cx={at.x} cy={at.y} r={13} fill="transparent" />
                  </g>
                );
              })}
            </svg>

            {/* Zoom as buttons, not only as a gesture: a wheel is not a control
                anyone can find, and a keyboard has no pinch. */}
            <div className="absolute right-0 top-0 flex flex-col gap-px overflow-hidden rounded-card border border-border bg-border">
              <ZoomButton label="Acercar" onClick={() => step(1.5)}>
                <Plus className="h-3.5 w-3.5" />
              </ZoomButton>
              <ZoomButton label="Alejar" onClick={() => step(1 / 1.5)}>
                <Minus className="h-3.5 w-3.5" />
              </ZoomButton>
              <ZoomButton label="Reencuadrar" onClick={() => settle(fitView(SIZE))}>
                <Maximize2 className="h-3.5 w-3.5" />
              </ZoomButton>
            </div>
          </div>

          {/* The keyboard's way into the same map: every document on the ring
              is in here, and choosing one lights it exactly as pointing does. */}
          <label className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <span className="field-label">Ver un documento</span>
            <select
              value={chosen ?? ''}
              onChange={(e) => {
                const id = e.target.value || null;
                setChosen(id);
                if (id) centreNode(id);
              }}
              className="h-8 max-w-full rounded-card border border-border bg-surface px-2.5 text-xs font-medium text-ink focus:border-border-strong"
            >
              <option value="">Elige uno…</option>
              {layout.ordered.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
          </label>

          <p className="mt-2 text-center text-micro leading-snug text-ink-faint">
            Toca un documento y se encienden solo sus relaciones; tócalo otra vez para abrirlo. Con
            el ratón basta con pasar por encima y hacer clic para abrir. Para acercar: pellizca, usa
            los botones, o Ctrl y la rueda. Arrastra para mover.
          </p>

          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
            {RING_ORDER.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 bg-primary"
                  style={{ opacity: SOURCE_TONE[s] }}
                  aria-hidden
                />
                <span className="field-label">{SOURCE_LABEL[s]}</span>
              </span>
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-micro text-ink-faint">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-px w-6 bg-primary" aria-hidden />
              línea llena: hablan de lo mismo
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-px w-6"
                style={{
                  backgroundImage:
                    'repeating-linear-gradient(90deg, currentColor 0 3px, transparent 3px 6px)',
                }}
                aria-hidden
              />
              punteada: habló la misma persona
            </span>
            {found && found.size > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 rounded-full border border-amber"
                  style={{ borderWidth: 1.5 }}
                  aria-hidden
                />
                círculo: lo que encontró la búsqueda
              </span>
            )}
          </div>
        </div>

        <div className="bg-surface">
          {detail ? (
            <NodeDetail
              node={detail}
              semantic={semantic}
              people={people}
              byId={byId}
              found={found}
              onPick={(id) => {
                setChosen(id);
                centreNode(id);
              }}
              onOpen={onOpenDocument ? () => open(detail.id) : undefined}
              onClose={() => {
                setChosen(null);
                setHovered(null);
              }}
            />
          ) : (
            <div className="px-5 py-5">
              <div className="field-label">Cómo leerlo</div>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                {noEdges
                  ? 'Nada se parece lo suficiente todavía. Cuando entren dos documentos del mismo tema, aparece la línea.'
                  : 'Señala un documento y te muestro con qué se relaciona y por qué.'}
              </p>
              <dl className="mt-4 divide-y divide-border border-y border-border">
                {found && query.trim() !== '' && (
                  <Line
                    label="Coinciden con tu búsqueda"
                    value={num(hits)}
                    hint={hits > 0 ? 'llevan círculo en el mapa' : 'nada de esto responde a eso'}
                  />
                )}
                <Line
                  label="Documentos en el mapa"
                  value={num(nodes.length)}
                  hint={
                    data.total > data.considered
                      ? `los ${num(data.considered)} más recientes de ${num(data.total)}`
                      : 'todo lo indexado'
                  }
                />
                <Line
                  label="Parecidos"
                  value={num(semantic.length)}
                  hint={`por encima de ${data.minSimilarity.toLocaleString('es-CO', { minimumFractionDigits: 2 })} de similitud`}
                />
                <Line
                  label="Personas en común"
                  value={num(people.length)}
                  hint="la misma voz en dos conversaciones"
                />
                {data.indexing > 0 && (
                  <Line
                    label="Sin indexar"
                    value={num(data.indexing)}
                    hint="todavía no tienen vectores"
                  />
                )}
              </dl>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="bg-surface p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
    >
      {children}
    </button>
  );
}

function Line({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <dt className="field-label">{label}</dt>
        <dd className="mt-0.5 text-micro text-ink-faint">{hint}</dd>
      </div>
      <span className="stat-num shrink-0 text-lg text-ink">{value}</span>
    </div>
  );
}

/** One document, and everything it shares with the rest. */
function NodeDetail({
  node,
  semantic,
  people,
  byId,
  found,
  onPick,
  onOpen,
  onClose,
}: {
  node: GraphNode;
  semantic: Semantic[];
  people: People[];
  byId: Map<string, GraphNode>;
  found: Set<string> | null;
  onPick: (id: string) => void;
  onOpen?: () => void;
  onClose: () => void;
}) {
  const alike = semantic
    .filter((e) => e.a === node.id || e.b === node.id)
    .map((e) => ({ other: byId.get(e.a === node.id ? e.b : e.a), score: e.score }))
    .filter((x): x is { other: GraphNode; score: number } => !!x.other)
    .sort((a, b) => b.score - a.score);

  const shared = people
    .filter((e) => e.a === node.id || e.b === node.id)
    .map((e) => ({ other: byId.get(e.a === node.id ? e.b : e.a), names: e.names }))
    .filter((x): x is { other: GraphNode; names: string[] } => !!x.other);

  return (
    <div className="px-5 py-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-bold text-ink">{node.title}</div>
          <div className="mt-0.5 text-micro text-ink-faint">
            {SOURCE_ONE[node.source]} · <span className="tabular">{num(node.chunks)}</span>{' '}
            {node.chunks === 1 ? 'fragmento' : 'fragmentos'}
            {node.durationSeconds ? ` · ${clock(node.durationSeconds)}` : ''}
            {node.spaceName ? ` · ${node.spaceName}` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-card px-1.5 py-0.5 text-micro font-semibold text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
        >
          Quitar
        </button>
      </div>

      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          className="mt-3 inline-flex items-center gap-1.5 rounded-card border border-border px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
        >
          Abrir el documento
        </button>
      )}

      <div className="mt-4">
        <div className="field-label">Habla de lo mismo que</div>
        {alike.length === 0 ? (
          <p className="mt-1.5 text-xs text-ink-muted">
            Nada más se le parece por encima del umbral.
          </p>
        ) : (
          <ul className="mt-1.5 divide-y divide-border border-y border-border">
            {alike.slice(0, 8).map(({ other, score }) => (
              <li key={other.id}>
                {/* Every neighbour is a way to keep walking the graph without
                    going back to the ring to find it with a finger. */}
                <button
                  type="button"
                  onClick={() => onPick(other.id)}
                  className="flex w-full items-center justify-between gap-3 py-1.5 text-left transition-colors hover:bg-surface-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-ink">
                      {other.title}
                      {found?.has(other.id) ? ' ·' : ''}
                    </span>
                    <span className="block text-micro text-ink-faint">
                      {SOURCE_ONE[other.source]}
                      {found?.has(other.id) ? ' · coincide con tu búsqueda' : ''}
                    </span>
                  </span>
                  <span className="stat-num shrink-0 text-xs text-primary">
                    {Math.round(score * 100)}%
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {shared.length > 0 && (
        <div className="mt-4">
          <div className="field-label">Habló la misma persona</div>
          <ul className="mt-1.5 divide-y divide-border border-y border-border">
            {shared.slice(0, 8).map(({ other, names }) => (
              <li key={other.id}>
                <button
                  type="button"
                  onClick={() => onPick(other.id)}
                  className="block w-full py-1.5 text-left transition-colors hover:bg-surface-2"
                >
                  <span className="block truncate text-xs font-medium text-ink">
                    {other.title}
                  </span>
                  <span className="block text-micro text-ink-faint">{names.join(', ')}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {node.speakers.length > 0 && (
        <p className="mt-3 text-micro text-ink-faint">
          Voces en esta: {node.speakers.join(', ')}.
        </p>
      )}
    </div>
  );
}

/**
 * A chord: the two ends joined through a control point pulled toward the
 * centre. `bow` of 0 is a straight line across, 1 passes through the middle.
 */
function arc(from: { x: number; y: number }, to: { x: number; y: number }, bow: number): string {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const cx = midX + (CENTRE - midX) * clamp(bow);
  const cy = midY + (CENTRE - midY) * clamp(bow);
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}
