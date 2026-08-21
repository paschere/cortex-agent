/**
 * Mano alzada de Google Meet — pedir la palabra sin interrumpir.
 *
 * El aria-label describe la ACCIÓN: «Raise hand» / «Levantar la mano» significa
 * que AHORA está bajada. «Lower hand» / «Bajar la mano» significa que ya está
 * alzada. El atajo de Meet es Ctrl+Alt+H (Chrome OS / Windows / Linux).
 *
 * locateGoogleMeetHand corre DENTRO de la página (page.evaluate).
 */

import type { Page, ElementHandle } from "playwright";
import { log } from "../_host";
import { HumanizedInteractor, MOCAP_LIBRARY, X11Input } from "./humanized";

export type HandLocate = {
  found: boolean;
  raised: boolean;
  x: number;
  y: number;
  label: string;
  area: number;
};

export type HandButtonHint = {
  label: string;
  ariaPressed: string | null;
  area: number;
  yRatio: number;
  tag: string;
};

export function looksLikeHandLabel(label: string): boolean {
  const l = label.toLowerCase();
  if (!l) return false;
  if (/reacti[oó]n|emoji|sticker|thumb|aplauso|heart|favorit/.test(l) && !/hand|mano/.test(l)) {
    return false;
  }
  return /raise hand|lower hand|levantar la mano|bajar la mano|mano alzada|hand raised|toggle.?hand/.test(
    l,
  );
}

/** true = la mano YA está alzada. */
export function handCurrentlyRaised(label: string, ariaPressed: string | null): boolean | null {
  if (ariaPressed === "true") return true;
  if (ariaPressed === "false") return false;
  const l = label.toLowerCase();
  if (/lower hand|bajar la mano|mano alzada|hand is raised|raised hand/.test(l) && !/raise hand/.test(l)) {
    return true;
  }
  if (/raise hand|levantar la mano/.test(l)) return false;
  return null;
}

export function scoreHandButton(hint: HandButtonHint): number | null {
  const tag = hint.tag.toLowerCase();
  if (tag !== "button") return null;
  if (hint.area < 80 || hint.area > 16_000) return null;
  if (!looksLikeHandLabel(hint.label)) return null;
  let score = 10;
  if (hint.yRatio >= 0.65) score += 8;
  else if (hint.yRatio >= 0.35) score += 2;
  if (hint.ariaPressed !== null) score += 3;
  if (hint.area >= 400 && hint.area <= 8_000) score += 2;
  return score;
}

export function locateGoogleMeetHand(): HandLocate {
  (globalThis as { __name?: (f: unknown) => unknown }).__name =
    (globalThis as { __name?: (f: unknown) => unknown }).__name || ((f) => f);
  const looksLike = (label: string): boolean => {
    const l = label.toLowerCase();
    if (!l) return false;
    if (/reacti[oó]n|emoji|sticker|thumb|aplauso|heart|favorit/.test(l) && !/hand|mano/.test(l)) {
      return false;
    }
    return /raise hand|lower hand|levantar la mano|bajar la mano|mano alzada|hand raised|toggle.?hand/.test(
      l,
    );
  };
  const raisedOf = (label: string, pressed: string | null): boolean | null => {
    if (pressed === "true") return true;
    if (pressed === "false") return false;
    const l = label.toLowerCase();
    if (/lower hand|bajar la mano|mano alzada|hand is raised/.test(l) && !/raise hand/.test(l)) {
      return true;
    }
    if (/raise hand|levantar la mano/.test(l)) return false;
    return null;
  };
  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el as HTMLElement);
    return rect.width > 0 && rect.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const labelOf = (el: Element): string =>
    (el.getAttribute("aria-label") || el.getAttribute("data-tooltip") || (el as HTMLElement).title || "").trim();
  const vh = Math.max(1, window.innerHeight);
  let best: { el: HTMLElement; score: number; area: number; raised: boolean; label: string } | null = null;
  for (const raw of Array.from(document.querySelectorAll("button"))) {
    const el = raw as HTMLElement;
    if (!isVisible(el)) continue;
    const label = labelOf(el);
    if (!looksLike(label)) continue;
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area < 80 || area > 16_000) continue;
    const yRatio = rect.top / vh;
    const pressed = el.getAttribute("aria-pressed");
    let score = 10;
    if (yRatio >= 0.65) score += 8;
    else if (yRatio >= 0.35) score += 2;
    if (pressed !== null) score += 3;
    if (area >= 400 && area <= 8_000) score += 2;
    const raised = raisedOf(label, pressed) === true;
    if (!best || score > best.score || (score === best.score && area < best.area)) {
      best = { el, score, area, raised, label };
    }
  }
  if (!best) return { found: false, raised: false, x: 0, y: 0, label: "", area: 0 };
  const rect = best.el.getBoundingClientRect();
  return {
    found: true,
    raised: best.raised,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    label: best.label,
    area: best.area,
  };
}

