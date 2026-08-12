import type { Download, Page, Response } from 'playwright';
import type { Config } from './config';
import { describeTarget, isResolved, resolveTarget } from './locators';
import { bodyText, countLandmarks, snapshotPage } from './snapshot';
import type {
  FailureEvidence,
  ReplayRequest,
  ReplayResponse,
  Step,
  StepOutcome,
  StepValue,
} from './types';

/**
 * Replaying a learned errand. No model, no reasoning, no decisions.
 *
 * This file is the whole economic argument of the module and it is worth
 * stating what is NOT in it: there is no provider client, no prompt, no
 * network call to anything but the site itself. A replay is a for-loop over a
 * step list. That is why it takes seconds instead of minutes and costs zero
 * instead of cents, and why it returns the same thing every time.
 *
 * The one non-obvious behaviour is in `resolveTarget`: a step carries several
 * ways to find its element and takes the first that works. Fallbacks fire
 * often on real portals, they are reported as `matchedRank > 0`, and Cortex
 * rewrites the step so the survivor leads next time.
 */

const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** Fill a template's {{holes}} from the run's inputs. */
export function renderTemplate(text: string, inputs: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key: string) =>
    Object.hasOwn(inputs, key) ? (inputs[key] ?? '') : whole,
  );
}

/**
 * The text a step actually types, and the text the audit trail is allowed to
 * see. They are different on purpose, and this is the only place they are both
 * produced -- so there is exactly one line to read to be sure a credential
 * cannot reach a log.
 */
export function resolveValue(
  value: StepValue | undefined,
  inputs: Record<string, string>,
  secrets: Record<string, string>,
): { text: string; preview: string } {
  if (!value) return { text: '', preview: '' };
  if (value.kind === 'secret') {
    // Not a truncation and not a mask of the real thing: a fixed string. A
    // length is a leak, a first character is a bigger one.
    return { text: secrets[value.field] ?? '', preview: '***' };
  }
  const text = value.kind === 'template' ? renderTemplate(value.text, inputs) : value.text;
  return { text, preview: text.length > 80 ? `${text.slice(0, 80)}…` : text };
}

async function performStep(
  page: Page,
  step: Step,
  index: number,
  request: ReplayRequest,
  config: Config,
  output: Record<string, unknown>,
  lastStatus: { code: number | null; failed: boolean },
): Promise<{ matchedTarget: string | null; matchedRank: number | null; preview: string | null }> {
  const stepDeadline = Date.now() + config.stepTimeoutMs;
  const { text, preview } = resolveValue(step.value, request.inputs, request.secrets);

  if (step.action === 'goto') {
    const url = renderTemplate(step.url ?? '', request.inputs);
    let response: Response | null = null;
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.stepTimeoutMs,
      });
      lastStatus.code = response?.status() ?? null;
      lastStatus.failed = false;
    } catch (err) {
      lastStatus.failed = true;
      throw err;
    }
    if (response && response.status() >= 400) {
      throw new Error(`the page answered ${response.status()}`);
    }
    await settle(page, step, stepDeadline);
    return { matchedTarget: null, matchedRank: null, preview: null };
  }

  if (step.action === 'wait_for') {
    await settle(page, step, stepDeadline);
    return { matchedTarget: null, matchedRank: null, preview: null };
  }

  const found = await resolveTarget(page, step.targets, stepDeadline);
  if (!isResolved(found)) {
    throw new StepNotFound(step, found.candidates);
  }
  const { locator, rank, target } = found;
  const remaining = () => Math.max(1_000, stepDeadline - Date.now());

  switch (step.action) {
    case 'click':
      await locator.click({ timeout: remaining() });
      break;
    case 'fill':
      await locator.fill(text, { timeout: remaining() });
      break;
    case 'select':
      // By label first: that is the word the person saw and the word the
      // recording captured. The underlying option value is usually a code the
      // portal made up and changes without telling anybody.
      try {
        await locator.selectOption({ label: text }, { timeout: remaining() });
      } catch {
        await locator.selectOption(text, { timeout: remaining() });
      }
      break;
    case 'check':
      await locator.check({ timeout: remaining() });
      break;
    case 'uncheck':
      await locator.uncheck({ timeout: remaining() });
      break;
    case 'press':
      await locator.press(text || 'Enter', { timeout: remaining() });
      break;
    case 'extract': {
      const captured = (await locator.innerText({ timeout: remaining() })).trim();
      output[step.extractAs ?? `step_${index}`] = captured;
      break;
    }
    case 'download': {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: remaining() }) as Promise<Download>,
        locator.click({ timeout: remaining() }),
      ]);
      output.download = await readDownload(download);
      break;
    }
    default:
      throw new Error(`unknown action ${String(step.action)}`);
  }

  await settle(page, step, stepDeadline);
  return { matchedTarget: describeTarget(target), matchedRank: rank, preview };
}

/**
 * Wait for the step to have landed.
 *
 * `expect` is the honest signal and is used when the step carries one: the text
 * a person would look for to know it worked. Without one, all that is available
 * is the network going quiet, which is a guess -- so it is bounded tightly and
 * a timeout here is not a failure.
 */
async function settle(page: Page, step: Step, deadline: number): Promise<void> {
  if (step.expect) {
    await page
      .getByText(step.expect, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: Math.max(1_000, deadline - Date.now()) });
    return;
  }
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
}

