/**
 * Branch naming and the push guardrail.
 *
 * The single hardest rule in the executor is enforced here rather than by
 * convention: Zippy never writes to a default branch and never force-pushes.
 * `assertPushable` is the only sanctioned way to build a `git push` argv, so a
 * future caller cannot skip the check by assembling the command by hand.
 */

/**
 * Branch names that are protected everywhere, on top of whatever the repo
 * declares as its default. A repo whose default is `main` can still have a
 * long-lived `production` branch nobody registered; refusing the whole set is
 * cheap and the false-positive cost (a rejected branch name) is a rerun.
 */
const ALWAYS_PROTECTED = new Set([
  'main',
  'master',
  'develop',
  'development',
  'dev',
  'trunk',
  'release',
  'releases',
  'production',
  'prod',
  'staging',
  'stage',
  'head',
  'default',
]);

/** Characters git forbids anywhere in a ref name (git-check-ref-format). */
const FORBIDDEN_REF_CHARS = new Set([' ', '~', '^', ':', '?', '*', '[', '\\']);

/** Prefix every branch Zippy opens, so its work is greppable in the repo. */
export const BRANCH_PREFIX = 'zippy';

export class ProtectedBranchError extends Error {
  constructor(branch: string, reason: string) {
    super(`Refusing to push to "${branch}": ${reason}`);
    this.name = 'ProtectedBranchError';
  }
}

function slugify(input: string, maxLength: number): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    // Drop combining marks so "añadir" slugs to "anadir", not "aadir".
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug;
  // Cut on a word boundary so the branch reads as words, not a truncated one.
  const cut = slug.slice(0, maxLength);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > maxLength / 2 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

/**
 * `zippy/eng-142-add-rate-limiting` — derived from the Linear identifier so a
 * human scanning branches can map any branch back to its issue, and so a rerun
 * of the same issue is recognisably the same branch.
 */
export function buildBranchName(externalIdentifier: string, title: string): string {
  const id = slugify(externalIdentifier, 32);
  if (!id) throw new Error(`Cannot derive a branch name from identifier "${externalIdentifier}"`);
  const subject = slugify(title, 48);
  return `${BRANCH_PREFIX}/${subject ? `${id}-${subject}` : id}`;
}

/**
 * Git's own ref rules, restricted to the subset a generated name can violate.
 * Enforced because the branch string ends up in an argv that git executes.
 */
export function isValidBranchName(branch: string): boolean {
  if (!branch || branch.length > 200) return false;
  if (branch.startsWith('/') || branch.endsWith('/')) return false;
  if (branch.startsWith('-') || branch.startsWith('.') || branch.endsWith('.')) return false;
  if (branch.endsWith('.lock')) return false;
  if (branch.includes('..') || branch.includes('//') || branch.includes('@{')) return false;
  for (const char of branch) {
    if (FORBIDDEN_REF_CHARS.has(char)) return false;
    const code = char.codePointAt(0) ?? 0;
    // ASCII control characters and DEL are forbidden in refs.
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

export function isProtectedBranch(branch: string, defaultBranch: string): boolean {
  const normalize = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/^refs\/heads\//, '');
  const candidate = normalize(branch);
  if (!candidate) return true;
  if (candidate === normalize(defaultBranch)) return true;
  return ALWAYS_PROTECTED.has(candidate);
}

/**
 * The gate every push goes through. Returns the exact argv to execute; there is
 * deliberately no way to get a push command out of this module without passing
 * the check, and no code path that can produce `--force`.
 */
export function assertPushable(params: {
  branch: string;
  defaultBranch: string;
  remote?: string;
}): string[] {
  const { branch, defaultBranch, remote = 'origin' } = params;

  if (!isValidBranchName(branch)) {
    throw new ProtectedBranchError(branch, 'not a valid git branch name');
  }
  if (isProtectedBranch(branch, defaultBranch)) {
    throw new ProtectedBranchError(
      branch,
      `it is a protected branch (repo default is "${defaultBranch}")`,
    );
  }
  if (!branch.startsWith(`${BRANCH_PREFIX}/`)) {
    // Belt and braces: even a non-protected name Zippy did not generate is
    // refused, so a prompt-injected branch name cannot reach a real push.
    throw new ProtectedBranchError(branch, `it is not under the "${BRANCH_PREFIX}/" namespace`);
  }

  // No --force, no --force-with-lease, no refspec games: a plain fast-forward
  // push of one branch to its own name.
  return ['push', '--set-upstream', remote, `${branch}:refs/heads/${branch}`];
}
