import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { TeachingRecorder } from '../src/teaching';
import { resolveTarget, isResolved } from '../src/locators';
import { snapshotPage } from '../src/snapshot';
import { BrowserWorker } from '../src/browser';
import type { Config } from '../src/config';

const config: Config = {
  serviceToken: 'test',
  port: 0,
  runTimeoutMs: 10000,
  stepTimeoutMs: 1000,
  sessionIdleMs: 60000,
  maxConcurrent: 4,
  viewportWidth: 1000,
  viewportHeight: 700,
  userAgent: null,
  profilesDir: null,
  maxProfiles: 3,
};
async function portal() {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url?.startsWith('/frame'))
      res.end(
        '<label>Documento <input name="documento"></label><label>Clave <input name="password" type="password"></label><button>Continuar</button>',
      );
    else
      res.end(
        '<h1>Portal de pruebas</h1><button>Continuar</button><iframe name="tramite" src="http://localhost:' +
          (server.address() as { port: number }).port +
          '/frame?session=private"></iframe>',
      );
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('records trusted iframe gestures, replaces typed values and respects frame identity', async () => {
  const site = await portal();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(site.url);
    const recorder = new TeachingRecorder(page);
    await recorder.start();
    const frame = page.frame({ name: 'tramite' })!;
    await frame.getByLabel('Documento').fill('900123456-secret-sample');
    await frame.getByLabel('Clave').fill('never-store-this-password');
    await frame.getByRole('button', { name: 'Continuar' }).click();
    await page.waitForTimeout(100);
    const lesson = await recorder.stop();
    assert.deepEqual(
      lesson.steps.map((s) => s.action),
      ['goto', 'fill', 'pause', 'click'],
    );
    assert.equal(lesson.variables.length, 1);
    assert(!JSON.stringify(lesson).includes('900123456'));
    assert(!JSON.stringify(lesson).includes('never-store'));
    assert(!JSON.stringify(lesson).includes('session=private'));
    const targets = lesson.steps.at(-1)!.targets;
    const resolved = await resolveTarget(page, targets, Date.now() + 100);
    assert(isResolved(resolved));
    assert.equal(
      await resolved.locator.evaluate((el) => new URL(el.ownerDocument.URL).pathname),
      '/frame',
    );
    const snap = await snapshotPage(page);
    assert(
      snap.elements.some((el) => el.targets.some((t) => t.framePath?.[0]?.name === 'tramite')),
    );
    assert.equal(new Set(snap.elements.map((el) => el.ref)).size, snap.elements.length);
    await frame.goto(site.url + 'other');
    const missing = await resolveTarget(page, targets, Date.now());
    assert(
      !isResolved(missing),
      'must not click the same label in the main page when the learned frame is gone',
    );
    await page.getByRole('button', { name: 'Continuar' }).click();
    assert.equal(
      recorder.state().steps.length,
      lesson.steps.length,
      'stopped recording stays stopped',
    );
  } finally {
    await browser.close();
    await site.close();
  }
});