async function readDownload(download: Download): Promise<Record<string, unknown>> {
  const filename = download.suggestedFilename();
  const path = await download.path();
  if (!path) return { filename, sizeBytes: 0, base64: null };
  const { readFile, stat } = await import('node:fs/promises');
  const info = await stat(path);
  if (info.size > MAX_DOWNLOAD_BYTES) {
    // The errand worked; the file is simply too big to post back inline. Said
    // plainly rather than failing the run, because the person asked for a
    // certificate and the certificate exists.
    return { filename, sizeBytes: info.size, base64: null, tooLarge: true };
  }
  const bytes = await readFile(path);
  return { filename, sizeBytes: info.size, base64: bytes.toString('base64') };
}

class StepNotFound extends Error {
  constructor(
    readonly step: Step,
    readonly candidates: { kind: string; value: string; matches: number }[],
  ) {
    super(`could not find "${step.label}" on the page`);
    this.name = 'StepNotFound';
  }
}

export async function replay(
  page: Page,
  request: ReplayRequest,
  config: Config,
): Promise<ReplayResponse> {
  const startedAt = Date.now();
  const runDeadline =
    startedAt + Math.min(request.timeoutMs ?? config.runTimeoutMs, config.runTimeoutMs);
  const steps: StepOutcome[] = [];
  const output: Record<string, unknown> = {};
  const lastStatus: { code: number | null; failed: boolean } = { code: null, failed: false };

  for (let index = 0; index < request.steps.length; index++) {
    const step = request.steps[index];
    if (!step) continue;
    const stepStart = Date.now();

    if (Date.now() > runDeadline) {
      steps.push(
        outcome(step, index, page.url(), null, null, null, false, 0, 'the errand ran out of time'),
      );
      return fail(
        request,
        steps,
        output,
        page,
        index,
        step,
        'the errand ran out of time',
        lastStatus,
        true,
        startedAt,
      );
    }

    try {
      const done = await performStep(page, step, index, request, config, output, lastStatus);
      steps.push(
        outcome(
          step,
          index,
          page.url(),
          done.matchedTarget,
          done.matchedRank,
          done.preview,
          true,
          Date.now() - stepStart,
        ),
      );
    } catch (err) {
      const message = (err as Error).message ?? 'the step failed';
      // An optional step that could not be found is not a failure -- that is
      // what optional means. A cookie banner appears once and never again.
      if (step.optional && err instanceof StepNotFound) {
        steps.push(
          outcome(
            step,
            index,
            page.url(),
            null,
            null,
            null,
            true,
            Date.now() - stepStart,
            'skipped',
          ),
        );
        continue;
      }
      steps.push(
        outcome(step, index, page.url(), null, null, null, false, Date.now() - stepStart, message),
      );
      const timedOut = /timeout|timed out|ran out of time/i.test(message);
      return fail(
        request,
        steps,
        output,
        page,
        index,
        step,
        message,
        lastStatus,
        timedOut,
        startedAt,
        err instanceof StepNotFound ? err.candidates : [],
      );
    }
  }

  return {
    ok: true,
    runId: request.runId,
    durationMs: Date.now() - startedAt,
    steps,
    output,
  };
}

function outcome(
  step: Step,
  index: number,
  url: string,
  matchedTarget: string | null,
  matchedRank: number | null,
  preview: string | null,
  ok: boolean,
  durationMs: number,
  error?: string,
): StepOutcome {
  return {
    index,
    action: step.action,
    label: step.label,
    url,
    matchedTarget,
    matchedRank,
    valuePreview: preview,
    ok,
    durationMs,
    ...(error ? { error } : {}),
  };
}

/**
 * Gather the evidence and hand it back untyped by opinion.
 *
 * This function decides NOTHING about why the run failed. It reports the HTTP
 * status, how many landmarks survived, whatever the page's own error regions
 * say, and how many elements each candidate matched. Cortex reads that and
 * decides -- see `browser/classify.ts`. Keeping the judgement out of the
 * browser is what makes it testable without one, and the judgement is the part
 * that must never be wrong.
 */
async function fail(
  request: ReplayRequest,
  steps: StepOutcome[],
  output: Record<string, unknown>,
  page: Page,
  index: number,
  step: Step,
  error: string,
  lastStatus: { code: number | null; failed: boolean },
  timedOut: boolean,
  startedAt: number,
  candidates: { kind: string; value: string; matches: number }[] = [],
): Promise<ReplayResponse> {
  const snapshot = await snapshotPage(page);
  const present = await countLandmarks(page, step.landmarks);
  const sample = await bodyText(page);

  const evidence: FailureEvidence = {
    url: page.url(),
    pageTitle: snapshot.title,
    httpStatus: lastStatus.code,
    navigationFailed: lastStatus.failed,
    timedOut,
    landmarksExpected: step.landmarks.length,
    landmarksPresent: present,
    alertText: snapshot.alerts.length > 0 ? snapshot.alerts.join(' · ').slice(0, 600) : null,
    bodyTextSample: sample,
    candidates: candidates as FailureEvidence['candidates'],
    // Present but unusable: the element exists on the page and the failure was
    // about acting on it, not finding it.
    visibleButBlocked: candidates.some((c) => c.matches > 0),
  };

  return {
    ok: false,
    runId: request.runId,
    durationMs: Date.now() - startedAt,
    steps,
    output,
    failure: { index, label: step.label, error, evidence, snapshot },
  };
}
