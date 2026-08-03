/**
 * What the model is allowed to reach.
 *
 * The sandbox already contains the blast radius — it is a throwaway microVM
 * holding one repo and one repo-scoped token. These guards are the second
 * layer: they stop the model from escaping the checkout, and from driving git
 * itself, so that branch/commit/push stay under the orchestrator's control
 * where the protected-branch check lives.
 */

export class UnsafeCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeCommandError';
  }
}

/**
 * Git is refused wholesale rather than filtered.
 *
 * A `git push --force` allowlist is a losing game: `git -c alias.x='!sh -c ...'`,
 * `git config`, `git remote set-url` and half a dozen other spellings all reach
 * the same place. Since the model never needs git — the orchestrator branches,
 * commits and pushes for it — the safe rule is the simple one.
 */
const BANNED_EXECUTABLES = new Set([
  'git',
  'gh',
  'hub',
  // Shipping code to somewhere other than the PR is not part of the job.
  'ssh',
  'scp',
  'rsync',
  'sftp',
  'nc',
  'ncat',
  'netcat',
]);

/** Extract the executable of every command in a shell line, including pipes,
 *  `&&`/`||`/`;` chains, and `$(...)`/backtick substitutions. */
function executablesIn(command: string): string[] {
  // Split on shell operators and substitution boundaries, then take the first
  // bare word of each fragment. Deliberately over-approximate: a fragment that
  // is not really a command position yields a harmless extra name to check.
  const fragments = command
    .replace(/\$\(/g, ' ; ')
    .replace(/[`)]/g, ' ; ')
    .split(/(?:\|\||&&|[|;&\n])/);

  const found: string[] = [];
  for (const fragment of fragments) {
    const words = fragment.trim().split(/\s+/).filter(Boolean);
    for (const word of words) {
      // Skip leading env assignments (FOO=bar git push) and redirections.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
      if (word.startsWith('<') || word.startsWith('>')) continue;
      // Strip any path prefix: /usr/bin/git and ./git are still git.
      const base = word.split('/').pop() ?? word;
      found.push(base.toLowerCase());
      break;
    }
  }
  return found;
}

/**
 * Vet a model-supplied shell command before it runs in the sandbox. Throws
 * `UnsafeCommandError`; the orchestrator turns that into a tool_result the
 * model can read and adapt to, rather than failing the whole run.
 */
export function assertSafeBashCommand(command: string): void {
  const trimmed = command.trim();
  if (!trimmed) throw new UnsafeCommandError('Empty command.');
  if (trimmed.length > 4000) throw new UnsafeCommandError('Command is too long.');

  for (const executable of executablesIn(trimmed)) {
    if (BANNED_EXECUTABLES.has(executable)) {
      throw new UnsafeCommandError(
        [
          `\`${executable}\` is not available to you.`,
          'Branching, committing, pushing and opening the pull request are handled by the',
          'runner after you call finish. If you need to inspect history, say so in your',
          'summary instead.',
        ].join(' '),
      );
    }
  }
}

/**
 * Confine a model-supplied path to the checkout.
 *
 * Returns the path normalised relative to the repo root. Absolute paths and any
 * traversal that climbs out are refused — including after normalisation, so
 * `a/../../etc/passwd` is caught rather than the literal `../` spelling only.
 */
export function resolveRepoPath(repoRoot: string, requested: string): string {
  const raw = requested.trim();
  if (!raw) throw new UnsafeCommandError('Empty path.');
  if (raw.includes('\0')) throw new UnsafeCommandError('Path contains a null byte.');

  const relative = raw.startsWith(`${repoRoot}/`) ? raw.slice(repoRoot.length + 1) : raw;
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) {
    throw new UnsafeCommandError(
      `Absolute paths are not allowed; "${requested}" must be relative to the repository root.`,
    );
  }

  const segments: string[] = [];
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        throw new UnsafeCommandError(`"${requested}" escapes the repository checkout.`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) return repoRoot;

  // `.cortex/` is how the run survives between invocations (transcript, parked
  // tool results, check output) and `.git/` is the repository plumbing the
  // orchestrator drives. Refusing git as an executable would be theatre if the
  // model could rewrite .git/config or drop a hook instead.
  const top = segments[0];
  if (top === '.cortex') {
    throw new UnsafeCommandError("`.cortex/` holds the runner's own state and is off limits.");
  }
  if (top === '.git') {
    throw new UnsafeCommandError(
      '`.git/` is off limits. Branching, committing and pushing are handled for you.',
    );
  }
  return `${repoRoot}/${segments.join('/')}`;
}
