import type { AnswerSource, Industry } from './industries';

/**
 * A Cortex reply, with its sources opened up.
 *
 * This is the page's thesis rendered as a component: the product's most
 * characteristic moment is not a feature list, it is an answer that names what
 * it stands on — the document, the day, the minute of the recording and the
 * exact words. It appears twice, statically in the hero and swapped by the
 * industry picker, and it is the same component both times so the two cannot
 * drift into looking like different products.
 *
 * Deliberately not `'use client'`: it holds no state, so it renders on the
 * server in the hero and is inlined into the picker's bundle where the picker
 * needs it. It imports nothing but its own types — importing from
 * `@cortex/agent-tools` here would drag `node:dns` into the browser bundle and
 * fail the production build while typecheck and tests stayed green. See
 * lib/commitments-shape.ts for the time that shipped.
 */

const TONE_CLASS: Record<NonNullable<AnswerSource['tone']>, string> = {
  stamp: '',
  seal: ' lp-cite--seal',
  hold: ' lp-cite--hold',
};

function Source({ src, delay }: { src: AnswerSource; delay?: string }) {
  return (
    <li className="lp-src lp-arrive" style={delay ? { animationDelay: delay } : undefined}>
      <span className={`lp-cite${TONE_CLASS[src.tone ?? 'stamp']}`}>
        <span className="lp-cite__src">{src.source}</span>
        <span aria-hidden className="lp-cite__dot">
          ·
        </span>
        <span className="lp-data">{src.when}</span>
      </span>
      <p className="lp-src__quote lp-data">{src.quote}</p>
    </li>
  );
}

export function AnswerCard({
  answer,
  tag,
  animate = false,
}: {
  answer: Industry['answer'];
  /** The trade this example belongs to, shown small in the card's bar. */
  tag: string;
  /** Stagger the entrance. Only the hero does this, and only once. */
  animate?: boolean;
}) {
  return (
    <article className="lp-answer">
      <div className="lp-answer__bar">
        <span className="lp-answer__who">
          <span aria-hidden className="lp-answer__pip" />
          Cortex
        </span>
        <span className="lp-answer__tag lp-data">{tag}</span>
      </div>

      <p className="lp-answer__q">
        <span aria-hidden />
        <span>{answer.question}</span>
      </p>

      <div className="lp-answer__body">
        <strong>{answer.lead}</strong> {answer.rest}
      </div>

      <div className="lp-answer__srcs">
        <p className="lp-answer__srcs-label">De dónde salió</p>
        <ul className="m-0 list-none p-0">
          {answer.sources.map((src, i) => (
            <Source
              key={src.source}
              src={src}
              delay={animate ? `${0.28 + i * 0.11}s` : undefined}
            />
          ))}
        </ul>
      </div>
    </article>
  );
}
