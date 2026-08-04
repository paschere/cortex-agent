/**
 * "Run the repo's own checks" — discovered, not hardcoded.
 *
 * The executor must work against cortex-agent, the matcher service and payroll,
 * which do not share a script vocabulary. So instead of assuming
 * `pnpm typecheck`, we read the target repo's package.json and build a plan
 * from the scripts it actually declares, in the order a human would run them
 * (cheap and specific first, so a failure reports the most useful error).
 *
 * A repo that declares none of these gets an empty plan, and `isConclusive`
 * is false — which the orchestrator treats as "cannot verify", never as "pass".
 */

export type PackageManager = 'pnpm' | 'yarn' | 'npm';

export interface CheckStep {
  /** Stable id used in the transcript and the PR body. */
  id: string;
  /** Human label for the PR body: "typecheck", "tests", … */
  label: string;
  cmd: string;
  args: string[];
  /** Generous per-command ceiling; a hung build must not eat the run budget. */
  timeoutMs: number;
}

export interface CheckPlan {
  packageManager: PackageManager;
  install: CheckStep;
  steps: CheckStep[];
  /**
   * False when the repo declares no recognisable verification scripts. A run
   * that cannot verify its own work must report that honestly rather than
   * opening a PR on the strength of no evidence.
   */
  isConclusive: boolean;
}

/** Script names we know how to interpret, most specific first. */
const KNOWN_SCRIPTS: Array<{ id: string; label: string; names: string[] }> = [
  {
    id: 'typecheck',
    label: 'typecheck',
    names: ['typecheck', 'type-check', 'tsc'],
  },
  { id: 'lint', label: 'lint', names: ['lint', 'check'] },
  { id: 'test', label: 'tests', names: ['test', 'test:unit'] },
  { id: 'build', label: 'build', names: ['build'] },
];

const FIFTEEN_MINUTES = 15 * 60 * 1000;

export function detectPackageManager(files: {
  hasPnpmLock: boolean;
  hasYarnLock: boolean;
  packageManagerField?: string | null;
}): PackageManager {
  const field = files.packageManagerField ?? '';
  if (field.startsWith('pnpm')) return 'pnpm';
  if (field.startsWith('yarn')) return 'yarn';
  if (files.hasPnpmLock) return 'pnpm';
  if (files.hasYarnLock) return 'yarn';
  return 'npm';
}

function runScript(pm: PackageManager, script: string): { cmd: string; args: string[] } {
  if (pm === 'npm') return { cmd: 'npm', args: ['run', script] };
  return { cmd: pm, args: ['run', script] };
}

function installArgs(pm: PackageManager): { cmd: string; args: string[] } {
  if (pm === 'pnpm') return { cmd: 'pnpm', args: ['install', '--frozen-lockfile'] };
  if (pm === 'yarn') return { cmd: 'yarn', args: ['install', '--frozen-lockfile'] };
  return { cmd: 'npm', args: ['ci'] };
}

/**
 * Build the plan from the target repo's root package.json.
 *
 * `packageJson` is the parsed root manifest; pass null when the repo has none
 * (a non-Node repo), which yields an inconclusive empty plan rather than a
 * guess at some other toolchain.
 */
export function buildCheckPlan(params: {
  packageJson: {
    scripts?: Record<string, string>;
    packageManager?: string;
  } | null;
  hasPnpmLock: boolean;
  hasYarnLock: boolean;
}): CheckPlan {
  const scripts = params.packageJson?.scripts ?? {};
  const pm = detectPackageManager({
    hasPnpmLock: params.hasPnpmLock,
    hasYarnLock: params.hasYarnLock,
    packageManagerField: params.packageJson?.packageManager ?? null,
  });

  const steps: CheckStep[] = [];
  for (const known of KNOWN_SCRIPTS) {
    const name = known.names.find((n) => typeof scripts[n] === 'string' && scripts[n] !== '');
    if (!name) continue;
    const { cmd, args } = runScript(pm, name);
    steps.push({
      id: known.id,
      label: known.label,
      cmd,
      args,
      timeoutMs: FIFTEEN_MINUTES,
    });
  }

  const install = installArgs(pm);
  return {
    packageManager: pm,
    install: {
      id: 'install',
      label: 'install dependencies',
      cmd: install.cmd,
      args: install.args,
      timeoutMs: FIFTEEN_MINUTES,
    },
    steps,
    isConclusive: steps.length > 0,
  };
}

export interface CheckOutcome {
  id: string;
  label: string;
  passed: boolean;
  exitCode: number;
  /** Tail of combined output, already truncated for the transcript. */
  output: string;
}

export function allChecksPassed(outcomes: CheckOutcome[]): boolean {
  return outcomes.length > 0 && outcomes.every((o) => o.passed);
}

/** One line per check, for the PR body's "what was verified" section. */
export function formatCheckSummary(outcomes: CheckOutcome[]): string {
  if (outcomes.length === 0) return '_No verification steps were run._';
  return outcomes
    .map((o) => `- ${o.passed ? '✅' : '❌'} \`${o.label}\` (exit ${o.exitCode})`)
    .join('\n');
}
