import 'server-only';
import { ProtectedBranchError, isProtectedBranch } from '@zipdev/agent-tools';
import type { RepoRef } from './github-token';

/**
 * Opening the pull request. Deliberately the only GitHub write this executor
 * performs — Zippy proposes, a human merges.
 */

export interface OpenedPullRequest {
  url: string;
  number: number;
}

export async function openPullRequest(params: {
  repo: RepoRef;
  token: string;
  head: string;
  base: string;
  title: string;
  body: string;
}): Promise<OpenedPullRequest> {
  const { repo, token, head, base, title, body } = params;

  // The last gate before the write. `base` is the branch the PR would MERGE
  // INTO — it is supposed to be the default branch — while `head` is Zippy's
  // work. Swapping them would be a request to merge main into a feature
  // branch, or worse; refusing a protected `head` catches that.
  if (isProtectedBranch(head, base)) {
    throw new ProtectedBranchError(head, 'a pull request cannot be opened FROM a protected branch');
  }

  const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, head, base, maintainer_can_modify: true, draft: false }),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub refused to open a pull request on ${repo.owner}/${repo.repo}: ` +
        `${response.status} ${await response.text()}`,
    );
  }

  const pr = (await response.json()) as { html_url: string; number: number };
  return { url: pr.html_url, number: pr.number };
}

/**
 * Leave the run's outcome as a comment when there is no pull request to carry
 * it — an ambiguous task that produced a question, or a run that could not make
 * the checks pass. Best effort: losing the comment must not lose the run.
 */
export async function commentOnPullRequest(params: {
  repo: RepoRef;
  token: string;
  number: number;
  body: string;
}): Promise<void> {
  await fetch(
    `https://api.github.com/repos/${params.repo.owner}/${params.repo.repo}/issues/${params.number}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: params.body }),
    },
  );
}
