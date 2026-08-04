import "server-only";
import { createSign } from "node:crypto";
import { logger } from "@cortex/core";

/**
 * The GitHub credential the sandbox is allowed to hold.
 *
 * The existing `packages/agent-tools/src/github` client reads a per-user OAuth
 * token out of the encrypted `integrations` table. That is the wrong shape
 * here twice over: an unattended run has no user to borrow from, and a user's
 * OAuth token carries their whole account, not one repository.
 *
 * So this module mints a credential scoped as narrowly as the configuration
 * allows, preferring a GitHub App installation token restricted to the single
 * repository being worked on. Installation tokens expire in an hour, which is
 * the right lifetime for a run — a leaked token from a sandbox is worth almost
 * nothing an hour later, and worth nothing at all outside that one repo.
 */

export interface RepoToken {
  token: string;
  /** True when GitHub itself limits the token to this one repository. */
  scopedToRepo: boolean;
  expiresAt: string | null;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

/** `https://github.com/Cortex-Team/payroll.git` -> `{ Cortex-Team, payroll }`. */
export function parseRepoUrl(cloneUrl: string): RepoRef {
  const match = cloneUrl.match(
    /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo) {
    throw new Error(
      `Cannot parse a GitHub owner/repo out of clone URL "${cloneUrl}"`,
    );
  }
  return { owner, repo };
}

function appJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  // 60s of backdating absorbs clock skew between us and GitHub; GitHub rejects
  // anything with more than 10 minutes of life.
  const payload = { iat: now - 60, exp: now + 540, iss: appId };
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(privateKeyPem, "base64url");
  return `${unsigned}.${signature}`;
}

async function mintInstallationToken(params: {
  appId: string;
  privateKey: string;
  installationId: string;
  repo: RepoRef;
}): Promise<RepoToken> {
  const jwt = appJwt(params.appId, params.privateKey);
  const response = await fetch(
    `https://api.github.com/app/installations/${params.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // This is the whole point: GitHub, not us, confines the token to one
        // repository and to the permissions the run actually needs.
        repositories: [params.repo.repo],
        permissions: {
          contents: "write",
          pull_requests: "write",
          metadata: "read",
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub refused an installation token for ${params.repo.owner}/${params.repo.repo}: ` +
        `${response.status} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { token: string; expires_at: string };
  return { token: body.token, scopedToRepo: true, expiresAt: body.expires_at };
}

/**
 * Resolve a token for one repository.
 *
 * Prefers the GitHub App path. Falls back to `DEV_TASK_GITHUB_TOKEN`, which
 * should be a fine-grained PAT restricted to the allowlisted repositories —
 * that fallback is flagged in the return value and logged, because it is
 * broader than one repo and operators should know when they are relying on it.
 */
export async function resolveRepoToken(repo: RepoRef): Promise<RepoToken> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

  if (appId && privateKey && installationId) {
    return mintInstallationToken({ appId, privateKey, installationId, repo });
  }

  const pat = process.env.DEV_TASK_GITHUB_TOKEN;
  if (!pat) {
    throw new Error(
      "No GitHub credential for dev tasks. Configure GITHUB_APP_ID + " +
        "GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID (preferred: the token is " +
        "scoped to one repository and expires in an hour), or DEV_TASK_GITHUB_TOKEN as a " +
        "fine-grained PAT limited to the allowlisted repositories.",
    );
  }

  logger.warn("dev-task: falling back to DEV_TASK_GITHUB_TOKEN", {
    repo: `${repo.owner}/${repo.repo}`,
    note: "token is not confined to a single repository by GitHub; configure a GitHub App",
  });
  return { token: pat, scopedToRepo: false, expiresAt: null };
}

/** Redact a token anywhere it might have leaked into command output. */
export function redact(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("***");
}
