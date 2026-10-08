import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';
import type { Config } from '../src/config';
import { replay } from '../src/replay';
import { TeachingRecorder, resultName } from '../src/teaching';
import type { ReplayRequest, Step } from '../src/types';

const config: Config = {
  serviceToken: 'test',
  port: 0,
  runTimeoutMs: 30000,
  stepTimeoutMs: 1500,
  sessionIdleMs: 60000,
  maxConcurrent: 4,
  viewportWidth: 1000,
  viewportHeight: 700,
  userAgent: null,
  profilesDir: null,
  maxProfiles: 3,
};

/** Un portal de consulta: /guia/<n> muestra «Estado» y su valor; /guia/0 no pinta nada. */
async function portal() {
  let clicks = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const path = req.url ?? '/';
    if (path.startsWith('/guia/0')) res.end('<h1>Consulta</h1><p>No existe esa guía.</p>');
    else if (path.startsWith('/guia/'))
      res.end(
        `<h1>Consulta</h1><table><tr><th>Guía</th><td>${path.slice(6)}</td></tr><tr><th>Estado:</th><td><span>${path.endsWith('2') ? 'En tránsito' : 'Entregado'}</span></td></tr></table><button id="b">Reclamar</button><script>document.getElementById('b').onclick=()=>fetch('/clic')</script>`,
      );
    else if (path === '/clic') {
      clicks += 1;
      res.end('ok');
    } else res.end('<h1>Inicio</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    base,
    clicks: () => clicks,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** La marca llega por un binding asíncrono: se espera a que el servicio la haya comprobado. */
async function marked(recorder: TeachingRecorder) {
  for (let i = 0; i < 100; i++) {
    if (recorder.state().pendingMark) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const request = (startUrl: string, steps: Step[]): ReplayRequest => ({
  runId: 'r1',
  startUrl,
  steps,
  inputs: {},
  secrets: {},
});

test('resultName normaliza a minúsculas sin tildes', () => {
  assert.equal(resultName('Estado de la Guía'), 'estado_de_la_guia');
  assert.equal(resultName('  ¡¡ '), '');
});

test('señalar resultado graba un paso extract que sobrevive a otro valor y respeta el valor por defecto', async () => {
  const site = await portal();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${site.base}/guia/1`);
    const recorder = new TeachingRecorder(page);
    await recorder.start();

    // Señalar: el clic NO actúa sobre el portal (el botón no se dispara).
    await recorder.markStart();
    await page.getByRole('button', { name: 'Reclamar' }).click();
    await page.waitForTimeout(150);
    await marked(recorder);
    assert.equal(site.clicks(), 0, 'en modo señalar los clics no llegan al portal');
    await recorder.markStart();
    await page.getByText('Entregado').click();
    await marked(recorder);

    let state = recorder.state();
    assert.equal(state.marking, true);
    assert.ok(state.pendingMark?.ok, state.pendingMark?.problem ?? 'sin marca');
    assert.equal(state.pendingMark?.sample, 'Entregado');
    assert.equal(state.pendingMark?.suggestedName, 'estado');

    // Un nombre repetido o reservado se rechaza.
    await assert.rejects(recorder.markCommit('download'), /reservado/);

    state = await recorder.markCommit('Estado guía', 'no encontrado');
    assert.equal(state.marking, false);
    const step = state.steps.at(-1);
    assert.equal(step?.action, 'extract');
    assert.equal(step?.extractAs, 'estado_guia');
    assert.equal(step?.extractDefault, 'no encontrado');
    // Ningún valor del portal queda grabado en el paso.
    assert.ok(!JSON.stringify(step).includes('Entregado'));
    // Prefiere el rótulo vecino a una ruta CSS frágil.
    assert.match(step?.targets[0]?.value ?? '', /^text=\/.*Estado.*following-sibling/);
    await assert.rejects(
      (async () => {
        await recorder.markStart();
        await page.getByText('Entregado').click();
        await marked(recorder);
        await recorder.markCommit('estado_guia');
      })(),
      /Ya hay un resultado/,
    );
    await recorder.markCancel();

    // Replay: otra guía devuelve SU estado; una que no pinta nada, el valor por defecto.
    const extract = step as Step;
    const withValue = await replay(
      page,
      request(`${site.base}/guia/2`, [
        { action: 'goto', label: 'Abrir', url: `${site.base}/guia/2`, targets: [], landmarks: [] },
        extract,
      ]),
      config,
    );
    assert.equal(withValue.ok, true, JSON.stringify(withValue.failure));
    assert.equal(withValue.output.estado_guia, 'En tránsito');

    const started = Date.now();
    const absent = await replay(
      page,
      request(`${site.base}/guia/0`, [
        { action: 'goto', label: 'Abrir', url: `${site.base}/guia/0`, targets: [], landmarks: [] },
        extract,
      ]),
      config,
    );
    assert.equal(absent.ok, true, JSON.stringify(absent.failure));
    assert.equal(absent.output.estado_guia, 'no encontrado');
    assert.ok(Date.now() - started < 15000);

    // Sin valor por defecto, que no aparezca SÍ falla (como siempre).
    const { extractDefault: _drop, ...bare } = extract;
    const failing = await replay(
      page,
      request(`${site.base}/guia/0`, [
        { action: 'goto', label: 'Abrir', url: `${site.base}/guia/0`, targets: [], landmarks: [] },
        bare as Step,
      ]),
      config,
    );
    assert.equal(failing.ok, false);
  } finally {
    await browser.close();
    await site.close();
  }
});

test('señalar un campo o un lugar sin texto no deja guardar el resultado', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<input id="q" aria-label="Guía"><div id="vacio" style="height:60px"></div>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.goto(base);
    const recorder = new TeachingRecorder(page);
    await recorder.start();
    await recorder.markStart();
    await page.locator('#q').click();
    await page.waitForTimeout(150);
    assert.equal(recorder.state().pendingMark?.ok, false);
    await assert.rejects(recorder.markCommit('algo'), /campo/);
    assert.equal(recorder.state().steps.length, 1);
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
