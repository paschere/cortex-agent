'use client';

import { clsx } from 'clsx';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { num } from '../format';
import { usePrefersReducedMotion } from '../motion';
import {
  CORTEX_PATH,
  type FieldSeed,
  type PlacedSeed,
  STEM_PATHS,
  SULCI,
  VIEWBOX,
  contourLines,
  placeSeeds,
  seedAt,
} from './field-math';

/**
 * The cortex, drawn as a relief map of what it remembers.
 *
 * This is the interface, not an illustration of one. Elevation is fragments —
 * the unit Cortex actually retrieves — so the drawing says, at a glance and
 * without a single number, what this company has documented at length and what
 * it has one page on. Position is what the material is made of: recordings rise
 * over the temporal lobe where hearing lives, filed documents over the frontal.
 * A person who has looked at this map twice knows where to point.
 *
 * WHY A RELIEF AND NOT THE OBVIOUS THINGS. The reflex for "futuristic brain" is
 * a dark canvas, neon synapses and a force-directed cloud that drifts. It looks
 * advanced in a screenshot and it is unusable: the dots move for reasons nobody
 * can explain, they never settle in the same place twice, and at sixty
 * documents it is a hairball. This is light, it is still, it is the same every
 * time it loads, and it is read the way anybody reads a map. What makes it feel
 * advanced is what it DOES — it answers the pointer, it lights up where a
 * retrieval landed before the results have finished rendering, it resolves
 * detail as you approach — rather than what colour it is.
 *
 * IT IS NEVER THE ONLY WAY THROUGH. Everything reachable here is reachable in
 * the list beside it, by keyboard, by typing a name. The map earns its place by
 * saying the things a list cannot — what is near what, what is large, where an
 * answer came from — not by being the only door.
 */

export interface FieldFlare {
  /** Seed id → how strongly the retrieval landed there, 0–1. */
  strength: Map<string, number>;
  /** What was asked, for the caption. */
  query: string;
}

