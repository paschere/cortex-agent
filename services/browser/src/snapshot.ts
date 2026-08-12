import type { Locator, Page } from 'playwright';
import type { PageSnapshot, Target } from './types';

/**
 * What the page looks like, described the way a person describes it.
 *
 * WHY NOT PLAYWRIGHT'S ACCESSIBILITY SNAPSHOT. It is a tree, it is verbose, and
 * -- the disqualifying part -- nothing in it tells you how to build a locator
 * for a node you picked. A model handed that tree can say "click the third
 * button", which is a coordinate wearing a costume. What is wanted instead is,
 * for every element a person could act on, THE RANKED LIST OF WAYS TO FIND IT
 * AGAIN. Then repair is the model choosing an element, and the locators come
 * from the page rather than from the model's imagination.
 *
 * THE RANKING, best first, and the reason for the order:
 *
 *   1  data-testid        put there deliberately so automation can find it
 *   2  role + name        what the element IS and what it SAYS. Survives a
 *                         restyle, a wrapper div, a class rename, a framework
 *                         migration. This is the one that carries the flow.
 *   3  label              a form control's label is the most stable text near
 *                         it, and it is the text a person would point at
 *   4  placeholder        weaker than a label -- placeholders get reworded --
 *                         but still semantic
 *   5  name attribute     server-generated on the JSF and ASP.NET forms most
 *                         Colombian portals are built on, and therefore
 *                         invisible to a redesign that only touches markup
 *   6  visible text       for links and buttons with no accessible name
 *   7  #id                only when the id does not look generated
 *   8  css path           last resort, and the one that breaks first. Kept
 *                         because a step with only a bad locator still beats a
 *                         step with none.
 *
 * Nothing here is a coordinate, and nothing depends on document order except
 * rank 8. That is the whole reason a flow taught in August still runs in March.
 */

/**
 * How an element describes itself, as source shared by the two callers.
 *
 * It is a string rather than a module because both callers run it INSIDE the
 * page: the snapshot evaluates it over every interactive element, and
 * `observeTargets` evaluates it over the single element a step just acted on.
 * Keeping one copy is what makes "the locators a repair proposes" and "the
 * locators a successful step reports" the same locators, computed by the same
 * rules -- which is the property that lets a flow learned from a video be
 * rewritten with what the DOM says without changing what it means.
 */
const LOCATOR_HELPERS = /* js */ `
  const MAX_TEXT = 90;

  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, MAX_TEXT);

  const GENERATED_ID =
    /(^|[-_:])\\d{3,}|[0-9a-f]{8}|^:r[0-9a-z]+:|^ember\\d|^ext-gen|^mui-|^radix-|^headlessui-/i;

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'search') return 'searchbox';
      if (t === 'number') return 'spinbutton';
      // password, email, tel, url, date and text all expose as textbox.
      return 'textbox';
    }
    return 'generic';
  }

  function labelTextFor(el) {
    if (el.id) {
      const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (forLabel) return clean(forLabel.textContent);
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      // The control's own value must not become its label.
      const copy = wrapping.cloneNode(true);
      const inputs = copy.querySelectorAll('input, select, textarea');
      for (const node of inputs) node.remove();
      return clean(copy.textContent);
    }
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent);
      if (parts.length > 0) return clean(parts.join(' '));
    }
    return '';
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria);
    const label = labelTextFor(el);
    if (label) return label;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return clean(el.value);
      if (t === 'image') return clean(el.getAttribute('alt'));
    }
    const text = clean(el.textContent);
    if (text) return text;
    const title = el.getAttribute('title');
    if (title) return clean(title);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return clean(placeholder);
    return '';
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      const tag = node.tagName.toLowerCase();
      if (node.id && !GENERATED_ID.test(node.id)) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
      const index = sameTag.indexOf(node) + 1;
      parts.unshift(sameTag.length > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function targetsFor(el, role, name) {
    const out = [];
    const testid =
      el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa');
    if (testid) out.push({ kind: 'testid', value: testid });

    if (role !== 'generic' && name) out.push({ kind: 'role', value: role, name: name });

    const label = labelTextFor(el);
    if (label) out.push({ kind: 'label', value: label });

    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) out.push({ kind: 'placeholder', value: clean(placeholder) });

    const nameAttr = el.getAttribute('name');
    if (nameAttr && nameAttr.trim()) out.push({ kind: 'name', value: nameAttr.trim() });

    const tag = el.tagName.toLowerCase();
    const text = clean(el.textContent);
    if (text && (tag === 'a' || tag === 'button' || role === 'link' || role === 'button')) {
      out.push({ kind: 'text', value: text });
    }

    if (el.id && !GENERATED_ID.test(el.id)) {
      out.push({ kind: 'css', value: '#' + CSS.escape(el.id) });
    }

    const path = cssPath(el);
    if (path) out.push({ kind: 'css', value: path });

    // Same locator twice adds nothing but a retry.
    const seen = new Set();
    return out.filter((t) => {
      const key = t.kind + '|' + t.value + '|' + (t.name || '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function visible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }
`;

