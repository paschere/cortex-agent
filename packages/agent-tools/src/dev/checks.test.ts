import { describe, expect, it } from 'vitest';
import {
  type CheckOutcome,
  allChecksPassed,
  buildCheckPlan,
  detectPackageManager,
  formatCheckSummary,
} from './checks';

describe('detectPackageManager', () => {
  it('prefers the packageManager field over the lockfile', () => {
    expect(
      detectPackageManager({
        hasPnpmLock: false,
        hasYarnLock: true,
        packageManagerField: 'pnpm@9.12.0',
      }),
    ).toBe('pnpm');
  });

  it.each([
    [{ hasPnpmLock: true, hasYarnLock: false }, 'pnpm'],
    [{ hasPnpmLock: false, hasYarnLock: true }, 'yarn'],
    [{ hasPnpmLock: false, hasYarnLock: false }, 'npm'],
  ])('falls back to the lockfile: %o -> %s', (files, expected) => {
    expect(detectPackageManager(files)).toBe(expected);
  });
});

describe('buildCheckPlan', () => {
  it('builds a plan from the scripts the repo actually declares', () => {
    const plan = buildCheckPlan({
      packageJson: {
        packageManager: 'pnpm@9.12.0',
        scripts: { build: 'turbo build', typecheck: 'turbo typecheck', test: 'turbo test' },
      },
      hasPnpmLock: true,
      hasYarnLock: false,
    });

    expect(plan.packageManager).toBe('pnpm');
    expect(plan.install.args).toEqual(['install', '--frozen-lockfile']);
    expect(plan.steps.map((s) => s.id)).toEqual(['typecheck', 'test', 'build']);
    expect(plan.steps[0]?.args).toEqual(['run', 'typecheck']);
    expect(plan.isConclusive).toBe(true);
  });

  it('orders cheap and specific checks before the build', () => {
    const plan = buildCheckPlan({
      packageJson: { scripts: { build: 'x', test: 'x', lint: 'x', typecheck: 'x' } },
      hasPnpmLock: true,
      hasYarnLock: false,
    });
    expect(plan.steps.map((s) => s.id)).toEqual(['typecheck', 'lint', 'test', 'build']);
  });

  it('accepts alternate script spellings', () => {
    const plan = buildCheckPlan({
      packageJson: { scripts: { 'type-check': 'tsc --noEmit', 'test:unit': 'vitest run' } },
      hasPnpmLock: false,
      hasYarnLock: false,
    });
    expect(plan.steps.map((s) => s.args.at(-1))).toEqual(['type-check', 'test:unit']);
    expect(plan.steps.every((s) => s.cmd === 'npm')).toBe(true);
    expect(plan.install.args).toEqual(['ci']);
  });

  it('ignores a script declared as an empty string', () => {
    const plan = buildCheckPlan({
      packageJson: { scripts: { test: '', build: 'tsc' } },
      hasPnpmLock: true,
      hasYarnLock: false,
    });
    expect(plan.steps.map((s) => s.id)).toEqual(['build']);
  });

  it('is inconclusive when the repo declares no verification scripts', () => {
    const plan = buildCheckPlan({
      packageJson: { scripts: { dev: 'next dev' } },
      hasPnpmLock: true,
      hasYarnLock: false,
    });
    expect(plan.steps).toEqual([]);
    expect(plan.isConclusive).toBe(false);
  });

  it('is inconclusive for a repo with no package.json at all', () => {
    const plan = buildCheckPlan({ packageJson: null, hasPnpmLock: false, hasYarnLock: false });
    expect(plan.isConclusive).toBe(false);
  });

  it('bounds every step so a hung build cannot eat the run', () => {
    const plan = buildCheckPlan({
      packageJson: { scripts: { build: 'x' } },
      hasPnpmLock: true,
      hasYarnLock: false,
    });
    for (const step of [plan.install, ...plan.steps]) {
      expect(step.timeoutMs).toBeGreaterThan(0);
    }
  });
});

describe('allChecksPassed', () => {
  const pass = (id: string): CheckOutcome => ({
    id,
    label: id,
    passed: true,
    exitCode: 0,
    output: '',
  });
  const fail = (id: string): CheckOutcome => ({
    id,
    label: id,
    passed: false,
    exitCode: 1,
    output: 'boom',
  });

  it('requires every check to pass', () => {
    expect(allChecksPassed([pass('typecheck'), pass('test')])).toBe(true);
    expect(allChecksPassed([pass('typecheck'), fail('test')])).toBe(false);
  });

  it('treats "no checks ran" as not passing, never as success', () => {
    expect(allChecksPassed([])).toBe(false);
  });

  it('renders one line per check for the PR body', () => {
    expect(formatCheckSummary([pass('typecheck'), fail('test')])).toBe(
      '- ✅ `typecheck` (exit 0)\n- ❌ `test` (exit 1)',
    );
    expect(formatCheckSummary([])).toMatch(/No verification steps/);
  });
});
