'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { num, weekLabel } from './format';
import { usePrefersReducedMotion } from './motion';
import type { BrainStats, IntakeKey } from './types';

/**
 * The anatomical plate.
 *
 * WHAT IT IS. A brain drawn the way a technical manual draws one: ink outline
 * on paper, numbered regions, a key underneath. Not a mascot and not a 3D
 * render — the same drafting language as the rest of the interface.
 *
 * WHY IT IS NOT DECORATION. Each region is one of the four sources, and its
 * ink level is that source's indexed documents measured against the largest
 * region. Nothing here is styled from a constant: an empty Knowledge Base
 * draws an empty outline, and a region rises the moment a document of that
 * kind finishes indexing. The exact counts are printed in the key beside it,
 * because a shape is a comparison and only the figure is evidence.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. There is no "your brain is 34% full".
 * No capacity exists to divide by, and inventing one would make every honest
 * figure on this page suspect. The one percentage shown is the one with a real
 * denominator: of everything handed over, how much can actually be recalled.
 */

interface Region {
  key: IntakeKey;
  /** Number on the plate, and in the key. */
  index: number;
  label: string;
  /** Anatomical name, printed small — this is a plate, so it says what it is. */
  latin: string;
  path: string;
  /** Vertical extent of the region, so its level rises inside its own bounds. */
  top: number;
  bottom: number;
  /** Where the plate number sits. */
  at: [number, number];
}

/**
 * Four lobes that tile one cerebrum. The temporal lobe carries the recordings
 * on purpose: it is where hearing lives, and a plate that puts audio anywhere
 * else would be a drawing that lies about itself.
 */
const REGIONS: Region[] = [
  {
    key: 'upload',
    index: 1,
    label: 'Documentos',
    latin: 'lóbulo frontal',
    path: 'M 22 82 C 22 64 30 48 46 40 C 58 30 72 24 88 23 C 84 46 84 76 84 102 C 68 100 52 98 40 96 C 33 93 26 88 22 82 Z',
    top: 23,
    bottom: 102,
    at: [52, 72],
  },
  {
    key: 'meeting',
    index: 2,
    label: 'Reuniones',
    latin: 'lóbulo parietal',
    path: 'M 88 23 C 104 21 120 23 134 28 C 141 30 146 31 150 33 C 148 58 144 84 140 107 C 121 106 102 104 84 102 C 84 76 84 46 88 23 Z',
    top: 21,
    bottom: 107,
    at: [114, 60],
  },
  {
    key: 'drive',
    index: 3,
    label: 'Google Drive',
    latin: 'lóbulo occipital',
    path: 'M 150 33 C 166 42 182 60 195 86 C 196 96 192 104 185 109 C 178 113 170 114 162 112 C 155 111 147 109 140 107 C 144 84 148 58 150 33 Z',
    top: 33,
    bottom: 112,
    at: [170, 72],
  },
  {
    key: 'record',
    index: 4,
    label: 'Grabaciones',
    latin: 'lóbulo temporal',
    path: 'M 40 96 C 52 98 68 100 84 102 C 102 104 121 106 140 107 C 147 109 155 111 162 112 C 160 124 150 134 134 138 C 116 142 96 138 82 128 C 72 121 64 112 56 108 C 50 104 45 100 40 96 Z',
    top: 96,
    bottom: 140,
    at: [104, 118],
  },
];

/** What each region is called, for the sentences the panel writes about it. */
const LABEL_OF = Object.fromEntries(REGIONS.map((r) => [r.key, r.label])) as Record<
  IntakeKey,
  string
>;

/** Engraved gyri. They carry no data — they are what makes it a drawing. */
const SULCI = [
  'M 32 74 C 42 66 54 60 66 57',
  'M 34 86 C 44 80 56 75 70 72',
  'M 92 40 C 106 34 122 33 136 37',
  'M 90 60 C 106 53 124 51 140 55',
  'M 88 82 C 104 76 122 74 138 78',
  'M 156 50 C 166 56 175 65 182 76',
  'M 152 74 C 162 79 171 86 178 94',
  'M 50 104 C 70 112 94 118 120 118',
  'M 62 120 C 80 128 100 132 122 131',
];