test('profiles isolate storage and sessions, persist after close, fence revocation, and survive repeated pauses', async () => {
  process.env.BROWSER_ALLOW_PRIVATE_HOSTS = 'true';
  const root = await mkdtemp(join(tmpdir(), 'cortex-profile-test-'));
  const site = await portal();
  const worker = new BrowserWorker({ ...config, profilesDir: root });
  const a = { key: 'profile-11111111-1111-4111-a111-111111111111', revision: 1 };
  const b = { key: 'profile-22222222-2222-4222-a222-222222222222', revision: 1 };
  try {
    const opened = await worker.openSession(site.url, 'alice', a);
    await assert.rejects(worker.readSession(opened.sessionId, 'bob'));
    await assert.rejects(worker.readSession(opened.sessionId));
    await assert.rejects(worker.openSession(site.url, 'bob', a), /busy|capacity|ocup|full/i);
    // Test fixture accesses the page only to plant and inspect session storage.
    const sessions = (
      worker as unknown as { sessions: Map<string, { page: import('playwright').Page }> }
    ).sessions;
    await sessions
      .get(opened.sessionId)!
      .page.context()
      .addCookies([
        {
          name: 'login',
          value: 'alice',
          url: site.url,
          expires: Math.floor(Date.now() / 1000) + 3600,
        },
      ]);
    const other = await worker.openSession(site.url, 'bob', b);
    assert(
      !(await sessions.get(other.sessionId)!.page.context().cookies()).some(
        (c) => c.name === 'login',
      ),
    );
    await worker.closeSession(other.sessionId);
    await worker.closeSession(opened.sessionId);
    const reopened = await worker.openSession(site.url, 'alice', a);
    assert(
      (await sessions.get(reopened.sessionId)!.page.context().cookies()).some(
        (c) => c.name === 'login' && c.value === 'alice',
      ),
    );
    await worker.revokeProfile(a.key, 2);
    await assert.rejects(worker.readSession(reopened.sessionId, 'alice'));
    await assert.rejects(worker.openSession(site.url, 'alice', a));
    const shared = await worker.openSession(site.url, 'bob', { ...a, revision: 2 });
    assert(
      (await sessions.get(shared.sessionId)!.page.context().cookies()).some(
        (c) => c.name === 'login',
      ),
    );
    await worker.closeSession(shared.sessionId);
    const replay = await worker.runReplay({
      runId: 'test',
      startUrl: site.url,
      profile: { ...a, revision: 2 },
      owner: 'alice',
      inputs: {},
      secrets: {},
      steps: [
        { action: 'pause', label: 'Primera pausa', targets: [], landmarks: [] },
        { action: 'pause', label: 'Segunda pausa', targets: [], landmarks: [] },
      ],
    });
    assert(replay.handoff);
    await assert.rejects(worker.continueSession(replay.handoff.sessionId, 1, {}, 'bob'));
    const resumed = await worker.continueSession(replay.handoff.sessionId, 1, {}, 'alice');
    assert(resumed.handoff);
    await assert.rejects(worker.readSession(resumed.handoff.sessionId, 'bob'));
    await worker.continueSession(resumed.handoff.sessionId, 2, {}, 'alice');
    const final = await worker.openSession(site.url, 'alice', { ...a, revision: 2 });
    assert(
      (await sessions.get(final.sessionId)!.page.context().cookies()).some(
        (c) => c.name === 'login',
      ),
    );
  } finally {
    await worker.stop();
    await site.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.BROWSER_ALLOW_PRIVATE_HOSTS;
  }
});

test('one lesson spans multiple pages and retains explanations without clipboard values', async () => {
  const site = await portal();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(site.url + 'frame');
    const teacher = new TeachingRecorder(page);
    await teacher.start();
    await page.getByLabel('Documento').fill('source-private-value');
    await page.waitForTimeout(50);
    teacher.explain(1, 'Tomar el NIT de la columna B de la hoja Clientes; usarlo en la DIAN.');
    await teacher.navigate(site.url.replace('127.0.0.1', 'localhost') + 'frame');
    await page.getByLabel('Documento').fill('destination-private-value');
    await page.waitForTimeout(50);
    const lesson = await teacher.stop();
    assert.deepEqual(
      lesson.steps.map((s) => s.action),
      ['goto', 'fill', 'goto', 'fill'],
    );
    assert.equal(
      lesson.variables.length,
      2,
      'similar fields on separate pages are separate inputs',
    );
    assert.match(lesson.steps[1]!.explanation!, /columna B/);
    assert.equal(new URL(lesson.steps[2]!.url!).hostname, 'localhost');
    assert(!JSON.stringify(lesson).includes('private-value'));
    assert.throws(() => teacher.explain(1, 'after recording'));
  } finally {
    await browser.close();
    await site.close();
  }
});
