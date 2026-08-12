import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHttpTransport } from '../../packages/agent-tools/src/browser/client';
import { runReasoned } from '../../packages/agent-tools/src/browser/reasoned';
import type { Step } from '../../packages/agent-tools/src/browser/types';
import { startPortal } from './portal';

/**
 * The measurement the whole module is sold on.
 *
 *     pnpm browser:bench
 *
 * Two ways of doing the SAME errand on the SAME site, timed and priced side by
 * side:
 *
 *   aprendido   the saved steps, replayed. No provider client is loaded on this
 *               path at all.
 *   razonado    a model driving the browser: look at the page, choose an
 *               action, act, look again. This is the ordinary shape of a
 *               browser agent and it is not strawmanned -- it gets the same
 *               snapshot, the same semantic locators and the same browser.
 *
 * The portal's own latency is fixed (see portal.ts) and is paid identically by
 * both, so it cancels out and what is left is the difference between the two
 * approaches.
 *
 * It needs a real ANTHROPIC_API_KEY, because a simulated model latency would
 * make the headline number a guess dressed as a measurement. Without one it
 * runs the learned half and says the other half was skipped.
 */

const PORT = 3399;
const TOKEN = 'benchmark-token-not-a-secret';
const REPS = Number(process.env.BENCH_REPS ?? 3);

function steps(portal: string): Step[] {
  return [
    {
      action: 'goto',
      label: 'Abrir la consulta',
      targets: [],
      url: `${portal}/consulta`,
      landmarks: [],
    },
    {
      action: 'fill',
      label: 'Número de placa',
      targets: [
        { kind: 'label', value: 'Número de placa' },
        { kind: 'name', value: 'txtPlaca' },
      ],
      value: { kind: 'template', text: '{{placa}}' },
      landmarks: ['Consulta de vehículos', 'Registro Único Nacional'],
    },
    {
      action: 'click',
      label: 'Consultar',
      targets: [
        { kind: 'role', value: 'button', name: 'Consultar' },
        { kind: 'name', value: 'btnConsultar' },
      ],
      expect: 'Resultado de la consulta',
      landmarks: ['Consulta de vehículos', 'Registro Único Nacional'],
    },
    {
      action: 'extract',
      label: 'Estado del vehículo',
      targets: [{ kind: 'css', value: '#estado' }],
      extractAs: 'estado',
      landmarks: ['Resultado de la consulta'],
    },
  ];
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await delay(500);
  }
  throw new Error('the browser service never became healthy');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

async function main(): Promise<void> {
  const portal = await startPortal();
  console.log(`portal fixture on ${portal.url}`);

  const service = spawn('node', ['services/browser/dist/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), BROWSER_SERVICE_TOKEN: TOKEN, LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  process.env.BROWSER_SERVICE_URL = `http://127.0.0.1:${PORT}`;
  process.env.BROWSER_SERVICE_TOKEN = TOKEN;

  const silent = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    // biome-ignore lint/suspicious/noExplicitAny: standing in for pino's surface
  } as any;

  try {
    await waitForHealth();
    const transport = createHttpTransport(silent);
    const plates = ['ABC123', 'XYZ789', 'QQQ111'];

    // ---------------------------------------------------------------------
    // Learned
    // ---------------------------------------------------------------------
    const learned: number[] = [];
    for (let i = 0; i < REPS; i++) {
      const placa = plates[i % plates.length] as string;
      const started = Date.now();
      const result = await transport.replay({
        runId: `bench-learned-${i}`,
        startUrl: `${portal.url}/consulta`,
        steps: steps(portal.url),
        inputs: { placa },
        secrets: {},
      });
      const elapsed = Date.now() - started;
      if (!result.ok || !result.data.ok) {
        console.error('learned run failed', result.ok ? result.data.failure?.error : result.reason);
        continue;
      }
      learned.push(elapsed);
      console.log(`  aprendido ${placa}: ${elapsed}ms → ${JSON.stringify(result.data.output)}`);
    }

    // ---------------------------------------------------------------------
    // Reasoned
    // ---------------------------------------------------------------------
    const reasoned: { ms: number; usd: number; calls: number }[] = [];
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('\n(no ANTHROPIC_API_KEY — el lado razonado se omite)');
    } else {
      for (let i = 0; i < REPS; i++) {
        const placa = plates[i % plates.length] as string;
        // The provider answers 529 under load often enough that a benchmark
        // without a retry is a benchmark that mostly does not finish. Retrying
        // here rather than inside `runReasoned` keeps the queueing out of the
        // measurement: the timer restarts with the attempt.
        let attempt = 0;
        for (;;) {
          attempt += 1;
          const started = Date.now();
          try {
            const result = await runReasoned({
              goal: `Consultar el estado del vehículo con placa ${placa} y leer el estado que devuelve el portal.`,
              startUrl: `${portal.url}/consulta`,
              inputs: { placa },
              transport,
              logger: silent,
            });
            const elapsed = Date.now() - started;
            reasoned.push({ ms: elapsed, usd: result.spend.costUsd, calls: result.spend.calls });
            console.log(
              `  razonado  ${placa}: ${elapsed}ms · ${result.spend.calls} llamadas · US$${result.spend.costUsd.toFixed(4)} · ${
                result.ok ? 'ok' : `falló: ${result.message}`
              }`,
            );
            break;
          } catch (err) {
            if (attempt >= 4) {
              console.log(
                `  razonado  ${placa}: el proveedor no respondió — ${(err as Error).message}`,
              );
              break;
            }
            await delay(4_000 * attempt);
          }
        }
      }
    }

    // ---------------------------------------------------------------------
    // Repair, priced
    // ---------------------------------------------------------------------
    portal.redesign();
    const brokenStart = Date.now();
    const broken = await transport.replay({
      runId: 'bench-broken',
      startUrl: `${portal.url}/consulta`,
      steps: steps(portal.url),
      inputs: { placa: 'ABC123' },
      secrets: {},
    });
    const brokenMs = Date.now() - brokenStart;

    console.log('\n─────────────────────────────────────────────');
    console.log(`repeticiones: ${REPS}`);
    console.log(`aprendido  mediana ${median(learned)}ms · US$0.0000 · 0 llamadas`);
    if (reasoned.length > 0) {
      console.log(
        `razonado   mediana ${median(reasoned.map((r) => r.ms))}ms · US$${(
          reasoned.reduce((a, r) => a + r.usd, 0) / reasoned.length
        ).toFixed(4)} · ${median(reasoned.map((r) => r.calls))} llamadas`,
      );
      const speedup = median(reasoned.map((r) => r.ms)) / Math.max(1, median(learned));
      console.log(`el aprendido es ${speedup.toFixed(1)}× más rápido y no cuesta nada`);
    }
    const brokenWhere =
      broken.ok && !broken.data.ok
        ? ` (paso ${broken.data.failure?.index}: ${broken.data.failure?.label})`
        : '';
    console.log(
      `\ntras el rediseño del portal, la repetición falla en ${brokenMs}ms sin llamar al modelo${brokenWhere}`,
    );
    if (broken.ok && !broken.data.ok) {
      const evidence = broken.data.failure?.evidence;
      console.log(
        `  evidencia: ${evidence?.landmarksPresent}/${evidence?.landmarksExpected} referencias presentes, ` +
          `candidatos con 0 coincidencias, HTTP ${evidence?.httpStatus}, sin texto de rechazo → site-changed`,
      );
    }
  } finally {
    service.kill('SIGTERM');
    await portal.close();
    await delay(300);
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
