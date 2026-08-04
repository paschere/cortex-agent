import type { ToolContext } from '../types';

/**
 * Transport for the RUNT/SIMIT consult service — a small self-hosted scraper
 * behind VEHICLES_SCRAPER_URL, authenticated with a workspace-wide key sent as
 * `x-api-key` (a workspace-wide "service account" credential, not per-user).
 *
 * THIS NEVER THROWS, and the reason matters. Neither
 * RUNT nor SIMIT is an API: both are public government sites driven through a
 * headless browser and an OCR captcha. A captcha that will not solve, a site
 * that is down for maintenance and a plate the registry has never heard of are
 * ordinary operating conditions, not bugs. A thrown error would abort the whole
 * Cortex turn; a soft failure lets each tool return `{ configured, reason }`
 * and lets Cortex say a plain sentence about what happened.
 */

/** Document types RUNT accepts for the owner. */
export type DocType = 'CC' | 'CE' | 'NIT' | 'PA';

/** Soft failure: never thrown, always returned. `reason` is user-facing prose. */
export interface VehiclesFailure {
  ok: false;
  configured: boolean;
  reason: string;
}

export type VehiclesResult<T> = { ok: true; data: T } | VehiclesFailure;

export const NOT_CONFIGURED_REASON =
  'The vehicle lookup service is not connected in this workspace, so I cannot check RUNT or SIMIT right now. Someone on the ops team needs to point Cortex at it first. I can still keep track of the vehicles themselves in the meantime.';

/** RUNT's answer, as the consult service normalizes it. */
export interface RuntResult {
  source: 'RUNT';
  plate: string;
  consultedAt: string;
  estado: string | null;
  soatVigenteHasta: string | null;
  rtmVigenteHasta: string | null;
  marca: string | null;
  linea: string | null;
  /** Full RUNT vehicle payload — clase, color, cilindraje, chasis, VIN, … */
  info: Record<string, unknown> | null;
}

export interface RawFine {
  code: string;
  description: string;
  amountCop: number;
  issuedAt: string;
  status: 'PENDING' | 'PAID' | 'DISPUTED';
  location?: string;
  secretaria?: string;
  comparendo?: string;
}

/** SIMIT's answer, as the consult service normalizes it. */
export interface SimitResult {
  source: 'SIMIT';
  plate: string;
  consultedAt: string;
  fines: RawFine[];
  totalPendingCop: number;
}

/**
 * A RUNT consult really does take ~18 seconds: Chromium boot, form fill, OCR
 * captcha, retry. The ceiling is generous enough for two captcha attempts and
 * still low enough that a hung upstream cannot hold a chat turn open forever.
 */
const RUNT_TIMEOUT_MS = 60_000;
/** SIMIT is a plain HTTP scrape with a proof-of-work — far quicker. */
const SIMIT_TIMEOUT_MS = 30_000;

/**
 * The caller's cancellation and our own deadline both have to abort the fetch.
 * `AbortSignal.any` landed in Node 20.3; on anything older the caller's signal
 * alone is honoured rather than losing cancellation to gain a timeout.
 */
function combineSignals(signal: AbortSignal | undefined, ms: number): AbortSignal | undefined {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal;
}

/**
 * The service answers a failure as `{ error, code }`, where `code` is one of
 * NOT_CONFIGURED | CAPTCHA_FAILED | UPSTREAM | NOT_FOUND | TIMEOUT. The code is
 * far more useful than the status, because it distinguishes "the plate does not
 * exist" from "the government site is down" — advice that differs completely.
 */
function describeFailure(status: number, code: string | null, source: string): string {
  if (code === 'NOT_FOUND' || status === 404) {
    return `${source} has no record of that plate. It is usually a typo in the plate, or a vehicle that was never registered nationally.`;
  }
  if (code === 'CAPTCHA_FAILED') {
    return `${source} put up a captcha the lookup service could not read. That happens intermittently — trying again in a minute usually gets through.`;
  }
  if (code === 'TIMEOUT' || status === 504) {
    return `${source} took too long to answer and the lookup gave up. Their site is often slow at the top of the hour; it is worth another try shortly.`;
  }
  if (code === 'NOT_CONFIGURED' || status === 503) {
    return `The lookup service is running but is not set up to reach ${source} yet. Ops needs to finish configuring it.`;
  }
  if (status === 401 || status === 403) {
    return 'The lookup service rejected our key. It has most likely been rotated — ops needs to refresh it before I can check RUNT or SIMIT again.';
  }
  if (status === 400 || status === 422) {
    return `${source} turned that lookup down as invalid. Double-check the plate, and for RUNT the owner's document type and number.`;
  }
  if (status === 429) {
    return 'The lookup service is rate-limiting us right now — too many consults in a short window. Give it a minute and I can try again.';
  }
  return `${source} did not answer (the lookup service reported ${status}). Their site is usually back within a few minutes.`;
}

async function consult<T>(
  ctx: ToolContext,
  path: '/consult/runt' | '/consult/simit',
  body: Record<string, string>,
  source: 'RUNT' | 'SIMIT',
  timeoutMs: number,
): Promise<VehiclesResult<T>> {
  const base = process.env.VEHICLES_SCRAPER_URL;
  const key = process.env.VEHICLES_SCRAPER_API_KEY;
  if (!base || !key) return { ok: false, configured: false, reason: NOT_CONFIGURED_REASON };

  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: combineSignals(ctx.signal, timeoutMs),
    });
  } catch (err) {
    // The body carries a plate and an owner's document number, so only the
    // path travels into the log — never the payload and never the key.
    ctx.logger.warn({ err, path }, 'vehicle consult request failed');
    const aborted =
      (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
    return {
      ok: false,
      configured: true,
      reason: aborted
        ? `The ${source} lookup ran out of time before it finished. These consults are slow by nature — it is worth one more try.`
        : 'I could not reach the vehicle lookup service at all just now. It may be a network blip — worth another try in a moment.',
    };
  }

  if (!res.ok) {
    let code: string | null = null;
    try {
      code = ((await res.json()) as { code?: string })?.code ?? null;
    } catch {
      // A non-JSON error body tells us nothing; the status still does.
    }
    ctx.logger.warn({ status: res.status, path }, 'vehicle consult returned an error');
    return { ok: false, configured: true, reason: describeFailure(res.status, code, source) };
  }

  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return {
      ok: false,
      configured: true,
      reason:
        'The vehicle lookup service answered with something I could not read. Worth trying again in a moment.',
    };
  }
}

/** RUNT demands the owner's document alongside the plate — it is not optional. */
export function consultRunt(
  ctx: ToolContext,
  input: { plate: string; docType: DocType; docNumber: string },
): Promise<VehiclesResult<RuntResult>> {
  return consult(ctx, '/consult/runt', input, 'RUNT', RUNT_TIMEOUT_MS);
}

/** SIMIT is keyed on the plate alone. */
export function consultSimit(
  ctx: ToolContext,
  plate: string,
): Promise<VehiclesResult<SimitResult>> {
  return consult(ctx, '/consult/simit', { plate }, 'SIMIT', SIMIT_TIMEOUT_MS);
}

/** True when both the service URL and its key are present. */
export function scraperConfigured(): boolean {
  return !!(process.env.VEHICLES_SCRAPER_URL && process.env.VEHICLES_SCRAPER_API_KEY);
}
