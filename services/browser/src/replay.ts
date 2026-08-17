import type { Download, Page, Response } from 'playwright';
import type { Config } from './config';
import { describeTarget, isResolved, resolveTarget } from './locators';
import { bodyText, countLandmarks, observeTargets, snapshotPage } from './snapshot';
import type {
  FailureEvidence,
  ReplayRequest,
  ReplayResponse,
  Step,
  StepOutcome,
  StepValue,
  Target,
  UploadPayload,
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

/**
 * What a trámite is allowed to bring back.
 *
 * 10MB is the same ceiling `kb-uploads` was created with in migration 0013, and
 * it is deliberately the same number: a file that cannot be stored is a file
 * that should not have been carried across the wire, base64-encoded, through a
 * JSON body, to be thrown away at the other end.
 *
 * The extension list is a floor rather than a fence. A portal that hands out a
 * `.exe` is not doing paperwork, and a step that downloads one is either a
 * misread recording or a page that changed into something else -- in both cases
 * the honest answer is to stop and say so. Content type is not checked instead
 * of the extension because portals lie about it constantly: certificates are
 * served as `application/octet-stream` by half the government stack.
 */
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_DOWNLOAD_EXTENSIONS = [
  'pdf',
  'xml',
  'csv',
  'txt',
  'json',
  'xls',
  'xlsx',
  'doc',
  'docx',
  'zip',
  'png',
  'jpg',
  'jpeg',
];

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
  // A file reference is not text that goes anywhere near a form field; it is
  // read by the `upload` case, which needs it whole. What the audit trail sees
  // is the reference, which names a document and reveals nothing about it.
  if (value.kind === 'file') {
    const from = renderTemplate(value.from, inputs);
    return { text: from, preview: from.slice(0, 80) };
  }
  const text = value.kind === 'template' ? renderTemplate(value.text, inputs) : value.text;
  return { text, preview: text.length > 80 ? `${text.slice(0, 80)}…` : text };
}

/**
 * The run stopped because the trámite said a person has to do this bit.
 *
 * A control-flow signal, not an error, and it is a class of its own so the
 * `catch` in `replay` can tell it apart from a step that genuinely failed — a
 * pause that fell through to `fail()` would be gathering captcha evidence
 * about a page nobody has a problem with.
 */
class PauseRequested extends Error {
  constructor(
    readonly index: number,
    readonly ask: string,
    readonly fills: string | null,
  ) {
    super('the trámite stopped to ask a person');
    this.name = 'PauseRequested';
  }
}

async function performStep(
  page: Page,
  step: Step,
  index: number,
  request: ReplayRequest,
  config: Config,
  output: Record<string, unknown>,
  lastStatus: { code: number | null; failed: boolean },
): Promise<{
  matchedTarget: string | null;
  matchedRank: number | null;
  preview: string | null;
  observedTargets?: Target[];
}> {
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

  // Before any element is looked for: a pause acts on nobody, and resolving a
  // locator for it would be waiting for something that is not there.
  if (step.action === 'pause') {
    throw new PauseRequested(index, step.label, step.extractAs ?? null);
  }

  const found = await resolveTarget(page, step.targets, stepDeadline);
  if (!isResolved(found)) {
    // A KEYSTROKE DOES NOT NEED AN ELEMENT.
    //
    // Every other action here acts ON something and is meaningless without it;
    // `press` acts on whatever has focus, and after a `fill` that is already
    // the field the person was typing in. Requiring a locator turned "press
    // Enter" into "find the search box AGAIN, then press Enter" — a second
    // resolution of an element the previous step just used, which fails the
    // moment the page rearranges itself around what was typed. Autocomplete
    // dropdowns do exactly that, on every search box ever built.
    //
    // So a press with nothing to point at falls back to the keyboard rather
    // than failing the run. If the keystroke truly went nowhere, the next step
    // fails on an element that is not there — which is better evidence anyway.
    if (step.action === 'press') {
      await page.keyboard.press(text || 'Enter');
      await settle(page, step, stepDeadline);
      return { matchedTarget: 'teclado', matchedRank: null, preview };
    }
    throw new StepNotFound(step, found.candidates);
  }
  const { locator, rank, target } = found;
  const remaining = () => Math.max(1_000, stepDeadline - Date.now());

  // Read before acting. A click can navigate, and an element on a page that is
  // gone cannot describe itself -- so the one moment this element is both
  // identified and still there is now.
  const observedTargets = await observeTargets(locator);

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
    case 'upload': {
      const file = fileFor(step, index, request, output);
      await locator.setInputFiles(
        {
          name: file.filename,
          mimeType: file.mimeType,
          buffer: Buffer.from(file.base64, 'base64'),
        },
        { timeout: remaining() },
      );
      break;
    }
    default:
      throw new Error(`unknown action ${String(step.action)}`);
  }

  await settle(page, step, stepDeadline);
  return { matchedTarget: describeTarget(target), matchedRank: rank, preview, observedTargets };
}