export function googleMeetHandButtonElement(): HTMLElement | null {
  (globalThis as { __name?: (f: unknown) => unknown }).__name =
    (globalThis as { __name?: (f: unknown) => unknown }).__name || ((f) => f);
  const looksLike = (label: string): boolean => {
    const l = label.toLowerCase();
    if (!l) return false;
    if (/reacti[oó]n|emoji|sticker|thumb|aplauso|heart|favorit/.test(l) && !/hand|mano/.test(l)) {
      return false;
    }
    return /raise hand|lower hand|levantar la mano|bajar la mano|mano alzada|hand raised|toggle.?hand/.test(
      l,
    );
  };
  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el as HTMLElement);
    return rect.width > 0 && rect.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const labelOf = (el: Element): string =>
    (el.getAttribute("aria-label") || el.getAttribute("data-tooltip") || (el as HTMLElement).title || "").trim();
  const vh = Math.max(1, window.innerHeight);
  let best: { el: HTMLElement; score: number; area: number } | null = null;
  for (const raw of Array.from(document.querySelectorAll("button"))) {
    const el = raw as HTMLElement;
    if (!isVisible(el)) continue;
    const label = labelOf(el);
    if (!looksLike(label)) continue;
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area < 80 || area > 16_000) continue;
    const yRatio = rect.top / vh;
    let score = 10;
    if (yRatio >= 0.65) score += 8;
    else if (yRatio >= 0.35) score += 2;
    if (el.getAttribute("aria-pressed") !== null) score += 3;
    if (area >= 400 && area <= 8_000) score += 2;
    if (!best || score > best.score || (score === best.score && area < best.area)) {
      best = { el, score, area };
    }
  }
  return best?.el ?? null;
}

/**
 * Alzar o bajar la mano. Si el botón ya está como queremos, no se toca
 * (un click de más la bajaría). Atajo Ctrl+Alt+H si el botón no aparece.
 */
export async function setGoogleMeetHand(
  page: Page,
  wantRaised: boolean,
  display?: string,
): Promise<void> {
  const readLoc = () =>
    page.evaluate(locateGoogleMeetHand).catch(() => ({
      found: false,
      raised: false,
      x: 0,
      y: 0,
      label: "",
      area: 0,
    }));

  const first = await readLoc();
  if (first.found && first.raised === wantRaised) {
    log(wantRaised ? "Hand already raised." : "Hand already down.");
    return;
  }

  const x11 = new X11Input({ display: display || process.env.DISPLAY || ":99" });
  const x11Ok = await x11.isAvailable().catch(() => false);
  const humanizer = x11Ok
    ? new HumanizedInteractor(MOCAP_LIBRARY, {
        log,
        display: display || process.env.DISPLAY || ":99",
      })
    : null;

  const wakeToolbar = async () => {
    try {
      await page.bringToFront();
    } catch {
      /* */
    }
    if (x11Ok) await x11.moveAbs(960, 1040).catch(() => undefined);
    else await page.mouse.move(960, 980).catch(() => undefined);
    await page.waitForTimeout(250);
  };

  const clickHand = async (): Promise<boolean> => {
    const handle = (await page.evaluateHandle(googleMeetHandButtonElement).catch(() => null)) as
      | ElementHandle<Element>
      | null;
    const el = handle ? await handle.asElement() : null;
    if (!el) {
      await handle?.dispose().catch(() => undefined);
      return false;
    }
    try {
      if (humanizer) {
        await humanizer.navigateAndClick(page, el);
        log("Hand clicked via XTEST (trusted).");
        return true;
      }
      await el.click({ timeout: 2_000 });
      log("Hand clicked via Playwright (untrusted fallback).");
      return true;
    } catch (err) {
      log(`Hand click failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      await handle?.dispose().catch(() => undefined);
    }
  };

  const shortcut = async () => {
    if (x11Ok) {
      await x11.key("ctrl+alt+h");
      log("Pressed Ctrl+Alt+H via XTEST (raise/lower hand).");
      return;
    }
    await page.keyboard.press("Control+Alt+h").catch(() => undefined);
    log("Pressed Ctrl+Alt+H via Playwright (untrusted fallback).");
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    await wakeToolbar();
    const loc = await readLoc();
    log(`Hand inspect #${attempt}: ${JSON.stringify({ ...loc, x11: x11Ok, wantRaised })}`);
    if (loc.found && loc.raised === wantRaised) {
      log(wantRaised ? "Hand raised." : "Hand lowered.");
      return;
    }
    const clicked = await clickHand();
    if (!clicked) await shortcut();
    await page.waitForTimeout(500);
    const after = await readLoc();
    if (after.found && after.raised === wantRaised) {
      log(wantRaised ? "Hand raised." : "Hand lowered.");
      return;
    }
    if (!after.found && clicked) {
      // Sin botón visible después del click, confiamos en el atajo/click.
      log(wantRaised ? "Hand toggled (button gone)." : "Hand toggled (button gone).");
      return;
    }
  }
  log(wantRaised ? "Could not raise hand." : "Could not lower hand.");
}
