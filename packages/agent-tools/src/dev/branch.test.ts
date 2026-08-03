import { describe, expect, it } from 'vitest';
import {
  BRANCH_PREFIX,
  ProtectedBranchError,
  assertPushable,
  buildBranchName,
  isProtectedBranch,
  isValidBranchName,
} from './branch';

describe('buildBranchName', () => {
  it('derives a branch from the Linear identifier and title', () => {
    expect(buildBranchName('ENG-142', 'Add rate limiting to the chat route')).toBe(
      'cortex/eng-142-add-rate-limiting-to-the-chat-route',
    );
  });

  it('truncates a long title on a word boundary', () => {
    expect(
      buildBranchName('ENG-143', 'Add rate limiting to the chat route and the tools route'),
    ).toBe('cortex/eng-143-add-rate-limiting-to-the-chat-route-and-the');
  });

  it('always produces a valid, non-protected, namespaced branch', () => {
    const cases: Array<[string, string]> = [
      ['ENG-1', 'main'],
      ['OPS-99', '   '],
      ['ENG-7', 'Fix ../../etc/passwd handling'],
      ['ENG-8', 'Añadir límites de tasa'],
      ['ENG-9', 'a'.repeat(300)],
      ['ENG-10', 'feat: support `--force` pushes?!'],
    ];
    for (const [id, title] of cases) {
      const branch = buildBranchName(id, title);
      expect(isValidBranchName(branch), branch).toBe(true);
      expect(isProtectedBranch(branch, 'main'), branch).toBe(false);
      expect(branch.startsWith(`${BRANCH_PREFIX}/`), branch).toBe(true);
    }
  });

  it('strips accents rather than dropping the letters they sit on', () => {
    expect(buildBranchName('ENG-8', 'Añadir')).toBe('cortex/eng-8-anadir');
  });

  it('falls back to the identifier alone when the title slugs to nothing', () => {
    expect(buildBranchName('ENG-11', '???')).toBe('cortex/eng-11');
  });

  it('refuses an identifier that cannot produce a slug', () => {
    expect(() => buildBranchName('///', 'anything')).toThrow(/Cannot derive a branch name/);
  });
});

describe('isValidBranchName', () => {
  it.each([
    ['cortex/eng-1-ok', true],
    ['', false],
    ['cortex/eng-1..bad', false],
    ['cortex/eng-1 bad', false],
    ['cortex//eng-1', false],
    ['cortex/eng-1.lock', false],
    ['cortex/eng-1@{0}', false],
    ['cortex/eng-1~1', false],
    ['cortex/eng-1^', false],
    ['cortex/eng:1', false],
    ['cortex/eng?1', false],
    ['cortex/eng*1', false],
    ['cortex/eng[1', false],
    ['cortex/eng\\1', false],
    ['-cortex/eng-1', false],
    ['.cortex/eng-1', false],
    ['cortex/eng-1/', false],
    ['cortex/eng-1 ', false],
    [String.raw`cortex/eng-1` + String.fromCharCode(9), false],
    [String.raw`cortex/eng-1` + String.fromCharCode(7), false],
    [String.raw`cortex/eng-1` + String.fromCharCode(127), false],
  ])('validates %s as %s', (branch, expected) => {
    expect(isValidBranchName(branch)).toBe(expected);
  });
});

describe('isProtectedBranch', () => {
  it("treats the repo's own default as protected", () => {
    expect(isProtectedBranch('trunk-of-ours', 'trunk-of-ours')).toBe(true);
    expect(isProtectedBranch('TRUNK-OF-OURS', 'trunk-of-ours')).toBe(true);
    expect(isProtectedBranch('refs/heads/trunk-of-ours', 'trunk-of-ours')).toBe(true);
  });

  it('protects the well-known names even when they are not the default', () => {
    for (const name of ['main', 'master', 'production', 'staging', 'develop', 'HEAD']) {
      expect(isProtectedBranch(name, 'some-other-default'), name).toBe(true);
    }
  });

  it('allows an ordinary feature branch', () => {
    expect(isProtectedBranch('cortex/eng-1-thing', 'main')).toBe(false);
  });

  it('treats an empty branch name as protected', () => {
    expect(isProtectedBranch('   ', 'main')).toBe(true);
  });
});

describe('assertPushable', () => {
  it('returns a plain fast-forward push argv for a valid feature branch', () => {
    expect(assertPushable({ branch: 'cortex/eng-1-thing', defaultBranch: 'main' })).toEqual([
      'push',
      '--set-upstream',
      'origin',
      'cortex/eng-1-thing:refs/heads/cortex/eng-1-thing',
    ]);
  });

  it('never emits a force flag', () => {
    const argv = assertPushable({ branch: 'cortex/eng-1-thing', defaultBranch: 'main' });
    expect(argv.join(' ')).not.toMatch(/--force|-f\b/);
  });

  it('refuses the repo default branch', () => {
    expect(() => assertPushable({ branch: 'main', defaultBranch: 'main' })).toThrow(
      ProtectedBranchError,
    );
  });

  it('refuses a default branch that is not one of the well-known names', () => {
    expect(() => assertPushable({ branch: 'our-trunk', defaultBranch: 'our-trunk' })).toThrow(
      /protected branch/,
    );
  });

  it.each(['master', 'production', 'develop', 'staging', 'HEAD'])(
    'refuses the always-protected branch %s',
    (branch) => {
      expect(() => assertPushable({ branch, defaultBranch: 'main' })).toThrow(ProtectedBranchError);
    },
  );

  it('refuses a branch outside the cortex/ namespace', () => {
    expect(() => assertPushable({ branch: 'feature/whatever', defaultBranch: 'main' })).toThrow(
      /not under the "cortex\/" namespace/,
    );
  });

  it('refuses a refspec smuggled into the branch name', () => {
    expect(() =>
      assertPushable({ branch: 'cortex/x:refs/heads/main', defaultBranch: 'main' }),
    ).toThrow(/not a valid git branch name/);
  });

  it('refuses a branch name that would be read as a flag', () => {
    expect(() => assertPushable({ branch: '--force', defaultBranch: 'main' })).toThrow(
      ProtectedBranchError,
    );
  });
});