/**
 * How long an `expect` may hold the step up before we stop believing it.
 *
 * Short on purpose. It is a wait, not a verdict, and a page that has not shown
 * the expected words in six seconds is either slower than that -- in which case
 * the next step's own resolution loop will keep waiting anyway -- or was never
 * going to show them.
 */
const EXPECT_WAIT_MS = 6_000;

/**
 * Wait for the step to have landed.
 *
 * ---------------------------------------------------------------------------
 * AN UNMET `expect` IS NOT A FAILURE, AND USED TO BE
 * ---------------------------------------------------------------------------
 * `expect` is a caption the model wrote while looking at a PICTURE of the page
 * after the step: "Consulta realizada", "Novedad radicada". When it is right it
 * is the best possible thing to wait for -- far better than the network going
 * quiet, which is a guess about a page rather than a fact about this errand.
 *
 * But it is written from a photograph and it is routinely wrong in one specific,
 * harmless way: the model reports what it SAW, and what it saw includes text
 * that lives in a field's value rather than in the page. Typing a name into an
 * input makes the name visible on screen and adds no text node anywhere, so
 * `getByText` will never find it. `browser:cases` caught this on the first run:
 * a fill step that had worked perfectly sat here for the full step timeout and
 * then reported the whole errand as failed. Twenty wasted seconds, and a
 * verdict of `transient/unknown` on a flow that was fine.
 *
 * So: the action already threw if it could not be performed -- Playwright does
 * not silently fail to click. What `expect` adds is knowing WHEN to move on, and
 * that is all it is now allowed to decide. If the words never arrive we fall
 * back to waiting for the network, exactly as a step with no `expect` does, and
 * the errand continues. A step that genuinely did not take effect still fails,
 * one step later, on the element that is not there -- with better evidence than
 * a missing caption, because "the control I need is absent" is a fact about the
 * page and "the sentence I was promised is absent" is a fact about the model.
 */
async function settle(page: Page, step: Step, deadline: number): Promise<void> {
  if (step.expect) {
    const budget = Math.min(EXPECT_WAIT_MS, Math.max(1_000, deadline - Date.now()));
    const arrived = await page
      .getByText(step.expect, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: budget })
      .then(() => true)
      .catch(() => false);
    if (arrived) return;
  }
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
}

/**
 * The bytes an `upload` step attaches.
 *
 * TWO SOURCES, AND ONLY ONE OF THEM IS RESOLVED HERE.
 *
 * `download` means "the file this same run already fetched", and it is the
 * whole point of a chained trámite: bajar el certificado en el portal A y
 * subirlo en el portal B, without the bytes ever leaving this container, and
 * without Postgres being asked to hold a 6MB PDF in between. It is resolved
 * here because here is the only place those bytes exist.
 *
 * Everything else was resolved by Cortex before the request was sent, keyed by
 * step index — see `ReplayRequest.files`. This service does not know what a
 * document id is, does not have a database, and must not learn.
 *
 * Throws rather than skipping. An `<input type=file>` has no partial success:
 * submitting a form with the attachment missing produces a filing that was
 * accepted and is wrong, which is discovered a week later by whoever rejects
 * it. Failing here fails the step, which is visible now.
 */
function fileFor(
  step: Step,
  index: number,
  request: ReplayRequest,
  output: Record<string, unknown>,
): UploadPayload {
  const from = step.value?.kind === 'file' ? renderTemplate(step.value.from, request.inputs) : '';

  if (from === 'download') {
    const downloaded = output.download as Record<string, unknown> | undefined;
    if (!downloaded) {
      throw new Error('this step attaches the file the trámite downloads, and nothing was downloaded yet');
    }
    if (typeof downloaded.refused === 'string') {
      throw new Error(`the file this step attaches was not brought back: ${downloaded.refused}`);
    }
    const base64 = typeof downloaded.base64 === 'string' ? downloaded.base64 : '';
    if (!base64) throw new Error('the file this step attaches came back empty');
    return {
      filename: typeof downloaded.filename === 'string' ? downloaded.filename : 'archivo',
      mimeType:
        typeof downloaded.mimeType === 'string' ? downloaded.mimeType : 'application/octet-stream',
      base64,
    };
  }

  const supplied = request.files?.[String(index)];
  if (!supplied || !supplied.base64) {
    throw new Error(`no file was supplied for "${step.label}"`);
  }
  return supplied;
}

