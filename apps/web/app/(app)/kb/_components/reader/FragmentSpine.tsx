'use client';

import { clsx } from 'clsx';
import { useCallback, useMemo, useRef } from 'react';
import { num } from '../format';
import type { SpineBucket } from '../types';

/**
 * A whole document at a glance: how substantial its fragments are along its
 * length, and which stretches have never been used to answer anything.
 *
 * WHY IT EXISTS. Thirty fragments fit on a screen and a transcript can hold two
 * thousand. Without something that draws the whole thing, "where am I" has no
 * answer and paging through is the only way to find anything — which for a long
 * document means nobody ever looks. The ribbon is the map: tall where the
 * fragments are substantial, thin where the chunker produced scraps, green
 * where Cortex has actually used the material, and it puts you anywhere in the
 * document in one click.
 *
 * IT IS A SHORTCUT, NOT THE ONLY DOOR. It is deliberately not focusable: a
 * hundred and eighty tab stops in front of a picture is worse for a keyboard
 * user than no picture at all. Everything it does is also done by the "ir al
 * nº" box and the previous/next buttons underneath it, which are ordinary
 * controls in the ordinary tab order. That is the rule this whole screen
 * follows — the drawing says things a list cannot, and it is never the only way
 * to get anywhere.
 */
export function FragmentSpine({
  spine,
  total,
  windowFrom,
  windowTo,
  focusIndex,
  sampled,
  onJump,
}: {
  spine: SpineBucket[];
  total: number;
  /** The stretch currently on screen, so the ribbon says where you are. */
  windowFrom: number;
  windowTo: number;
  focusIndex: number | null;
  /** True when the document was too long to measure exactly. */
  sampled: boolean;
  onJump: (index: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  const peak = useMemo(() => Math.max(1, ...spine.map((b) => b.tokens)), [spine]);
  const never = useMemo(() => spine.reduce((sum, b) => sum + b.never, 0), [spine]);

  const jump = useCallback(
    (clientX: number) => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || spine.length === 0) return;
      const share = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const bucket = spine[Math.min(spine.length - 1, Math.floor(share * spine.length))];
      if (bucket) onJump(bucket.from);
    },
    [spine, onJump],
  );

  if (spine.length === 0) return null;

  const left = (windowFrom / Math.max(1, total)) * 100;
  const width = Math.max(1.2, ((windowTo - windowFrom + 1) / Math.max(1, total)) * 100);

  return (
    <div>
      {/* Hidden from assistive technology on purpose, and it is not a shortcut
          being taken: everything this does is done by the "ir al nº" box and the
          previous/next buttons directly underneath, which are ordinary controls
          in the ordinary tab order. Announcing a hundred and eighty bars would
          bury those two. */}
      <div
        ref={ref}
        aria-hidden
        onPointerDown={(e) => jump(e.clientX)}
        className="relative h-11 w-full cursor-pointer select-none overflow-hidden rounded-sm bg-surface-2"
        title="Toca para saltar a esa parte del documento"
      >
        {/* Where you are now. Behind the bars so it reads as a lit stretch of
            the document rather than a box drawn over it. */}
        <span
          className="absolute inset-y-0 bg-primary-soft transition-[left,width] duration-300 motion-reduce:transition-none"
          style={{ left: `${left}%`, width: `${width}%` }}
        />

        <div className="absolute inset-0 flex items-end gap-px px-px">
          {spine.map((bucket) => {
            const height = Math.max(3, (bucket.tokens / peak) * 40);
            const used = bucket.retrievals > 0;
            const inWindow = bucket.to >= windowFrom && bucket.from <= windowTo;
            return (
              <span
                key={bucket.from}
                className={clsx(
                  'flex-1 rounded-t-[1px]',
                  used ? 'bg-emerald' : 'bg-ink-faint',
                  inWindow ? 'opacity-100' : 'opacity-45',
                )}
                style={{ height: `${height}px` }}
              />
            );
          })}
        </div>

        {focusIndex !== null && (
          <span
            className="absolute inset-y-0 w-px bg-primary"
            style={{ left: `${(focusIndex / Math.max(1, total)) * 100}%` }}
          />
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[10.5px] text-ink-faint">
        <span>
          {never > 0 ? (
            <>
              <span className="tabular text-ink-muted">{num(never)}</span> tramos sin usar nunca ·{' '}
            </>
          ) : null}
          alto = fragmentos con más contenido
        </span>
        <span>
          {sampled ? 'dibujado a partir de una muestra · ' : ''}
          <span className="tabular">{num(total)}</span> fragmentos
        </span>
      </div>
    </div>
  );
}
