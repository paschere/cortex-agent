import type { Config } from './config';
import { logger } from './logger';
import { type ClaimReply, decideOnClaim, planReconcile } from './reconcile';

/**
 * Many workspaces, one process (migration 0189).
 *
 * Holds one `WhatsappSession` per workspace that Cortex has leased to this
 * process and reconciles towards Cortex's list every `reconcileMs`. The
 * decisions — what to start, what to stop, when to let go of everything — are
 * pure functions in `reconcile.ts`; this file only carries them out.
 *
 * Starts are staggered: a boot with fifty paired workspaces would otherwise
 * load fifty key stores from Cortex and open fifty WhatsApp logins in the same
 * second, which is both a stampede on Cortex and exactly the kind of
 * machine-shaped burst WhatsApp notices.
 */

/** What the manager needs from a session. `WhatsappSession` is the real one. */
export interface ManagedSession {
  readonly organizationId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): { status: string } & Record<string, unknown>;
  currentQr(): string | null;
}

export interface ControlClient {
  claim(body: { running: string[] }): Promise<ClaimReply | null>;
  release(): Promise<unknown>;
}

export interface ManagerDeps {
  control: ControlClient;
  createSession: (organizationId: string) => ManagedSession;
  now?: () => number;
  /** Injected so tests do not wait for real staggers. */
  schedule?: (fn: () => void, ms: number) => void;
}

type ManagerConfig = Pick<
  Config,
  | 'mode'
  | 'organizationId'
  | 'instanceId'
  | 'maxSessions'
  | 'reconcileMs'
  | 'leaseMs'
  | 'startStaggerMs'
>;

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  /** Sessions being stopped: their sockets and memory are not gone yet. */
  private readonly stopping = new Set<string>();
  /** When each session was started, to protect a brand-new one from a stale list. */
  private readonly startedAt = new Map<string, number>();
  private lastRenewedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closing = false;
  private reconciling = false;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(
    private readonly config: ManagerConfig,
    private readonly deps: ManagerDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  }

  async start(): Promise<void> {
    logger.info(
      {
        mode: this.config.mode,
        instance: this.config.instanceId,
        maxSessions: this.config.maxSessions,
      },
      this.config.mode === 'single'
        ? 'single mode: serving the one workspace in WHATSAPP_ORGANIZATION_ID'
        : 'multi mode: serving every workspace Cortex leases to this process',
    );
    // Single mode starts its session at once, exactly as before: it does not
    // wait for Cortex to answer anything.
    if (this.config.mode === 'single' && this.config.organizationId) {
      this.launch(this.config.organizationId, 0);
    }
    await this.reconcileOnce();
    this.loop();
  }

  private loop(): void {
    if (this.closing) return;
    this.timer = setTimeout(() => {
      void this.reconcileOnce().finally(() => this.loop());
    }, this.config.reconcileMs);
  }

  /** One round: claim, decide, start and stop. Public for tests. */
  async reconcileOnce(): Promise<void> {
    if (this.reconciling || this.closing) return;
    this.reconciling = true;
    try {
      const reply = await this.deps.control.claim({ running: [...this.sessions.keys()] });
      const now = this.now();
      if (reply) this.lastRenewedAt = now;

      const decision = decideOnClaim({
        mode: this.config.mode,
        reply,
        lastRenewedAt: this.lastRenewedAt,
        now,
        leaseMs: this.config.leaseMs,
        marginMs: Math.min(this.config.reconcileMs, this.config.leaseMs / 4),
        organizationId: this.config.organizationId,
      });

      if (decision.kind === 'hold') return;

      if (decision.kind === 'release_all') {
        if (this.sessions.size > 0) {
          logger.error(
            { sessions: this.sessions.size },
            'lost contact with Cortex for longer than the lease; letting go of every WhatsApp socket so no other process ends up sharing one',
          );
        }
        await Promise.all([...this.sessions.keys()].map((org) => this.retire(org)));
        return;
      }

      if (reply?.waiting && reply.waiting > 0) {
        logger.warn(
          { waiting: reply.waiting, maxSessions: this.config.maxSessions },
          'some workspaces need a WhatsApp socket and are not served by this process',
        );
      }

      const graceMs = this.config.reconcileMs * 2;
      const plan = planReconcile({
        desired: decision.desired,
        running: [...this.sessions.keys()],
        stopping: [...this.stopping],
        protected: [...this.startedAt.entries()]
          .filter(([, at]) => now - at < graceMs)
          .map(([org]) => org),
        maxSessions: this.config.mode === 'single' ? 1 : this.config.maxSessions,
      });

      for (const org of plan.stop) void this.retire(org);
      plan.start.forEach((org, i) => this.launch(org, i * this.config.startStaggerMs));
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'reconcile failed; trying again next round');
    } finally {
      this.reconciling = false;
    }
  }

  private launch(organizationId: string, delayMs: number): void {
    if (this.sessions.has(organizationId) || this.closing) return;
    const session = this.deps.createSession(organizationId);
    this.sessions.set(organizationId, session);
    this.startedAt.set(organizationId, this.now());
    logger.info({ org: organizationId, delayMs }, 'starting a WhatsApp session');
    const run = () => {
      if (this.sessions.get(organizationId) !== session) return;
      void session.start().catch((err: unknown) => {
        logger.error(
          { org: organizationId, err: (err as Error).message },
          'a WhatsApp session failed to start',
        );
      });
    };
    if (delayMs > 0) this.schedule(run, delayMs);
    else run();
  }

  private async retire(organizationId: string): Promise<void> {
    const session = this.sessions.get(organizationId);
    if (!session) return;
    this.sessions.delete(organizationId);
    this.startedAt.delete(organizationId);
    this.stopping.add(organizationId);
    logger.info({ org: organizationId }, 'stopping a WhatsApp session');
    try {
      await session.stop();
    } catch (err) {
      logger.warn({ org: organizationId, err: (err as Error).message }, 'session stop failed');
    } finally {
      this.stopping.delete(organizationId);
    }
  }

  /** Shutdown: flush every session, then hand every workspace back. */
  async stop(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const orgs = [...this.sessions.keys()];
    await Promise.all(orgs.map((org) => this.retire(org)));
    await this.deps.control.release();
  }

  running(): string[] {
    return [...this.sessions.keys()].sort();
  }

  session(organizationId: string): ManagedSession | null {
    return this.sessions.get(organizationId) ?? null;
  }

  /** What /health answers: counts, never whose numbers or what they said. */
  snapshot(): {
    mode: string;
    instanceId: string;
    sessions: number;
    maxSessions: number;
    byStatus: Record<string, number>;
    leaseFresh: boolean;
  } {
    const byStatus: Record<string, number> = {};
    for (const session of this.sessions.values()) {
      const status = String(session.snapshot().status);
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
    return {
      mode: this.config.mode,
      instanceId: this.config.instanceId,
      sessions: this.sessions.size,
      maxSessions: this.config.maxSessions,
      byStatus,
      leaseFresh:
        this.lastRenewedAt !== null && this.now() - this.lastRenewedAt < this.config.leaseMs,
    };
  }
}
