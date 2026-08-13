import type { Locator, Page } from 'playwright';
import type { Target } from './types';

/**
 * A stored target, turned back into something Playwright can find.
 *
 * Every branch here except `css` resolves by MEANING -- the element's role and
 * accessible name, the label beside it, the placeholder inside it, the form
 * field name the server gave it. That is the property the whole module rests
 * on: a portal can be restyled, rebuilt in another framework or reflowed for
 * mobile, and the button that said "Consultar" still says "Consultar".
 */
export function buildLocator(page: Page, target: Target): Locator {
  switch (target.kind) {
    case 'testid':
      return page.getByTestId(target.value);
    case 'role':
      // `exact: false` on purpose: portals pad accessible names with
      // whitespace, icons and counts ("Consultar (3)"), and an exact match
      // would fail on a change that no person would call a change.
      return target.name
        ? page.getByRole(target.value as Parameters<Page['getByRole']>[0], {
            name: target.name,
            exact: false,
          })
        : page.getByRole(target.value as Parameters<Page['getByRole']>[0]);
    case 'label':
      return page.getByLabel(target.value, { exact: false });
    case 'placeholder':
      return page.getByPlaceholder(target.value, { exact: false });
    case 'text':
      return page.getByText(target.value, { exact: false });
    case 'name':
      return page.locator(`[name="${cssQuote(target.value)}"]`);
    default:
      return page.locator(target.value);
  }
}

/** Escape a value going inside a CSS attribute selector's double quotes. */
function cssQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface Resolved {
  locator: Locator;
  rank: number;
  target: Target;
}

export interface ResolveFailure {
  candidates: { kind: Target['kind']; value: string; matches: number }[];
}

/**
 * Find the element, trying every stored candidate in order and taking the first
 * that resolves to exactly one visible node.
 *
 * THE FALLBACK IS THE FEATURE, not a safety net. When candidate 0 stops
 * matching and candidate 2 works, the site changed in a way this flow just
 * absorbed -- no model, no repair, no run failed, and the caller is told the
 * rank so the step can be rewritten with the survivor first. A step that
 * carried one selector would instead be an incident.
 *
 * Ambiguity counts as not found. Two matches means acting on a guess, and on a
 * page that files something with a government body a guess is the one outcome
 * worth failing to avoid.
 */
export async function resolveTarget(
  page: Page,
  targets: Target[],
  deadline: number,
): Promise<Resolved | ResolveFailure> {
  const counts = new Map<string, number>();
  let sweeps = 0;

  // Polled rather than awaited on one locator: `waitFor` would spend the whole
  // budget on candidate 0 and never reach the one that still works.
  for (;;) {
    for (let rank = 0; rank < targets.length; rank++) {
      const target = targets[rank];
      if (!target) continue;
      let matches = 0;
      try {
        matches = await buildLocator(page, target).locator('visible=true').count();
      } catch {
        matches = 0;
      }
      counts.set(`${rank}`, matches);
      if (matches === 1) {
        return { locator: buildLocator(page, target).locator('visible=true'), rank, target };
      }
    }
    if (Date.now() >= deadline) break;

    // STOP WAITING FOR A PAGE THAT IS ASKING WHETHER WE ARE A ROBOT.
    //
    // Waiting is right when the element is late; it is pure waste when the
    // portal has replaced the page with a verification screen, because nothing
    // we are looking for is ever going to appear. Measured on the real case:
    // twenty seconds of polling per step against google.com/sorry, and the
    // verdict at the end was the same one available in the first second.
    //
    // Checked every eighth sweep (~2s) rather than every sweep: it is a DOM
    // query in the hot loop of every step in the product, and a challenge that
    // is two seconds old is still a challenge.
    sweeps += 1;
    if (sweeps % 8 === 0 && (await looksLikeAChallenge(page))) break;

    await page.waitForTimeout(250).catch(() => undefined);
  }

  return {
    candidates: targets.map((t, i) => ({
      kind: t.kind,
      value: t.name ? `${t.value}[name=${t.name}]` : t.value,
      matches: counts.get(`${i}`) ?? 0,
    })),
  };
}

export function isResolved(value: Resolved | ResolveFailure): value is Resolved {
  return 'locator' in value;
}

/**
 * A cheap "is this a bot check" for the resolution loop.
 *
 * Deliberately weaker than the classifier: this only decides whether to STOP
 * WAITING, and being wrong costs a step that would have failed anyway a few
 * seconds earlier. The verdict — and therefore whether a model is allowed near
 * the flow — is still made in classify.ts from the full evidence bundle.
 */
export async function looksLikeAChallenge(page: Page): Promise<boolean> {
  try {
    if (/\/sorry\/|\/cdn-cgi\/challenge|__cf_chl|\/challenge-platform/.test(page.url())) {
      return true;
    }
    const frames = await page
      .locator(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]',
      )
      .count();
    return frames > 0;
  } catch {
    return false;
  }
}

/** How a target reads in the audit trail. Short, and never a value. */
export function describeTarget(target: Target): string {
  if (target.kind === 'role' && target.name) return `role=${target.value}[${target.name}]`;
  return `${target.kind}=${target.value}`;
}