const SNAPSHOT_SCRIPT = /* js */ `(() => {
  const MAX_ELEMENTS = 140;
${LOCATOR_HELPERS}

  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role], [onclick], [tabindex]';

  const elements = [];
  let ref = 0;
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') continue;
    if (!visible(el)) continue;
    const role = roleOf(el);
    if (role === 'generic' && !el.hasAttribute('onclick')) continue;
    const name = accessibleName(el);
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    ref += 1;

    // A password field's current text is never reported. It reads as dots on
    // screen and it reads as '***' here; there is no path by which the
    // characters reach Cortex, a log or a model.
    let value = null;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      value = (type || '').toLowerCase() === 'password' ? '***' : clean(el.value);
    }

    elements.push({
      ref: 'e' + ref,
      role: role,
      name: name,
      tag: tag,
      type: type,
      targets: targetsFor(el, role, name),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      value: value,
    });
  }

  const headings = Array.prototype.map
    .call(document.querySelectorAll('h1, h2, h3, legend, caption, [role="heading"]'), (h) => clean(h.textContent))
    .filter(Boolean)
    .slice(0, 20);

  const ALERTS = '[role="alert"], [role="status"], [aria-invalid="true"], .error, .alert, .invalid-feedback, .field-error, .msg-error, .text-danger';
  const alerts = Array.prototype.map
    .call(document.querySelectorAll(ALERTS), (n) => clean(n.textContent))
    .filter(Boolean)
    .slice(0, 12);

  // The page's own words, not just its controls. A results table is not an
  // interactive element, so an elements-only snapshot would describe a portal
  // in which the ANSWER is invisible -- which would quietly turn the reasoned
  // baseline in scripts/browser-benchmark into a strawman, and would leave the
  // repairer unable to tell a results page from an error page.
  const text = (document.body && document.body.innerText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1800);

  return {
    url: location.href,
    title: document.title,
    headings: headings,
    alerts: alerts,
    text: text,
    elements: elements,
  };
})()`;

/**
 * What the element a step just acted on calls itself.
 *
 * ---------------------------------------------------------------------------
 * THE DIVISION OF LABOUR BETWEEN THE VIDEO AND THE DOM
 * ---------------------------------------------------------------------------
 * A recording can say WHICH STEPS THERE ARE AND IN WHAT ORDER -- that is what a
 * sequence of pictures is evidence of, and no amount of markup would say it
 * better. What a recording cannot say is what anything is CALLED underneath: a
 * `data-testid` put there for automation, the accessible name a screen reader
 * would read, the server-generated `name` attribute a JSF form hangs its state
 * on. Those are invisible to a camera and permanent in the page.
 *
 * So the model proposes a step, this pass runs it, and the moment it resolves
 * the element hands over its own description -- computed by the same rules the
 * repair snapshot uses. The flow is then rewritten with what the page said
 * rather than what the model inferred from a picture of it, and the difference
 * shows up as steps that resolve on their FIRST locator instead of limping
 * along on a fallback.
 *
 * Never throws. A step that worked must not be reported as failed because its
 * self-description could not be read.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS INSTALLED INTO THE PAGE INSTEAD OF SENT WITH THE CALL
 * ---------------------------------------------------------------------------
 * Playwright evaluates a STRING as an expression, never as a function -- which
 * is right for the snapshot (an IIFE that returns an object) and useless for a
 * call that has to receive the element. And a real function handed to
 * `evaluate` is serialised without its closure, so it cannot call helpers
 * defined out here.
 *
 * So the helpers are installed once per context as an init script, under one
 * namespaced global, and the call is an ordinary arrow function that finds them
 * there. No `new Function`, which a portal with a strict `script-src` would
 * refuse -- and refusing quietly, on exactly the kind of site this module
 * exists for.
 */
export const LOCATOR_INSTALL_SCRIPT = /* js */ `(() => {
${LOCATOR_HELPERS}
  Object.defineProperty(window, '__cortexTargets', {
    value: (el) => targetsFor(el, roleOf(el), accessibleName(el)),
    writable: false,
    enumerable: false,
    configurable: true,
  });
})()`;

export async function observeTargets(locator: Locator): Promise<Target[]> {
  try {
    const found = await locator.evaluate((el) => {
      const read = (window as unknown as Record<string, unknown>).__cortexTargets;
      return typeof read === 'function' ? (read as (node: Element) => unknown)(el) : [];
    });
    return Array.isArray(found) ? (found as Target[]) : [];
  } catch {
    return [];
  }
}

/** Read the page. Never throws: a snapshot is diagnostics, not the errand. */
export async function snapshotPage(page: Page): Promise<PageSnapshot> {
  try {
    return (await page.evaluate(SNAPSHOT_SCRIPT)) as PageSnapshot;
  } catch {
    return {
      url: page.url(),
      title: '',
      headings: [],
      alerts: [],
      text: '',
      elements: [],
    };
  }
}

/** The page's own text, capped, so the refusal vocabulary has something to read. */
export async function bodyText(page: Page, limit = 2500): Promise<string> {
  try {
    const text = await page.evaluate(
      `(document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim()`,
    );
    return String(text).slice(0, limit);
  } catch {
    return '';
  }
}

/** How many of the recorded landmarks are still on the page. */
export async function countLandmarks(page: Page, landmarks: string[]): Promise<number> {
  if (landmarks.length === 0) return 0;
  const haystack = (await bodyText(page, 20_000)).toLowerCase();
  return landmarks.filter((l) => l.trim().length > 0 && haystack.includes(l.toLowerCase())).length;
}
