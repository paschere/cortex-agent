import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import type { Config } from './config';
import { buildLocator, describeTarget, isResolved, resolveTarget } from './locators';
import { logger } from './logger';
import { replay } from './replay';
import { snapshotPage } from './snapshot';
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
        args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'],
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

  private async newContext(): Promise<BrowserContext> {
    const browser = await this.ensureBrowser();
    return browser.newContext({
      viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
      ...(this.config.userAgent ? { userAgent: this.config.userAgent } : {}),
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
  }

  /** Run a learned flow. One context, created and destroyed here. */
  async runReplay(request: ReplayRequest): Promise<ReplayResponse> {
    if (this.inFlight >= this.config.maxConcurrent) {
      throw new BusyError();
    }
    this.inFlight += 1;
    this.runsTotal += 1;
    let context: BrowserContext | null = null;
    try {
      context = await this.newContext();
      const page = await context.newPage();
      await page.goto(request.startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const result = await replay(page, request, this.config);
      if (!result.ok) this.runsFailed += 1;
      return result;
    } catch (err) {
      this.runsFailed += 1;
      this.lastError = (err as Error).message;
      throw err;
    } finally {
      this.inFlight -= 1;
      await context?.close().catch(() => undefined);
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
    const sessionId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