/** Guessed from the name, because portals routinely lie in the header. */
function mimeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const known: Record<string, string> = {
    pdf: 'application/pdf',
    xml: 'application/xml',
    csv: 'text/csv',
    txt: 'text/plain',
    json: 'application/json',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    zip: 'application/zip',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
  };
  return known[ext] ?? 'application/octet-stream';
}

/**
 * The file the errand went to fetch.
 *
 * A refusal here is a plain sentence rather than a stack trace, and it is
 * returned rather than thrown for the same reason the rest of this module
 * returns failures: a portal that hands out a 400MB archive is an operating
 * condition, not a bug, and the person asking for a certificate needs to be
 * told what happened in a language that suggests what to do next.
 */
async function readDownload(download: Download): Promise<Record<string, unknown>> {
  const filename = download.suggestedFilename();
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  const path = await download.path();
  if (!path) {
    return { filename, sizeBytes: 0, base64: null, refused: 'el portal no entregó el archivo' };
  }

  if (!ALLOWED_DOWNLOAD_EXTENSIONS.includes(extension)) {
    await download.delete().catch(() => undefined);
    return {
      filename,
      sizeBytes: 0,
      base64: null,
      refused: `el portal entregó un archivo «.${extension || 'sin extensión'}», que no es de los tipos que un trámite puede traer (${ALLOWED_DOWNLOAD_EXTENSIONS.join(', ')})`,
    };
  }

  const { readFile, stat } = await import('node:fs/promises');
  const info = await stat(path);
  if (info.size > MAX_DOWNLOAD_BYTES) {
    await download.delete().catch(() => undefined);
    // The errand worked; the file is simply too big to carry back inline. Said
    // plainly rather than failing the run, because the person asked for a
    // certificate and the certificate exists.
    return {
      filename,
      sizeBytes: info.size,
      base64: null,
      tooLarge: true,
      refused: `el archivo pesa ${Math.round(info.size / (1024 * 1024))} MB y el límite son ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB`,
    };
  }
  const bytes = await readFile(path);
  return {
    filename,
    mimeType: mimeFor(filename),
    sizeBytes: info.size,
    base64: bytes.toString('base64'),
  };
}

/**
 * Widgets that exist only to ask whether we are a person.
 *
 * Counted by frame source rather than by anything visual, because that is the
 * part these three products cannot vary: reCAPTCHA, hCaptcha and Turnstile all
 * mount an iframe from their own domain, whatever the host page calls it or
 * however it is skinned. A `#captcha` div would also catch a portal's own
 * home-made image-and-textbox challenge, which is deliberately NOT what this
 * counts -- those are ordinary form fields a recorded flow can and should fill.
 *
 * Never throws. A page that will not answer a query about its frames is a page
 * we are already failing on, and losing the whole evidence bundle over a count
 * would be trading the diagnosis for one of its lines.
 */
async function countChallengeFrames(page: Page): Promise<number> {
  try {
    return await page
      .locator(
        [
          'iframe[src*="recaptcha"]',
          'iframe[src*="hcaptcha"]',
          'iframe[src*="challenges.cloudflare.com"]',
          'iframe[title*="captcha" i]',
        ].join(', '),
      )
      .count();
  } catch {
    return 0;
  }
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
          undefined,
          done.observedTargets,
        ),
      );
    } catch (err) {
      // THE TRÁMITE ASKED FOR A PERSON. Not a failure, and returned before
      // anything gathers evidence about a page that has nothing wrong with it.
      //
      // `fromIndex` is the NEXT step: the pause itself has done its job by
      // being reached, and replaying it on resume would stop the run again on
      // the answer it just received.
      if (err instanceof PauseRequested) {
        steps.push(
          outcome(step, index, page.url(), null, null, null, true, Date.now() - stepStart, 'paused'),
        );
        return {
          ok: false,
          runId: request.runId,
          durationMs: Date.now() - startedAt,
          steps,
          output,
          pause: { index: err.index, ask: err.ask, fills: err.fills },
        };
      }

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
  observedTargets?: Target[],
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
    ...(observedTargets && observedTargets.length > 0 ? { observedTargets } : {}),
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
  const challengeFrames = await countChallengeFrames(page);

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
    challengeFrames,
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
