import type { ToolContext } from "../types";

/**
 * BambooHR REST API v1 transport.
 *
 * Auth and endpoint shape are deliberately identical to the payroll app's
 * client (payroll/src/lib/bamboohr.ts): HTTP Basic with `base64(apiKey + ":x")`
 * against a `gateway.php/<company>/v1` base. Inventing a second dialect against
 * one HR system of record is how two integrations drift apart and start
 * disagreeing about who works here.
 *
 * Like the Apollo client, this one NEVER THROWS. A missing key, a rotated key
 * or a module the instance does not license are ordinary operating conditions
 * on a third party we do not control; a thrown error would abort the whole
 * Cortex turn. Every call returns a result the tool can turn into a plain
 * sentence.
 *
 * The key is read from the environment on every call and never logged, never
 * echoed into an error message, and never included in a tool's output.
 */

/**
 * The gateway base from `BAMBOOHR_BASE_URL`, or `null` when unset.
 *
 * There is deliberately NO default. BambooHR's gateway URL embeds the
 * customer's own subdomain (`.../gateway.php/<company>/v1`), so any default
 * would point every deployment at one particular company's HR system — a
 * cross-tenant leak waiting to happen, and a confusing 404 at best. Unset is
 * therefore treated exactly like a missing API key: the tools degrade with a
 * sentence a human can act on instead of guessing an address.
 */
export function bambooBase(): string | null {
  const raw = process.env.BAMBOOHR_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/** Soft failure: never thrown, always returned. `reason` is user-facing prose. */
export interface BambooFailure {
  ok: false;
  configured: boolean;
  reason: string;
}

export type BambooResult<T> = { ok: true; data: T } | BambooFailure;

export const NOT_CONFIGURED_REASON =
  "BambooHR is not connected yet — this workspace has no BambooHR key, so I cannot see the employee records. Someone on the ops team needs to add it first.";

export const NO_BASE_URL_REASON =
  "BambooHR is only half configured — there is a key but no BambooHR address for this workspace, so I do not know which BambooHR account to ask. Ops needs to set BAMBOOHR_BASE_URL before I can read anything from there.";

function describeHttpFailure(status: number): string {
  if (status === 401) {
    return "BambooHR rejected our key. It has most likely been rotated or switched off — ops needs to refresh it before I can read anything from there.";
  }
  if (status === 403) {
    return "BambooHR let us in but will not share that particular information — the account Cortex uses does not have permission for it. An HR admin can widen that access in BambooHR.";
  }
  if (status === 404) {
    return "BambooHR has nothing at that address. Usually that means the person or record does not exist, or this workspace does not use that part of BambooHR.";
  }
  if (status === 429) {
    return "BambooHR is rate-limiting us right now — too many lookups in a short window. Give it a minute and I can try again.";
  }
  if (status === 400 || status === 406) {
    return "BambooHR turned that request down as invalid. A narrower date range or fewer fields usually works.";
  }
  if (status >= 500) {
    return "BambooHR is having trouble on their side and did not answer. That normally clears on its own within a few minutes.";
  }
  return `BambooHR could not complete that request (it answered ${status}).`;
}

export type QueryValue = string | number | boolean | undefined | null;

function toSearchParams(params: Record<string, QueryValue>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    sp.append(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export async function bambooFetch<T>(
  ctx: ToolContext,
  method: "GET" | "POST",
  path: string,
  opts: { params?: Record<string, QueryValue>; body?: unknown } = {},
): Promise<BambooResult<T>> {
  const key = process.env.BAMBOOHR_API;
  if (!key)
    return { ok: false, configured: false, reason: NOT_CONFIGURED_REASON };

  const base = bambooBase();
  if (!base)
    return { ok: false, configured: false, reason: NO_BASE_URL_REASON };

  // BambooHR uses the API key as the Basic username with a throwaway password;
  // "x" is the literal the vendor documents.
  const auth = `Basic ${Buffer.from(`${key}:x`).toString("base64")}`;
  const url = `${base}${path}${toSearchParams(opts.params ?? {})}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/json",
        ...(opts.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctx.signal,
    });
  } catch (err) {
    ctx.logger.warn({ err, path }, "bamboohr request failed");
    return {
      ok: false,
      configured: true,
      reason:
        "I could not reach BambooHR at all just now. It may be a network blip — worth another try in a moment.",
    };
  }

  if (!res.ok) {
    // The response body can carry the employee being looked up, so only the
    // status and the path are logged — never the body, never the key.
    ctx.logger.warn({ status: res.status, path }, "bamboohr returned an error");
    return {
      ok: false,
      configured: true,
      reason: describeHttpFailure(res.status),
    };
  }

  const text = await res.text().catch(() => "");
  // BambooHR answers some empty collections with a blank body rather than `[]`.
  if (!text.trim()) return { ok: true, data: [] as unknown as T };

  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return {
      ok: false,
      configured: true,
      reason:
        "BambooHR answered with something I could not read. Worth trying again in a moment.",
    };
  }
}
