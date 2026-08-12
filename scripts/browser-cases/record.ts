import type { Page } from '../../services/browser/node_modules/playwright';
import type { Frame } from '../../packages/agent-tools/src/browser/extract';

/**
 * A recording of a person doing an errand, produced without a person.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS LEGITIMATE AND NOT A SHORTCUT
 * ---------------------------------------------------------------------------
 * What `apps/web/lib/tab-recorder.ts` hands the extractor is a list of JPEG
 * frames of a tab, sampled where the picture changed, with the pointer drawn in.
 * Nothing about that requires a human hand: Playwright can drive the same portal
 * through the same errand and screenshot it at the same moments, and what comes
 * out is the same kind of evidence -- pixels of a page mid-errand, with no DOM,
 * no click stream and no URL bar, which is exactly the poverty the extractor has
 * to work from.
 *
 * The one thing a real capture has that a screenshot does not is the mouse
 * pointer, and `cursor: 'always'` in the real recorder makes it load-bearing:
 * the frame BEFORE a click is what says which of six buttons was pressed. So the
 * pointer is drawn in here too, over the element about to be acted on. Leaving
 * it out would make these recordings HARDER to read than the real ones and
 * would flatter every improvement measured against them.
 *
 * ---------------------------------------------------------------------------
 * THE TWO SAMPLING POLICIES, MEASURED AGAINST EACH OTHER
 * ---------------------------------------------------------------------------
 *   sueltos   one frame after each thing the person did, plus the first. This is
 *             what ships today: the model sees the effect of a click and never
 *             the click.
 *   pareja    the same, plus a frame from JUST BEFORE each heavy moment -- a
 *             navigation, or a layer appearing. Those are the moments where the
 *             "after" picture cannot say what was pressed, because the thing
 *             that was pressed is no longer on screen.
 *
 * Both are held to the SAME image budget, which is the only comparison that
 * means anything: the extractor's cap is twenty frames whichever way they are
 * sampled, so pairs buy their extra evidence by covering fewer moments. If that
 * trade does not pay, the pairs lose here and are not shipped.
 */

export interface Act {
  /** What the person is doing. Never shown to the model -- it is the answer. */
  note: string;
  /** Where the pointer rests while doing it. */
  selector?: string;
  /**
   * True when the act navigates or opens a layer -- the moments where the frame
   * after cannot say what caused it.
   */
  heavy?: boolean;
  run(page: Page): Promise<void>;
}

export interface RecordOptions {
  page: Page;
  acts: Act[];
  paired: boolean;
  /** Total images, both policies alike. The extractor's own cap. */
  budget: number;
}

const CURSOR_ID = '__cortex_cursor__';

/** Draw the pointer where the person's hand is. Removed before the next shot. */
async function showCursor(page: Page, selector: string): Promise<void> {
  await page
    .evaluate(
      ({ selector, id }) => {
        const el = document.querySelector(selector);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const dot = document.createElement('div');
        dot.id = id;
        dot.style.cssText = [
          'position:fixed',
          `left:${Math.round(rect.left + rect.width / 2)}px`,
          `top:${Math.round(rect.top + rect.height / 2)}px`,
          'width:0;height:0;z-index:2147483647;pointer-events:none',
          'border-left:11px solid #111',
          'border-right:7px solid transparent',
          'border-bottom:15px solid transparent',
          'transform:rotate(-20deg)',
          'filter:drop-shadow(1px 1px 1px rgba(255,255,255,.9))',
        ].join(';');
        document.body.appendChild(dot);
      },
      { selector, id: CURSOR_ID },
    )
    .catch(() => undefined);
}

async function hideCursor(page: Page): Promise<void> {
  await page
    .evaluate((id) => document.getElementById(id)?.remove(), CURSOR_ID)
    .catch(() => undefined);
}

async function shoot(page: Page, atMs: number, phase: 'antes' | 'despues'): Promise<Frame> {
  const buffer = await page.screenshot({ type: 'jpeg', quality: 60 });
  return { base64: buffer.toString('base64'), mimeType: 'image/jpeg', atMs, phase };
}

/**
 * Drive the errand and come back with what the camera would have seen.
 *
 * Trimming, when the budget is tight, drops the LAST pairs rather than the first
 * -- but only ever the "before" half. Dropping a whole moment would remove a
 * step from the errand; dropping a before-frame only removes the explanation of
 * one, which degrades the paired policy back towards the single one instead of
 * towards nonsense.
 */
export async function recordErrand(options: RecordOptions): Promise<Frame[]> {
  const { page, acts, paired, budget } = options;
  const started = Date.now();
  const frames: (Frame & { keep: number })[] = [];

  const push = (frame: Frame, keep: number) => frames.push({ ...frame, keep });

  // The first frame, before anything happened: the page as the person found it.
  push(await shoot(page, 0, 'despues'), 100);

  for (const act of acts) {
    if (paired && act.heavy && act.selector) {
      await showCursor(page, act.selector);
      push(await shoot(page, Date.now() - started, 'antes'), 50);
      await hideCursor(page);
    }
    await act.run(page);
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await page.waitForTimeout(120);
    push(await shoot(page, Date.now() - started, 'despues'), 100);
  }

  // Over budget: drop the least valuable frames, which are the before-halves,
  // last one first.
  while (frames.length > budget) {
    let victim = -1;
    for (let i = frames.length - 1; i > 0; i--) {
      if ((frames[i]?.keep ?? 100) < 100) {
        victim = i;
        break;
      }
    }
    // No before-frames left to give up: drop a middle moment rather than the
    // last one, which is the page that says what the errand produced.
    if (victim === -1) victim = Math.max(1, frames.length - 2);
    frames.splice(victim, 1);
  }

  return frames.map(({ base64, mimeType, atMs, phase }) => ({ base64, mimeType, atMs, phase }));
}