/**
 * Cerebellum and brainstem: outline only, and deliberately not a region. They
 * hold no data, and filling them would imply a fifth source that does not
 * exist.
 */
const ANATOMY = [
  'M 166 113 C 186 114 202 125 199 139 C 196 151 178 156 163 149 C 155 145 151 136 153 127',
  'M 160 122 C 174 122 187 126 196 133',
  'M 158 133 C 170 133 182 137 191 143',
  'M 150 116 C 152 130 150 145 144 156',
  'M 163 150 C 163 158 160 164 156 168',
];

export function BrainPanel({
  stats,
  openRegion,
  onOpenRegion,
  /** Where the current search landed, counted by source. */
  hits,
  searching,
}: {
  stats: BrainStats;
  openRegion?: IntakeKey | null;
  /** Choosing a region narrows the whole page to that source. */
  onOpenRegion?: (key: IntakeKey) => void;
  hits?: Record<IntakeKey, number> | null;
  searching?: boolean;
}) {
  const total =
    stats.stages.waiting + stats.stages.digesting + stats.stages.memory + stats.stages.stuck;
  const pct = total > 0 ? Math.round((stats.stages.memory / total) * 100) : 0;
  const peak = Math.max(...REGIONS.map((r) => stats.indexed[r.key]), 1);
  const active = openRegion ?? null;

  return (
    <Panel>
      <PanelHead
        title="Alimentación"
        right={
          active && onOpenRegion ? (
            <button
              type="button"
              onClick={() => onOpenRegion(active)}
              className="inline-flex items-center gap-1 rounded-card px-1.5 py-0.5 text-[11.5px] font-semibold text-primary transition-colors hover:bg-surface-2"
            >
              <X className="h-3.5 w-3.5" />
              Ver todo
            </button>
          ) : total > 0 ? (
            `${num(total)} en total`
          ) : (
            'sin nada dentro'
          )
        }
      />
      <p className="px-5 pt-1 text-[12.5px] text-ink-muted">
        {active
          ? `Toda la página está mostrando solo ${LABEL_OF[active].toLowerCase()}.`
          : 'Cada región es una fuente. Toca una y el resto de la página se filtra a ella.'}
      </p>

      <div className="mt-3 grid gap-px border-t border-border bg-border sm:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="bg-surface px-5 py-4">
          <Plate
            stats={stats}
            peak={peak}
            active={active}
            onOpen={onOpenRegion}
            hits={hits ?? null}
            searching={searching ?? false}
          />
        </div>

        <div className="flex flex-col bg-surface">
          <div className="px-5 pt-4">
            <div className="field-label">Ya indexado</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="stat-num text-[38px] leading-none text-ink">{num(pct)}</span>
              <span className="stat-num text-[18px] leading-none text-ink-faint">%</span>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-ink-faint">
              de lo que le has dado, esto ya lo puede citar.
            </p>
            <ReadyBar stats={stats} total={total} />
          </div>

          {/* The key: plate number, what it is, and the count the shape stands
              for. The figure is the evidence; the drawing is the comparison. */}
          {/* The key is the same control written out, for the same reason a
              plate has a key at all: an odd-shaped lobe is a poor target for a
              thumb and impossible to name out loud. */}
          <ul className="mt-3 divide-y divide-border border-t border-border">
            {REGIONS.map((r) => {
              const on = openRegion === r.key;
              const found = hits?.[r.key] ?? 0;
              return (
                <li key={r.key}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => onOpenRegion?.(r.key)}
                    disabled={!onOpenRegion}
                    className={clsx(
                      'flex w-full items-center justify-between gap-3 px-5 py-2 text-left transition-colors',
                      on ? 'bg-primary-soft' : 'hover:bg-surface-2',
                      !onOpenRegion && 'cursor-default',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="stat-num w-4 shrink-0 text-[11px] text-primary">
                        {r.index}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[12px] font-semibold text-ink">
                          {r.label}
                        </span>
                        <span className="block truncate text-[10px] text-ink-faint">
                          {found > 0 ? `${num(found)} de tu búsqueda` : r.latin}
                        </span>
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {found > 0 && (
                        <span className="rounded-card bg-amber-soft px-1.5 py-0.5 text-[10.5px] font-bold text-amber">
                          {num(found)}
                        </span>
                      )}
                      <span className="stat-num text-[15px] text-ink">
                        {num(stats.indexed[r.key])}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {onOpenRegion && (
            <p className="px-5 pb-4 pt-2 text-[11px] text-ink-faint">
              {openRegion
                ? 'Toca la misma región otra vez, o «Ver todo», para quitar el filtro.'
                : 'Toca una región y abajo verás solo eso: su indexación, su crecimiento y sus relaciones.'}
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** The drawing itself, and the control it turned out to be. */
function Plate({
  stats,
  peak,
  active,
  onOpen,
  hits,
  searching,
}: {
  stats: BrainStats;
  peak: number;
  active: IntakeKey | null;
  onOpen?: (key: IntakeKey) => void;
  hits: Record<IntakeKey, number> | null;
  searching: boolean;
}) {
  const uid = useId();
  const reduced = usePrefersReducedMotion();
  const [grown, setGrown] = useState<IntakeKey | null>(null);
  const [pointed, setPointed] = useState<IntakeKey | null>(null);
  const [focused, setFocused] = useState<IntakeKey | null>(null);
  const before = useRef(stats.indexed);

  // A region that has just gained a document is worth one quiet second of
  // attention. Once, then it settles back into the drawing. Someone who has
  // asked for less movement gets the sentence underneath and no wash: the level
  // still rises, it simply arrives instead of travelling.
  useEffect(() => {
    const risen = REGIONS.find((r) => stats.indexed[r.key] > before.current[r.key]);
    before.current = stats.indexed;
    if (!risen) return;
    setGrown(risen.key);
    const t = setTimeout(() => setGrown(null), reduced ? 3200 : 1800);
    return () => clearTimeout(t);
  }, [stats.indexed, reduced]);

  const empty = REGIONS.every((r) => stats.indexed[r.key] === 0);
  const grownRegion = REGIONS.find((r) => r.key === grown) ?? null;
  const anyHits = hits ? REGIONS.some((r) => (hits[r.key] ?? 0) > 0) : false;

  return (
    <div>
      {/* The regions are the control, so they are buttons: reachable by Tab,
          operated by Enter or Space, and drawn with their own focus ring
          because an outline on an SVG group is not to be relied on. */}
      <svg viewBox="0 0 230 180" className="w-full text-primary">
        <title>Las cuatro fuentes de Brain Knowledge</title>
        <defs>
          {REGIONS.map((r) => (
            <clipPath key={r.key} id={`${uid}-${r.key}`}>
              <path d={r.path} />
            </clipPath>
          ))}
        </defs>

        {REGIONS.map((r) => {
          const level = Math.min(1, stats.indexed[r.key] / peak);
          const height = (r.bottom - r.top) * level;
          const y = r.bottom - height;
          const on = active === r.key;
          const near = pointed === r.key || focused === r.key;
          // The wash is the one flourish, and it is the first thing to go when
          // somebody has asked for less movement: with transitions flattened it
          // would be a blink rather than a rise. The line underneath says it
          // in words instead, which nobody has to be able to see move.
          const rose = grown === r.key && !reduced;
          const found = hits?.[r.key] ?? 0;
          // While a search is on, the regions it did not touch step back so the
          // ones that hold the answer are the ones you see.
          const quiet = anyHits && found === 0;
          const ink = rose ? 0.36 : on ? 0.28 : near ? 0.24 : quiet ? 0.07 : 0.16;
          return (
            <g
              key={r.key}
              role={onOpen ? 'button' : undefined}
              tabIndex={onOpen ? 0 : undefined}
              aria-pressed={onOpen ? on : undefined}
              aria-label={
                onOpen
                  ? `${r.label}: ${num(stats.indexed[r.key])} indexados${
                      found > 0 ? `, ${num(found)} de tu búsqueda` : ''
                    }. ${on ? 'Quitar el filtro' : 'Filtrar la página a esta fuente'}`
                  : undefined
              }
              onClick={onOpen ? () => onOpen(r.key) : undefined}
              onKeyDown={
                onOpen
                  ? (e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      onOpen(r.key);
                    }
                  : undefined
              }
              onPointerEnter={(e) => {
                if (e.pointerType === 'mouse') setPointed(r.key);
              }}
              onPointerLeave={(e) => {
                if (e.pointerType === 'mouse') setPointed((was) => (was === r.key ? null : was));
              }}
              onFocus={() => setFocused(r.key)}
              onBlur={() => setFocused((was) => (was === r.key ? null : was))}
              className={clsx('outline-none', onOpen && 'cursor-pointer')}
            >
              <title>{`${r.label}: ${stats.indexed[r.key]}`}</title>
              {/* The whole lobe is the target, filled or not: an empty region
                  is exactly the one somebody wants to press to find out why. */}
              <path d={r.path} fill="transparent" />
              <rect
                x={0}
                y={y}
                width={230}
                height={height}
                clipPath={`url(#${uid}-${r.key})`}
                fill="currentColor"
                opacity={ink}
                pointerEvents="none"
                // Geometry properties animate where the browser supports them
                // as CSS; where it does not, the level simply snaps. The
                // reduced-motion rule in globals.css flattens all three.
                style={{ transition: 'y 700ms ease-out, height 700ms ease-out, opacity 600ms' }}
              />
              <path
                d={r.path}
                fill="none"
                stroke="currentColor"
                strokeWidth={rose || on ? 1.6 : near ? 1.3 : 1}
                strokeLinejoin="round"
                pointerEvents="none"
                style={{ transition: 'stroke-width 400ms' }}
              />
              {/* A search hit outlines the lobe in the same amber the ring uses,
                  so "it is in the recordings" is legible before anything opens. */}
              {found > 0 && (
                <path
                  d={r.path}
                  fill="none"
                  className="text-amber"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinejoin="round"
                  opacity={searching ? 0.45 : 0.9}
                  pointerEvents="none"
                />
              )}
              {/* The focus ring, drawn rather than outlined: browsers disagree
                  about outlines on SVG, and they agree about paths. */}
              {focused === r.key && (
                <path
                  d={r.path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.4}
                  strokeDasharray="3 3"
                  opacity={0.5}
                  pointerEvents="none"
                  className="text-primary"
                />
              )}
            </g>
          );
        })}

        {SULCI.map((d) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={0.7}
            opacity={0.45}
            strokeLinecap="round"
          />
        ))}

        {ANATOMY.map((d) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={0.9}
            opacity={0.3}
            strokeLinecap="round"
          />
        ))}

        {REGIONS.map((r) => (
          <text
            key={r.key}
            x={r.at[0]}
            y={r.at[1]}
            textAnchor="middle"
            className="stat-num"
            fontSize={9}
            fill="currentColor"
            opacity={0.75}
          >
            {r.index}
          </text>
        ))}
      </svg>

      {/* The moment the page exists for, said out loud as well as drawn: a
          region grew because something finished indexing while you watched.
          `aria-live` so it is announced once and never repeated. */}
      <p className="mt-1 text-center text-[11px] text-ink-faint" aria-live="polite">
        {grownRegion ? (
          <span className="font-semibold text-emerald">
            {grownRegion.label}: acaba de entrar algo en memoria.
          </span>
        ) : empty ? (
          'Vacío. Lo que le des se va viendo aquí.'
        ) : (
          'El nivel sube cuando algo termina de indexarse.'
        )}
      </p>
    </div>
  );
}

/** Indexed, in process and stuck, end to end. The percentage made visible. */
function ReadyBar({ stats, total }: { stats: BrainStats; total: number }) {
  const working = stats.stages.waiting + stats.stages.digesting;
  const segments: Array<{ label: string; value: number; bar: string; text: string }> = [
    { label: 'indexado', value: stats.stages.memory, bar: 'bg-primary', text: 'text-primary' },
    { label: 'en proceso', value: working, bar: 'bg-amber', text: 'text-amber' },
    { label: 'atascado', value: stats.stages.stuck, bar: 'bg-rose', text: 'text-rose' },
  ];

  return (
    <div className="mt-3 pb-4">
      <div className="flex h-2 w-full overflow-hidden border border-border bg-surface-2">
        {total > 0 &&
          segments.map((s) =>
            s.value === 0 ? null : (
              <span
                key={s.label}
                className={clsx('h-full transition-[width] duration-700', s.bar)}
                style={{ width: `${(s.value / total) * 100}%` }}
              />
            ),
          )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
        {segments.map((s) => (
          <span key={s.label} className="text-[10.5px] text-ink-faint">
            <span className={clsx('stat-num', s.text)}>{num(s.value)}</span> {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- growth */

/**
 * What it has taken in, week by week. Documents rather than fragments because
 * a document is what a person remembers handing over, and because the count is
 * one this page already holds — no figure here is derived from another chart.
 */
export function GrowthPanel({ stats, focus }: { stats: BrainStats; focus?: IntakeKey | null }) {
  const peak = Math.max(...stats.growth.map((w) => w.added), 1);
  const anything = stats.growth.some((w) => w.added > 0);
  const quarter = stats.growth.reduce((sum, w) => sum + w.added, 0);
  const first = stats.growth[0];
  const last = stats.growth[stats.growth.length - 1];

  return (
    <Panel>
      <PanelHead
        title="Lo que ha aprendido"
        right={focus ? `solo ${LABEL_OF[focus].toLowerCase()}` : 'últimas 12 semanas'}
      />
      <p className="px-5 pt-1 text-[12.5px] text-ink-muted">
        {anything
          ? `${num(quarter)} documentos entraron en este trimestre.`
          : focus
            ? `No ha entrado nada de ${LABEL_OF[focus].toLowerCase()} en las últimas 12 semanas.`
            : 'No ha entrado nada en las últimas 12 semanas.'}
      </p>

      <div className="border-t border-border px-5 pb-4 pt-4">
        <div className="flex items-end gap-1" style={{ height: 96 }}>
          {stats.growth.map((week) => {
            const h = week.added === 0 ? 2 : Math.max(4, (week.added / peak) * 96);
            return (
              <div
                key={week.start}
                className="group relative flex-1"
                style={{ height: `${h}px` }}
                title={`${weekLabel(week.start)}: ${num(week.added)}`}
              >
                <div
                  className={clsx(
                    'h-full w-full transition-[height] duration-700',
                    week.added === 0 ? 'bg-border' : 'bg-primary',
                  )}
                />
              </div>
            );
          })}
        </div>

        {/* Ruled baseline, then the ends of the axis labelled directly — a
            legend would only repeat what two dates already say. */}
        <div className="mt-1 border-t border-border-strong pt-1.5">
          <div className="flex items-center justify-between text-[10.5px] text-ink-faint">
            <span className="tabular">{first ? weekLabel(first.start) : ''}</span>
            <span>
              máximo <span className="stat-num text-ink-muted">{num(peak)}</span> por semana
            </span>
            <span className="tabular">{last ? `${weekLabel(last.start)} (esta)` : ''}</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
