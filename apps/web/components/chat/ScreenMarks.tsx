'use client';

import { type ScreenFrame, type ScreenMark, markRect } from '@/lib/screen-marks';
import { ImageOff } from 'lucide-react';

/**
 * «¿Dónde le doy?» — answered with a box on the picture.
 *
 * ===========================================================================
 * ON THE CAPTURE, INSIDE CORTEX. NEVER ON THE REAL SCREEN.
 * ===========================================================================
 * The obvious version of this feature draws a ring around the actual button on
 * the actual page, and the browser will not do it and should not: `getDisplay-
 * Media` hands back a read-only video of another tab, and a web page has no way
 * to paint over an application it does not own. Anything that claims otherwise
 * is an extension or a desktop app, and both are a different product.
 *
 * So the mark goes where the frame already is: in the answer, over the picture
 * that was taken when the question was asked. The person looks at the thumbnail
 * once, sees which of the six buttons it is, and goes back to their tab. That is
 * nearly the whole value of the impossible version, and it is honest about what
 * it is — a photograph with a box on it, not a thing hovering over their screen.
 *
 * ===========================================================================
 * PERCENTAGES, BECAUSE THE PICTURE IS DRAWN AT A WIDTH NOBODY KNOWS
 * ===========================================================================
 * Every box is positioned in `%` of the image's own box, which means the
 * browser rescales the marks with the image and no JavaScript measures
 * anything: no ResizeObserver, no layout effect, nothing to get out of step
 * during a window drag or a sidebar opening. `markRect` is called with a
 * 100×100 "size" and its output is the percentage — the same arithmetic the
 * tests assert against real pixels. See lib/screen-marks.ts.
 *
 * ===========================================================================
 * A BOX IS NOT AN ANSWER FOR EVERYBODY
 * ===========================================================================
 * A rectangle is invisible to a screen reader, and so is the frame under it. So
 * the list below the picture is not a caption or a legend — it IS the answer,
 * written out, and the drawing is the version for people who can see it. The
 * boxes are `aria-hidden` and numbered to match the list, which is also what
 * makes «el 2» a thing the person and the answer can both refer to.
 */

export function ScreenMarks({
  marks,
  frame,
}: {
  marks: ScreenMark[];
  /** The picture, if this tab still has it. See the note on the fallback. */
  frame?: ScreenFrame | null;
}) {
  if (marks.length === 0) return null;

  const count = marks.length;
  const alt =
    count === 1
      ? `Un cuadro de tu pantalla compartida, con un sitio señalado: ${marks[0]?.label}.`
      : `Un cuadro de tu pantalla compartida, con ${count} sitios señalados.`;

  return (
    <figure className="mt-2 overflow-hidden rounded-card border border-border bg-surface shadow-card">
      {frame ? (
        <div className="relative bg-surface-2">
          {/* A plain <img>: the source is a data: URL that exists only in this
              tab's memory for as long as it is open, so there is nothing for
              next/image to fetch, cache or optimise. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={frame.src} alt={alt} className="block w-full" />

          {marks.map((mark, i) => {
            const box = markRect(mark, { width: 100, height: 100 });
            return (
              <span
                key={`${mark.x1}-${mark.y1}-${mark.label}`}
                // Announced by the list underneath, in words. A reader that met
                // these too would read the same four things twice, the second
                // time as empty boxes.
                aria-hidden="true"
                className="pointer-events-none absolute rounded-sm border-2 border-primary ring-1 ring-white/70"
                style={{
                  left: `${box.left}%`,
                  top: `${box.top}%`,
                  width: `${box.width}%`,
                  height: `${box.height}%`,
                }}
              >
                {/* Inside the corner rather than hanging off it: a box against
                    the left or top edge of the frame would have its number
                    clipped by the card, which is exactly the box somebody is
                    most likely to be looking for. */}
                <span className="absolute left-0 top-0 grid h-5 w-5 place-items-center rounded-sm bg-primary text-micro font-semibold leading-none text-white">
                  {i + 1}
                </span>
              </span>
            );
          })}
        </div>
      ) : (
        <FrameGone count={count} />
      )}

      <figcaption className="border-t border-border px-3 py-2.5">
        <ol className="space-y-1.5">
          {marks.map((mark, i) => (
            <li key={`${mark.x1}-${mark.y1}-${mark.label}`} className="flex items-start gap-2">
              <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-sm bg-primary-soft text-micro font-semibold leading-none text-primary-ink">
                {i + 1}
              </span>
              <span className="min-w-0 text-xs leading-snug text-ink">{mark.label}</span>
            </li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}

/**
 * The picture is gone, and the marks are still here. Say so.
 *
 * This is not an error state, it is migration 0092 showing through: the frame
 * was never stored anywhere, so it lives in this tab's memory and dies with a
 * reload — while the marks were written onto the assistant's message row along
 * with every other tool result, and come back with the transcript. Drawing
 * rectangles over a grey rectangle would be the only genuinely wrong thing to
 * do here: numbered boxes over nothing point at nothing.
 *
 * So the list below stands on its own, and this explains why there is no
 * picture above it — in the same breath as the reason, because "la imagen no se
 * guardó" is a promise this product makes on purpose and the moment somebody
 * notices it is the moment it is worth repeating.
 */
function FrameGone({ count }: { count: number }) {
  return (
    <div className="flex items-start gap-2.5 bg-surface-2 px-3 py-2.5">
      <ImageOff className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden="true" />
      <p className="text-xs leading-snug text-ink-muted">
        Ya no tengo la imagen para dibujar encima: el cuadro de tu pantalla no se guarda en ninguna
        parte y se pierde al recargar.{' '}
        {count === 1
          ? 'El sitio que te señalé quedó escrito aquí abajo.'
          : `Los ${count} sitios que te señalé quedaron escritos aquí abajo.`}{' '}
        Si necesitas verlos recuadrados otra vez, comparte la pestaña y vuelve a preguntar.
      </p>
    </div>
  );
}
