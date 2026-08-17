import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import type { Config } from './config';
import {
  buildLocator,
  describeTarget,
  isResolved,
  looksLikeAChallenge,
  resolveTarget,
} from './locators';
import { logger } from './logger';
import { replay } from './replay';
import { LOCATOR_INSTALL_SCRIPT, snapshotPage } from './snapshot';
import type { PageSnapshot, ReplayRequest, ReplayResponse, Target } from './types';

/**
 * The one Chromium, and the contexts that come and go inside it.
 *
 * ONE BROWSER, MANY CONTEXTS. Launching Chromium costs about a second and a
 * couple of hundred megabytes; a context costs almost nothing. So the process
 * keeps one browser alive and gives every run its own context, which is also
 * the isolation boundary that matters: cookies, localStorage and the session a
 * login just created belong to that context and die with it. Two workspaces
 * running errands on the same portal in the same second cannot see each
 * other's session, because there is no shared jar for them to see it in.
 *
 * The browser is launched lazily and relaunched if it dies. A crashed Chromium
 * is an ordinary event over weeks of uptime -- some page runs the renderer out
 * of memory -- and it must not need a deploy to recover from.
 */
export class BrowserWorker {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private inFlight = 0;
  private runsTotal = 0;
  private runsFailed = 0;
  private lastError: string | null = null;
  private stopping = false;
  private readonly sessions = new Map<string, InteractiveSession>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly config: Config) {}

  async start(): Promise<void> {
    this.sweeper = setInterval(() => void this.sweepSessions(), 30_000);
    // Warmed at boot so the first errand of the morning is not the one that
    // pays for the launch, and so a broken image fails the deploy rather than
    // the first customer.
    await this.ensureBrowser().catch((err: unknown) => {
      this.lastError = (err as Error).message;
      logger.error({ err: (err as Error).message }, 'chromium did not launch at boot');
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sweeper) clearInterval(this.sweeper);
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  snapshot(): Record<string, unknown> {
    return {
      browser: this.browser?.isConnected() ? 'up' : 'down',
      inFlight: this.inFlight,
      sessions: this.sessions.size,
      runsTotal: this.runsTotal,
      runsFailed: this.runsFailed,
      lastError: this.lastError,
    };
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = chromium
      .launch({
        headless: true,
        // --disable-dev-shm-usage: the container's /dev/shm is 64MB by default
        // and Chromium's renderer wants more, which shows up as tabs dying at
        // random on pages with a few images. Writing to /tmp instead is the
        // documented fix and costs nothing here.
        //
        // --disable-blink-features=AutomationControlled: without it Chromium
        // sets `navigator.webdriver = true`, which is the single cheapest
        // signal a bot check reads. This is not evasion of anything protective
        // -- the errands this service runs are somebody doing their own
        // paperwork on their own accounts -- it is declining to volunteer a
        // flag that has no meaning to the portal and costs the run everything.
        args: [
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
        ],
      })
      .then((browser) => {
        this.browser = browser;
        this.launching = null;
        browser.on('disconnected', () => {
          this.browser = null;
          if (!this.stopping) logger.warn({}, 'chromium disconnected; it will relaunch on demand');
        });
        logger.info({}, 'chromium ready');
        return browser;
      })
      .catch((err: unknown) => {
        this.launching = null;
        throw err;
      });
    return this.launching;
  }

  /**
   * What this browser says it is.
   *
   * Playwright's default announces `HeadlessChrome/<version>`, and a portal
   * that reads it knows within one request that nobody is watching the screen.
   * Google answers that with /sorry/index -- a verification page with none of
   * the flow's elements on it, which the classifier could only read as "every
   * selector stopped matching", i.e. the site was redesigned. So one string in
   * a header was costing a paid repair per run, forever, on a flow that was
   * never broken.
   *
   * Derived from the real Chromium version rather than pinned to a literal, so
   * it cannot drift into claiming a browser older than the one running.
   */
  private userAgentFor(browser: Browser): string | undefined {
    if (this.config.userAgent) return this.config.userAgent;
    const version = browser.version();
    if (!version) return undefined;
    return (
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${version} Safari/537.36`
    );
  }

  private async newContext(): Promise<BrowserContext> {
    const browser = await this.ensureBrowser();
    const userAgent = this.userAgentFor(browser);
    const context = await browser.newContext({
      viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
      ...(userAgent ? { userAgent } : {}),
      // Sent for the same reason the locale is set: a browser claiming Chrome
      // on a Bogotá clock that asks for pages in no particular language is a
      // combination no real visitor produces.
      extraHTTPHeaders: { 'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8' },
      acceptDownloads: true,
      // Government portals in Colombia routinely serve an expired or
      // misconfigured certificate chain. Refusing them would mean the module
      // does not work for the errands it exists for, and the transport is not
      // where the trust lives here anyway -- the credential is ours and the
      // result is checked by a person. Stated rather than hidden.
      ignoreHTTPSErrors: true,
      locale: 'es-CO',
      timezoneId: 'America/Bogota',
    });
    // How an element describes itself, installed before any document runs so
    // that a step which resolves can ask the element what it is called. See
    // `observeTargets` in snapshot.ts for why it is installed rather than sent.
    await context.addInitScript({ content: LOCATOR_INSTALL_SCRIPT });
    return context;
  }

  /**
   * Run a learned flow. One context, created and destroyed here — except when
   * the portal stopped to ask whether we are a person, in which case the tab is
   * handed to a human instead of thrown away. See `ReplayResponse.handoff`.
   */
  async runReplay(request: ReplayRequest): Promise<ReplayResponse> {
    if (this.inFlight >= this.config.maxConcurrent) {
      throw new BusyError();
    }
    this.inFlight += 1;
    this.runsTotal += 1;
    let context: BrowserContext | null = null;
    let handedOff = false;
    try {
      context = await this.newContext();
      const page = await context.newPage();
      await page.goto(request.startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const result = await replay(page, request, this.config);
      // A pause is not a failed run. It is the trámite doing exactly what it
      // was taught to do at the step where a portal needs a person.
      if (!result.ok && !result.pause) this.runsFailed += 1;

      // ---------------------------------------------------------------------
      // The trámite declared this stop itself. Same machinery as a bot check —
      // the tab survives, keyed by session — because the reason is the same:
      // the code goes into THIS form, in THIS session, with these cookies.
      // ---------------------------------------------------------------------
      if (result.pause) {
        if (this.sessions.size < this.config.maxConcurrent) {
          const sessionId = this.newSessionId();
          this.sessions.set(sessionId, { context, page, touchedAt: Date.now(), request });
          handedOff = true;
          logger.info(
            { runId: request.runId, sessionId, stepIndex: result.pause.index },
            'the trámite stopped to ask a person; holding the tab open',
          );
          return {
            ...result,
            handoff: {
              sessionId,
              reason: 'input-needed',
              // The step AFTER the pause: reaching it was the whole job.
              fromIndex: result.pause.index + 1,
              expiresAt: new Date(Date.now() + this.config.sessionIdleMs).toISOString(),
              ask: result.pause.ask,
              fills: result.pause.fills,
            },
          };
        }
        logger.warn({ runId: request.runId }, 'a trámite asked for a person, and there was no room to wait');
        return result;
      }

      if (!result.ok && result.failure && (await looksLikeAChallenge(page))) {
        // Room is checked here rather than earlier because a handoff converts a
        // finishing run into a lasting session, and the cap is on tabs alive at
        // once. No room means the run simply fails as it used to — worse, but
        // honest, and better than evicting somebody else's half-solved captcha.
        if (this.sessions.size < this.config.maxConcurrent) {
          const sessionId = this.newSessionId();
          this.sessions.set(sessionId, { context, page, touchedAt: Date.now(), request });
          handedOff = true;
          logger.info(
            { runId: request.runId, sessionId, stepIndex: result.failure.index },
            'bot check: holding the tab open for a person',
          );
          return {
            ...result,
            handoff: {
              sessionId,
              reason: 'bot-check',
              fromIndex: result.failure.index,
              expiresAt: new Date(Date.now() + this.config.sessionIdleMs).toISOString(),
            },
          };
        }
        logger.warn({ runId: request.runId }, 'bot check, but no room to hold the tab open');
      }

      return result;
    } catch (err) {
      this.runsFailed += 1;
      this.lastError = (err as Error).message;
      throw err;
    } finally {
      this.inFlight -= 1;
      if (!handedOff) await context?.close().catch(() => undefined);
    }
  }

  private newSessionId(): string {
    return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  // -------------------------------------------------------------------------
  // Driving a handed-over tab
  //
  // Three calls, and deliberately no more: look, act, carry on. This is not a
  // remote desktop and must not grow into one — it exists so somebody can tick
  // "no soy un robot" and hand the errand back.
  //
  // Input is by COORDINATES rather than by selector, which is the opposite of
  // everything else in this service. That is the point: a captcha widget lives
  // in a cross-origin iframe with no accessible name and no stable structure,
  // so there is nothing to address it by. A person looking at a picture and
  // clicking on it is the only thing that works, and it is also all the
  // authority this endpoint needs to grant.
  // -------------------------------------------------------------------------

  /** A picture of the tab, and where it is. */
  async viewSession(
    sessionId: string,
  ): Promise<{ png: string; url: string; title: string; width: number; height: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new UnknownSession();
    session.touchedAt = Date.now();
    const shot = await session.page.screenshot({ type: 'png' });
    return {
      png: shot.toString('base64'),
      url: session.page.url(),
      title: await session.page.title().catch(() => ''),
      width: this.config.viewportWidth,
      height: this.config.viewportHeight,
    };
  }

  /** One human gesture, delivered to the tab. */
  async sendInput(
    sessionId: string,
    input: { kind: 'click' | 'type' | 'key' | 'scroll'; x?: number; y?: number; text?: string },
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new UnknownSession();
    session.touchedAt = Date.now();
    const { page } = session;
    switch (input.kind) {
      case 'click':
        await page.mouse.click(input.x ?? 0, input.y ?? 0);
        break;
      case 'type':
        // `type` rather than `fill`: there is no element in hand, and a captcha
        // that watches for keystrokes should see keystrokes.
        await page.keyboard.type(input.text ?? '', { delay: 25 });
        break;
      case 'key':
        await page.keyboard.press(input.text || 'Enter');
        break;
      case 'scroll':
        await page.mouse.wheel(0, input.y ?? 0);
        break;
      default:
        throw new Error(`unknown input ${String(input.kind)}`);
    }
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
  }

  /**
   * Carry on from where the challenge interrupted, in the same tab.
   *
   * The steps already done are NOT repeated: `fromIndex` slices them off. That
   * is only safe because it is the same session — the same cookies, the same
   * page, the same half-filled form — which is the entire reason the tab was
   * kept instead of reopened.
   */
  async continueSession(
    sessionId: string,
    fromIndex: number,
    extraInputs: Record<string, string> = {},
  ): Promise<ReplayResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new UnknownSession();
    session.touchedAt = Date.now();
    const original = session.request;
    if (!original) throw new Error('that session was not holding an errand');

    // A `goto` at the head of the remaining steps would throw away the page the
    // person just unlocked and walk straight back into the challenge.
    const remaining = original.steps
      .slice(fromIndex)
      .filter((s, i) => !(i === 0 && s.action === 'goto'));

    // WHAT THE PERSON JUST SAID, FOLDED IN AS AN ORDINARY INPUT.
    //
    // This is the whole mechanism behind an OTP. The pause step asked for
    // `codigo`; the answer arrives here; from this line on the `fill` step
    // holding `{{codigo}}` is indistinguishable from one whose value was
    // supplied before the run ever started. No special case downstream.
    const inputs = { ...original.inputs, ...extraInputs };

    // The file map is keyed by index into the WHOLE step list, and the list
    // being replayed now starts at `fromIndex`. Rebased rather than passed
    // through, or an upload after a captcha would attach the wrong document —
    // silently, which on a form that files something is the worst way to be
    // wrong.
    const files: Record<string, import('./types').UploadPayload> = {};
    const dropped = remaining.length === original.steps.slice(fromIndex).length ? 0 : 1;
    for (const [key, payload] of Object.entries(original.files ?? {})) {
      const rebased = Number(key) - fromIndex - dropped;
      if (rebased >= 0) files[String(rebased)] = payload;
    }

    this.sessions.delete(sessionId);
    let keptOpen = false;
    try {
      const result = await replay(
        session.page,
        { ...original, steps: remaining, inputs, files },
        this.config,
      );
      if (!result.ok && !result.pause) this.runsFailed += 1;

      // Indices came out counted against the sliced list; the caller knows the
      // whole errand, so they are put back on its scale before leaving here.
      const shift = fromIndex + dropped;
      const rebased: ReplayResponse = {
        ...result,
        steps: result.steps.map((s) => ({ ...s, index: s.index + shift })),
        ...(result.failure
          ? { failure: { ...result.failure, index: result.failure.index + shift } }
          : {}),
        ...(result.pause
          ? { pause: { ...result.pause, index: result.pause.index + shift } }
          : {}),
      };

      // A SECOND PAUSE IN THE SAME ERRAND. A bank that asks for a code after
      // the login and again before it releases the certificate is not exotic,
      // it is Tuesday. Closing the tab here would make the second question
      // unanswerable and throw away everything the first answer bought, so the
      // session is put back — under a NEW id, because the old one was consumed
      // by the call that got us here and handing it back would let a retry of
      // that call resume the same tab twice.
      if (rebased.pause) {
        if (this.sessions.size < this.config.maxConcurrent) {
          const nextId = this.newSessionId();
          this.sessions.set(nextId, {
            context: session.context,
            page: session.page,
            touchedAt: Date.now(),
            // The ORIGINAL request with the answer already folded in, so a
            // third pause resumes with both answers rather than re-asking the
            // first.
            request: { ...original, inputs },
          });
          keptOpen = true;
          return {
            ...rebased,
            handoff: {
              sessionId: nextId,
              reason: 'input-needed',
              fromIndex: rebased.pause.index + 1,
              expiresAt: new Date(Date.now() + this.config.sessionIdleMs).toISOString(),
              ask: rebased.pause.ask,
              fills: rebased.pause.fills,
            },
          };
        }
        logger.warn({ runId: original.runId }, 'a resumed trámite asked again, and there was no room to wait');
      }

      return rebased;
    } finally {
      if (!keptOpen) await session.context.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Interactive sessions
  //
  // Only two things use these: the reasoned baseline the comparison in
  // docs/operations/browser.md is measured against, and the refinement pass
  // that checks a freshly extracted flow. Both need to look at a page, act,
  // and look again -- which a stateless /replay cannot express.
  //
  // They are the one piece of state this service holds, so they are swept: an
  // abandoned session is an abandoned Chromium tab, and a handful of those is
  // the container's memory.
  // -------------------------------------------------------------------------

  async openSession(startUrl: string): Promise<{ sessionId: string; snapshot: PageSnapshot }> {
    if (this.sessions.size >= this.config.maxConcurrent) throw new BusyError();
    const context = await this.newContext();
    const page = await context.newPage();
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const sessionId = this.newSessionId();
    this.sessions.set(sessionId, { context, page, touchedAt: Date.now() });
    return { sessionId, snapshot: await snapshotPage(page) };
  }

  async act(
    sessionId: string,
    action: string,
    target: Target | null,
    text: string,
    url: string,
  ): Promise<{
    ok: boolean;
    error?: string;
    matchedTarget: string | null;
    snapshot: PageSnapshot;
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new UnknownSession();
    session.touchedAt = Date.now();
    const { page } = session;
    const deadline = Date.now() + this.config.stepTimeoutMs;
    let matchedTarget: string | null = null;

    try {
      if (action === 'goto') {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.stepTimeoutMs });
      } else if (action === 'wait_for') {
        await page.waitForTimeout(1_000);
      } else {
        if (!target) throw new Error('that action needs an element');
        const found = await resolveTarget(page, [target], deadline);
        if (!isResolved(found)) {
          const direct = buildLocator(page, target).locator('visible=true').first();
          throw new Error(
            `no single visible element matches ${describeTarget(target)} (${await direct
              .count()
              .catch(() => 0)} matches)`,
          );
        }
        matchedTarget = describeTarget(found.target);
        const remaining = () => Math.max(1_000, deadline - Date.now());
        if (action === 'click') await found.locator.click({ timeout: remaining() });
        else if (action === 'fill') await found.locator.fill(text, { timeout: remaining() });
        else if (action === 'select') await found.locator.selectOption({ label: text });
        else if (action === 'check') await found.locator.check({ timeout: remaining() });
        else if (action === 'press') await found.locator.press(text || 'Enter');
        else throw new Error(`unknown action ${action}`);
      }
      await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
      return { ok: true, matchedTarget, snapshot: await snapshotPage(page) };
    } catch (err) {
      // A failed action does not end the session: a reasoning agent is expected
      // to misfire and try something else, and tearing the page down would make
      // the baseline look worse than it is.
      return {
        ok: false,
        error: (err as Error).message,
        matchedTarget,
        snapshot: await snapshotPage(page),
      };
    }
  }

  async readSession(sessionId: string): Promise<PageSnapshot> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new UnknownSession();
    session.touchedAt = Date.now();
    return snapshotPage(session.page);
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await session.context.close().catch(() => undefined);
  }

  private async sweepSessions(): Promise<void> {
    const cutoff = Date.now() - this.config.sessionIdleMs;
    for (const [id, session] of this.sessions) {
      if (session.touchedAt < cutoff) {
        logger.warn({ sessionId: id }, 'sweeping an idle session');
        await this.closeSession(id);
      }
    }
  }
}

interface InteractiveSession {
  context: BrowserContext;
  page: Page;
  touchedAt: number;
  /**
   * The errand this tab was in the middle of, kept only for a handoff so it can
   * be resumed. Absent for the reasoning and refinement sessions, which are
   * driven a step at a time by their caller and have no list to carry on with.
   */
  request?: ReplayRequest;
}

export class BusyError extends Error {
  constructor() {
    super('the browser service is at capacity');
    this.name = 'BusyError';
  }
}

export class UnknownSession extends Error {
  constructor() {
    super('that session is gone');
    this.name = 'UnknownSession';
  }
}
