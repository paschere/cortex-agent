'use client';

import { useRef, useState } from 'react';
import { AnswerCard } from './AnswerCard';
import { INDUSTRIES } from './industries';

/**
 * "For every industry" is how a page ends up speaking to nobody. This control
 * is the way out: the promise stays one sentence and the visitor picks whose
 * words it gets said in.
 *
 * ACCESSIBILITY. This is the WAI-ARIA tabs pattern, not a row of buttons with
 * `aria-` attributes sprinkled on:
 *
 *  · Roving tabindex. Exactly one tab is in the page's tab order, so Tab moves
 *    past the whole group in one press instead of six, and Shift+Tab out of it
 *    the same way.
 *  · Arrow keys move between tabs and select as they go (automatic activation,
 *    which is the right choice when switching costs nothing — nothing is
 *    fetched here). Home and End jump to the ends.
 *  · The panel is labelled by its tab and is itself focusable, so somebody who
 *    just changed the industry can Tab straight into what changed rather than
 *    hunting for it.
 *
 * A screen reader therefore hears "Contabilidad y consultoría, tab, 2 of 6,
 * selected" on arrow, and then reads the panel. That is the announcement — no
 * `aria-live` region, which on top of the tab pattern would say everything
 * twice.
 *
 * MOTION. The panel's settle is a CSS animation keyed off the industry id, so
 * the global `prefers-reduced-motion` rule in globals.css flattens it. Nothing
 * is animated from JavaScript here, so there is no media query to check by
 * hand.
 *
 * BUNDLE. This file and everything it imports ship to the browser. It imports
 * only React, plain data and a presentational component — never
 * `@cortex/agent-tools`, whose barrel reaches `node:dns` and breaks the
 * production build without typecheck or tests noticing.
 */

export function IndustrySwitch() {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function move(to: number) {
    const next = (to + INDUSTRIES.length) % INDUSTRIES.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        move(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        move(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        move(0);
        break;
      case 'End':
        e.preventDefault();
        move(INDUSTRIES.length - 1);
        break;
      default:
        break;
    }
  }

  // `active` is only ever set from an index of this list, so the fallback is
  // unreachable — it is here because indexing by a number is `| undefined`
  // under noUncheckedIndexedAccess, and a crash-on-undefined would be worse.
  const industry = INDUSTRIES[active] ?? INDUSTRIES[0];

  return (
    <div>
      <div className="lp-tabs" role="tablist" aria-label="Elige a qué se dedica tu empresa">
        {INDUSTRIES.map((it, i) => (
          <button
            key={it.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`lp-tab-${it.id}`}
            aria-selected={i === active}
            aria-controls={`lp-panel-${it.id}`}
            tabIndex={i === active ? 0 : -1}
            className="lp-tab"
            onClick={() => setActive(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {it.label}
          </button>
        ))}
      </div>

      <div
        /* Keyed on the industry so React remounts the subtree and the settle
           animation runs again on every change, instead of once on mount. */
        key={industry.id}
        role="tabpanel"
        id={`lp-panel-${industry.id}`}
        aria-labelledby={`lp-tab-${industry.id}`}
        tabIndex={0}
        className="lp-panel lp-settle"
      >
        <div>
          <h3 className="lp-h3">Preguntas de un día cualquiera</h3>
          <ul className="lp-asks mt-3">
            {industry.asks.map((ask) => (
              <li key={ask.text} className="lp-ask">
                <p className="lp-ask__role">{ask.role}</p>
                <p className="lp-ask__q">«{ask.text}»</p>
              </li>
            ))}
          </ul>

          <div className="lp-before">
            <p className="lp-before__label">Antes de Cortex</p>
            <p className="lp-before__text">{industry.before}</p>
          </div>
        </div>

        <div>
          <p className="lp-answer__srcs-label mb-2.5">Y la primera, contestada</p>
          <AnswerCard answer={industry.answer} tag={industry.tag} />
        </div>
      </div>
    </div>
  );
}
