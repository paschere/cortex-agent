/** Shapes shared by the Routines page (server) and its client components. */

export interface JobRun {
  id: string;
  status: 'running' | 'ok' | 'error';
  started_at: string;
  finished_at: string | null;
  output: string | null;
  error: string | null;
}

export type JobStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export interface ScheduledJob {
  id: string;
  name: string;
  kind: 'tool' | 'agent';
  toolId: string | null;
  instruction: string | null;
  scheduleKind: 'once' | 'cron';
  cron: string | null;
  timezone: string;
  runAt: string | null;
  status: JobStatus;
  nextRunAt: string | null;
  lastRunAt: string | null;
  allowUnattendedWrites: boolean;
  notifyEmail: boolean;
  conversationId: string | null;
  /** Explicit email recipients; empty means the results go to the owner. */
  recipients: string[];
  /** Owned by the workspace: visible to — and runnable by — the whole team. */
  isGlobal: boolean;
  /** Creator. Every run still executes with this user's credentials. */
  ownerId: string;
  runs: JobRun[];
}

/** Fields the inline editor can change. Mirrors the API `patch` contract. */
export interface RoutinePatch {
  name?: string;
  cron?: string;
  timezone?: string;
  notifyEmail?: boolean;
  recipients?: string[];
}