export function BrainField({
  seeds,
  selectedId,
  hoveredId,
  onSelect,
  onHover,
  flare,
  working,
  unit,
  emptyText,
  caption,
}: {
  seeds: FieldSeed[];
  selectedId: string | null;
  /** Driven from the list beside the map, so the two are one control. */
  hoveredId: string | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  /** Where the current probe landed. Null when nothing has been asked. */
  flare: FieldFlare | null;
  /** Ids with something still being read into memory right now. */
  working: Set<string>;
  /** What elevation counts — "fragmentos" up top, the same down a level. */
  unit: string;
  emptyText: string;
  caption: string;
}) {
  const uid = useId();
  const reduced = usePrefersReducedMotion();
  const svgRef = useRef<SVGSVGElement | null>(null);

  // The two expensive things on this page, and both are memoised on the data
  // rather than on the render. Placement relaxes for twelve passes and
  // contouring samples a few thousand grid points; neither may run on a hover.
  const placed = useMemo(() => placeSeeds(seeds), [seeds]);
  const contours = useMemo(() => contourLines(placed), [placed]);

  const byId = useMemo(() => new Map(placed.map((p) => [p.id, p] as const)), [placed]);

  /**
   * Which hills get a permanent name. Labelling forty of them is a page of
   * overlapping text; labelling the biggest handful, plus whatever is being
   * pointed at, selected or lit by a search, names everything that matters at
   * the moment it matters.
   */
  const named = useMemo(() => {
    const keep = new Set(
      [...placed]
        .sort((a, b) => b.height - a.height)
        .slice(0, 5)
        .map((p) => p.id),
    );
    if (selectedId) keep.add(selectedId);
    if (hoveredId) keep.add(hoveredId);
    for (const id of flare?.strength.keys() ?? []) keep.add(id);
    return keep;
  }, [placed, selectedId, hoveredId, flare]);

  /* ----------------------------------------------------------------- lens */

  // The readout that follows the pointer. Held in a ref and committed once per
  // frame: a pointermove fires far more often than the screen refreshes, and
  // setting state on every one of them is exactly how a canvas like this starts
  // to feel sticky under the hand.
  const [lens, setLens] = useState<{ x: number; y: number; seed: PlacedSeed } | null>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef(0);

  const commit = useCallback(() => {
    frame.current = 0;
    const at = pending.current;
    if (!at) return;
    const found = seedAt(at.x, at.y, placed);
    if (!found) {
      setLens(null);
      onHover(null);
      return;
    }
    setLens({ x: at.x, y: at.y, seed: found.seed });
    onHover(found.seed.id);
  }, [placed, onHover]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      // Touch drags the page; a lens that fought the scroll would be worse than
      // no lens. Coarse pointers get tap-to-select and nothing else.
      if (event.pointerType !== 'mouse') return;
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      pending.current = {
        x: ((event.clientX - rect.left) / rect.width) * VIEWBOX.width,
        y: ((event.clientY - rect.top) / rect.height) * VIEWBOX.height,
      };
      if (frame.current === 0) frame.current = requestAnimationFrame(commit);
    },
    [commit],
  );

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const leave = useCallback(() => {
    pending.current = null;
    setLens(null);
    onHover(null);
  }, [onHover]);

  const pick = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const x = ((event.clientX - rect.left) / rect.width) * VIEWBOX.width;
      const y = ((event.clientY - rect.top) / rect.height) * VIEWBOX.height;
      const found = seedAt(x, y, placed);
      if (found) onSelect(found.seed.id);
    },
    [placed, onSelect],
  );

  /* ------------------------------------------------------------- keyboard */

  /**
   * The map is one tab stop, not forty.
   *
   * Forty focusable hills is forty presses of Tab to get past a picture, which
   * is worse for a keyboard user than the map not being reachable at all. So it
   * takes focus once and the arrows walk the hills from largest to smallest —
   * the same order a person reads them by eye. What is under the cursor is
   * announced, so this works read aloud as well as looked at.
   */
  const order = useMemo(() => [...placed].sort((a, b) => b.height - a.height), [placed]);
  const [cursor, setCursor] = useState(-1);
  const at = cursor >= 0 ? order[cursor] : undefined;

  const onKeyDown = useCallback(
    // Typed for the wrapper, which is where the listbox and its keyboard
    // contract live — the SVG inside it only handles the pointer.
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (order.length === 0) return;
      const step = (delta: number) => {
        event.preventDefault();
        setCursor((was) => {
          const next = was < 0 ? 0 : (was + delta + order.length) % order.length;
          onHover(order[next]?.id ?? null);
          return next;
        });
      };
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return step(1);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return step(-1);
      if (event.key === 'Enter' || event.key === ' ') {
        const target = at ?? order[0];
        if (!target) return;
        event.preventDefault();
        onSelect(target.id);
      }
    },
    [order, at, onHover, onSelect],
  );

  const lit = hoveredId ?? at?.id ?? null;
  const empty = placed.length === 0 || placed.every((p) => p.height <= 0);

  return (
    <div>
      {/*
        The keyboard contract lives on this wrapper rather than on the drawing:
        one tab stop, arrows moving a cursor from the largest hill to the
        smallest, Enter opening the one under it. A listbox is precisely that
        behaviour, and putting the role on the element that owns the handlers
        keeps the drawing inside it as what it is — a picture of the options.
      */}
      <div
        className="relative w-full rounded-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        style={{ aspectRatio: `${VIEWBOX.width} / ${VIEWBOX.height}` }}
        tabIndex={0}
        // biome-ignore lint/a11y/useSemanticElements: the rule's advice is to use
        // <select>, which cannot hold a drawing. The options here are the summits
        // rendered inside the SVG below, and the plain <select> equivalent of
        // this whole control is the index list beside the map.
        role="listbox"
        aria-label={`Mapa del cerebro: ${placed.length} zonas, de la más grande a la más pequeña con las flechas. ${caption}`}
        aria-activedescendant={at ? `${uid}-opt-${at.id}` : undefined}
        onKeyDown={onKeyDown}
        onFocus={() => setCursor((was) => (was < 0 ? 0 : was))}
        onBlur={() => {
          setCursor(-1);
          onHover(null);
        }}
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
          className="absolute inset-0 h-full w-full text-primary outline-none"
          onPointerMove={onPointerMove}
          onPointerLeave={leave}
          onPointerDown={pick}
        >
          <title>{caption}</title>
          <defs>
            <clipPath id={`${uid}-cortex`}>
              <path d={CORTEX_PATH} />
            </clipPath>
            {/* One gradient, reused by every hill. A filter per hill would look
                marginally softer and would cost a separate rasterisation pass
                each, which is the whole frame budget on a laptop. */}
            <radialGradient id={`${uid}-hill`}>
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.42" />
              <stop offset="55%" stopColor="currentColor" stopOpacity="0.14" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* The paper the plate is drawn on. */}
          <path d={CORTEX_PATH} className="fill-surface-2" />

          <g clipPath={`url(#${uid}-cortex)`}>
            {placed.map((p) => (
              <circle
                key={p.id}
                cx={p.x}
                cy={p.y}
                r={p.sigma * 2.1}
                fill={`url(#${uid}-hill)`}
                opacity={0.35 + 0.65 * p.height}
                className={clsx(
                  'transition-opacity duration-300',
                  lit && lit !== p.id && 'opacity-40',
                )}
              />
            ))}

            {/* The contour lines. Higher ground gets a firmer line, which is how
                a relief map has always shown that you are near a summit. */}
            {contours.map((c) => (
              <path
                key={c.level}
                d={c.d}
                fill="none"
                stroke="currentColor"
                strokeWidth={0.35 + c.level * 0.5}
                strokeLinecap="round"
                opacity={0.2 + c.level * 0.45}
                pointerEvents="none"
              />
            ))}

            {SULCI.map((d) => (
              <path
                key={d}
                d={d}
                fill="none"
                stroke="currentColor"
                strokeWidth={0.6}
                opacity={0.18}
                strokeLinecap="round"
                pointerEvents="none"
              />
            ))}
          </g>

          {/* The outline last, over the fill, so the edge of the cortex stays a
              clean line however dense the relief gets underneath it. */}
          <path
            d={CORTEX_PATH}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.1}
            strokeLinejoin="round"
            opacity={0.55}
            pointerEvents="none"
          />
          {STEM_PATHS.map((d) => (
            <path
              key={d}
              d={d}
              fill="none"
              stroke="currentColor"
              strokeWidth={0.8}
              opacity={0.22}
              strokeLinecap="round"
              pointerEvents="none"
            />
          ))}

          {/* Where the search landed. This is the one moment the map exists for:
              you type a question and the cortex lights up where the answer
              lives, before a single result has rendered underneath. */}
          {flare &&
            placed.map((p) => {
              const strength = flare.strength.get(p.id);
              if (!strength) return null;
              return (
                <g key={`flare-${p.id}`} pointerEvents="none">
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={p.sigma * 0.85}
                    fill="none"
                    className="text-amber"
                    stroke="currentColor"
                    strokeWidth={1.1 + strength}
                    opacity={0.35 + 0.5 * strength}
                  />
                  {!reduced && (
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={p.sigma * 0.85}
                      fill="none"
                      className="text-amber kb-flare"
                      stroke="currentColor"
                      strokeWidth={1}
                    />
                  )}
                </g>
              );
            })}

          {/* Something is being read into memory right now, here. */}
          {placed.map((p) =>
            working.has(p.id) ? (
              <circle
                key={`work-${p.id}`}
                cx={p.x}
                cy={p.y}
                r={2.6}
                className={clsx('fill-primary', !reduced && 'kb-breathe')}
                pointerEvents="none"
              />
            ) : null,
          )}

          {/* Summit markers. Small, because the hill is the thing; the marker
              only says exactly where to point — and each one is the listbox
              option the keyboard cursor lands on, so what a screen reader reads
              out is the same set of things a sighted person is pointing at. */}
          {placed.map((p) => {
            const on = selectedId === p.id;
            const near = lit === p.id;
            return (
              <g
                key={`peak-${p.id}`}
                id={`${uid}-opt-${p.id}`}
                // biome-ignore lint/a11y/useSemanticElements: the rule's advice is
                // to use <option>, which cannot exist inside an SVG. These are the
                // options of the listbox declared on the wrapper above, and they
                // have to be the drawn summits themselves so that
                // aria-activedescendant points at what the cursor is sitting on.
                role="option"
                aria-selected={at?.id === p.id}
                aria-label={`${p.label}: ${num(Math.round(p.weight))} ${unit}`}
                pointerEvents="none"
              >
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={on ? 3 : near ? 2.6 : 1.7}
                  className={clsx(on || near ? 'fill-primary' : 'fill-primary/50')}
                  style={{ transition: reduced ? undefined : 'r 160ms ease-out' }}
                />
                {(on || near) && (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={on ? 6 : 5}
                    fill="none"
                    className="stroke-primary"
                    strokeWidth={0.9}
                    opacity={0.55}
                  />
                )}
              </g>
            );
          })}
        </svg>

        {/* Names as real HTML, not SVG text: the container's aspect ratio is
            pinned to the viewBox so percentages land exactly on the drawing,
            and the labels get the product's typography instead of whatever an
            SVG font-size happens to scale to. */}
        {placed.map((p) => {
          if (!named.has(p.id)) return null;
          const on = selectedId === p.id;
          const near = lit === p.id;
          return (
            <span
              key={`label-${p.id}`}
              aria-hidden
              className={clsx(
                'pointer-events-none absolute max-w-[38%] -translate-x-1/2 truncate rounded-pill px-1.5 py-px text-micro font-semibold leading-tight',
                on
                  ? 'bg-primary text-white shadow-pop'
                  : near
                    ? 'bg-surface text-ink shadow-card'
                    : 'text-ink-muted',
              )}
              style={{
                left: `${(p.x / VIEWBOX.width) * 100}%`,
                top: `${((p.y - p.sigma * 0.5 - 7) / VIEWBOX.height) * 100}%`,
              }}
            >
              {p.label}
            </span>
          );
        })}

        {/* The lens: what you are standing on, and how much of it there is.
            Reveal-on-approach is the futurism budget spent on behaviour rather
            than on colour — nothing here glows, it simply answers. */}
        {lens && (
          <div
            aria-hidden
            className="pointer-events-none absolute z-10 -translate-x-1/2 translate-y-2 whitespace-nowrap rounded-card border border-border bg-surface px-2.5 py-1.5 shadow-pop"
            style={{
              left: `${Math.min(88, Math.max(12, (lens.x / VIEWBOX.width) * 100))}%`,
              top: `${(lens.y / VIEWBOX.height) * 100}%`,
            }}
          >
            <div className="max-w-[220px] truncate text-xs font-bold text-ink">
              {lens.seed.label}
            </div>
            <div className="stat-num mt-0.5 text-micro text-primary">
              {num(Math.round(lens.seed.weight))}{' '}
              <span className="font-sans text-micro font-medium text-ink-faint">{unit}</span>
            </div>
          </div>
        )}

        {empty && (
          <div className="absolute inset-0 grid place-items-center px-6">
            <p className="max-w-[16rem] text-center text-xs leading-relaxed text-ink-faint">
              {emptyText}
            </p>
          </div>
        )}
      </div>

      {/* Said out loud as well as drawn, once, for anybody arriving by keyboard
          or by screen reader. */}
      <p className="mt-1 min-h-[16px] text-center text-micro text-ink-faint" aria-live="polite">
        {at ? (
          <>
            <span className="font-semibold text-ink">{at.label}</span> ·{' '}
            <span className="tabular">{num(Math.round(at.weight))}</span> {unit} · Enter para entrar
          </>
        ) : (
          caption
        )}
      </p>
    </div>
  );
}
