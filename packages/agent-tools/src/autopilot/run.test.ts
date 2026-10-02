import { ConfirmationRequiredError } from '@cortex/core';
import { describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_DAY,
  FIXTURE_NOW,
  OWNER_ID,
  fixtureSettings,
  fixtureSnapshot,
  fixtureTool,
} from './autopilot.fixtures';
import { EMPTY_HISTORY } from './plan';
import {
  type ExecOutcome,
  type ItemPatch,
  type RunDeps,
  type SavedItem,
  idempotencyScopeFor,
  ownerMessage,
  planToday,
  runAutopilot,
} from './run';
import type { AutopilotSettings } from './settings';
import type { AutopilotRunStatus, DecidedItem } from './types';

/**
 * LA CORRIDA, CON UNA BASE DE MENTIRA Y UN `runTool` DE MENTIRA.
 *
 * Lo que se prueba es el orden y las garantías, no las herramientas: una
 * corrida por día, idempotencia por día y clave, el interruptor, que un fallo
 * no bloquee a los demás, un solo aviso al dueño, y que el ensayo sea el plan
 * real menos la ejecución.
 */

interface FakeWorld {
  settings: AutopilotSettings[];
  runs: Map<string, { id: string; status: AutopilotRunStatus }>;
  items: Map<string, { id: string; runId: string; item: DecidedItem; patch: ItemPatch | null }>;
  executed: Array<{ key: string; scope: string }>;
  proposed: string[];
  notified: string[];
  finished: Array<{ status: AutopilotRunStatus; message: string }>;
}

function world(
  opts: {
    settings?: Partial<AutopilotSettings>;
    /** Configuración que se lee en cada lectura sucesiva (el interruptor). */
    sequence?: Array<Partial<AutopilotSettings>>;
    execute?: (item: DecidedItem) => Promise<ExecOutcome>;
    actorAllowed?: boolean;
    clock?: () => Date;
  } = {},
) {
  const w: FakeWorld = {
    settings: [],
    runs: new Map(),
    items: new Map(),
    executed: [],
    proposed: [],
    notified: [],
    finished: [],
  };
  let reads = 0;
  let ids = 0;
  const deps: RunDeps = {
    day: FIXTURE_DAY,
    now: opts.clock ?? (() => FIXTURE_NOW),
    readSettings: async () => {
      const seq = opts.sequence;
      const over = seq ? (seq[Math.min(reads, seq.length - 1)] ?? {}) : (opts.settings ?? {});
      reads += 1;
      const s = fixtureSettings(over);
      w.settings.push(s);
      return s;
    },
    actorAllowed: async () => opts.actorAllowed ?? true,
    loadSnapshot: async () => ({ snapshot: fixtureSnapshot(), errors: [] }),
    loadHistory: async () => EMPTY_HISTORY,
    loadMandates: async () => [],
    tool: fixtureTool,
    claimRun: async ({ day }) => {
      const existing = w.runs.get(day);
      if (existing) return { runId: existing.id, fresh: false, status: existing.status };
      const run = { id: `run-${day}`, status: 'running' as AutopilotRunStatus };
      w.runs.set(day, run);
      return { runId: run.id, fresh: true, status: run.status };
    },
    saveItems: async (runId, items) => {
      for (const item of items) {
        const key = `${runId}|${item.dedupeKey}`;
        if (!w.items.has(key)) w.items.set(key, { id: `i${++ids}`, runId, item, patch: null });
      }
      return [...w.items.values()]
        .filter((r) => r.runId === runId)
        .map((r) => ({
          id: r.id,
          dedupeKey: r.item.dedupeKey,
          status: r.patch?.status ?? 'planned',
        }));
    },
    loadItems: async (runId) =>
      [...w.items.values()]
        .filter((r) => r.runId === runId)
        .map((r) => ({
          id: r.id,
          dedupeKey: r.item.dedupeKey,
          status: r.patch?.status ?? 'planned',
          item: r.item,
        })) as Array<SavedItem & { item: DecidedItem }>,
    updateItem: async (id, patch) => {
      for (const r of w.items.values()) if (r.id === id) r.patch = { ...r.patch, ...patch };
    },
    execute: async (item, { idempotencyScope }) => {
      w.executed.push({ key: item.dedupeKey, scope: idempotencyScope });
      if (opts.execute) return opts.execute(item);
      return { status: 'done', summary: 'Hecho.', verification: 'verified' };
    },
    proposeMessage: async (item) => {
      w.proposed.push(item.dedupeKey);
      return 'action-1';
    },
    finishRun: async (runId, summary, status) => {
      for (const r of w.runs.values()) if (r.id === runId) r.status = status;
      w.finished.push({ status, message: summary.message });
    },
    notifyOwner: async (summary) => {
      w.notified.push(summary.message);
    },
  };
  return { w, deps };
}

const statuses = (w: FakeWorld) =>
  [...w.items.values()].map((r) => r.patch?.status ?? 'planned').sort();

describe('la corrida del piloto', () => {
  it('hace lo de «hacer», propone el correo en la cola de aprobaciones y avisa UNA vez', async () => {
    const { w, deps } = world();
    const r = await runAutopilot(deps);
    expect(r.ran).toBe(true);
    if (!r.ran) return;
    expect(r.summary.done).toBe(4);
    expect(r.summary.asked).toBe(2);
    expect(w.executed).toHaveLength(4);
    // El correo al cliente: a la cola de aprobaciones, no ejecutado.
    expect(w.proposed).toEqual(['cobro:document:aaaaaaaa-0000-4000-8000-000000000001:30']);
    expect(w.executed.some((e) => e.key.startsWith('cobro:'))).toBe(false);
    expect(w.notified).toEqual(['Hoy hice 4 cosas; necesito tu decisión en 2.']);
    expect(w.finished).toEqual([
      { status: 'done', message: 'Hoy hice 4 cosas; necesito tu decisión en 2.' },
    ]);
    expect(r.summary.actorUserId).toBe(OWNER_ID);
  });

  it('cada acción lleva el alcance de idempotencia del día y la cosa', async () => {
    const { w, deps } = world();
    await runAutopilot(deps);
    for (const e of w.executed) expect(e.scope).toBe(idempotencyScopeFor(FIXTURE_DAY, e.key));
    expect(idempotencyScopeFor(FIXTURE_DAY, 'x')).toBe('autopilot:2026-10-06:x');
  });

  it('una corrida por día: la segunda vez no hace nada', async () => {
    const { w, deps } = world();
    await runAutopilot(deps);
    const again = await runAutopilot(deps);
    expect(again).toEqual({ ran: false, reason: 'El piloto ya corrió hoy.' });
    expect(w.executed).toHaveLength(4);
    expect(w.notified).toHaveLength(1);
  });

  it('un reintento retoma la misma corrida y sólo ejecuta lo que quedó en cola', async () => {
    let calls = 0;
    const { w, deps } = world({
      execute: async () => {
        calls += 1;
        if (calls === 2) throw new Error('se cayó el proceso a mitad');
        return { status: 'done', summary: 'Hecho.', verification: null };
      },
    });
    // Primera vuelta: la segunda acción falla (queda «failed», no «planned»).
    await runAutopilot(deps);
    expect(statuses(w).filter((s) => s === 'failed')).toHaveLength(1);
    // Simular que el trabajo murió con una acción en cola: devolverla a planned
    // y la corrida a running.
    const pending = [...w.items.values()].find((r) => r.patch?.status === 'done');
    if (pending) pending.patch = null;
    const run = w.runs.get(FIXTURE_DAY);
    if (run) run.status = 'running';
    const before = w.executed.length;
    const r = await runAutopilot(deps);
    expect(r.ran).toBe(true);
    expect(w.executed.length - before).toBe(1);
  });

  it('un fallo no bloquea a los demás', async () => {
    const { w, deps } = world({
      execute: async (item) => {
        if (item.area === 'finanzas') throw new Error('el modelo no contestó');
        return { status: 'done', summary: 'Hecho.', verification: 'unverifiable' };
      },
    });
    const r = await runAutopilot(deps);
    if (!r.ran) throw new Error('no corrió');
    expect(r.summary.failed).toBe(1);
    expect(r.summary.done).toBe(3);
    expect(w.notified[0]).toBe('Hoy hice 3 cosas; necesito tu decisión en 2. (1 no salió.)');
    const failed = [...w.items.values()].find((x) => x.patch?.status === 'failed');
    expect(failed?.patch?.error).toBe('el modelo no contestó');
  });

  it('si la capa de seguridad pide confirmación, la cosa pasa a «espera tu decisión»', async () => {
    const { deps } = world({
      execute: async (item) => {
        if (item.area === 'procesos')
          throw new ConfirmationRequiredError('trackers.retry_sync', {});
        return { status: 'done', summary: 'Hecho.', verification: null };
      },
    });
    const r = await runAutopilot(deps);
    if (!r.ran) throw new Error('no corrió');
    expect(r.summary.asked).toBe(3);
    expect(r.summary.done).toBe(3);
  });

  it('EL INTERRUPTOR: apagarlo a mitad detiene lo que falta en ese instante', async () => {
    // Lectura 1 (la puerta) y 2 (antes de la 1.ª acción): encendido. Después, apagado.
    const { w, deps } = world({ sequence: [{}, {}, { enabled: false }] });
    const r = await runAutopilot(deps);
    if (!r.ran) throw new Error('no corrió');
    expect(w.executed).toHaveLength(1);
    expect(r.summary.skipped).toBe(3);
    expect(r.summary.stopped).toBe(true);
    expect(w.finished[0]?.status).toBe('stopped');
    expect(w.notified[0]).toContain('me detuve porque apagaste el piloto');
  });

  it('apagado, día quieto o actor sin autoridad: no corre, no reclama, no avisa', async () => {
    for (const opts of [
      { settings: { enabled: false } },
      { settings: { quietDays: [FIXTURE_DAY] } },
      { actorAllowed: false },
      { settings: { actorUserId: null } },
    ]) {
      const { w, deps } = world(opts);
      const r = await runAutopilot(deps);
      expect(r.ran).toBe(false);
      expect(w.runs.size).toBe(0);
      expect(w.notified).toEqual([]);
    }
  });

  it('el techo de tiempo: lo que no alcanza queda omitido', async () => {
    let t = FIXTURE_NOW.getTime();
    const tick = () => {
      t += 60_000;
      return new Date(t);
    };
    const { w, deps } = world({ clock: tick });
    deps.timeBudgetMs = 150_000;
    const r = await runAutopilot(deps);
    if (!r.ran) throw new Error('no corrió');
    expect(r.summary.skipped).toBeGreaterThan(0);
    expect(w.executed.length + r.summary.skipped).toBe(4);
  });

  it('un aviso al dueño que falla no tumba la corrida', async () => {
    const { deps } = world();
    deps.notifyOwner = vi.fn(async () => {
      throw new Error('sin correo');
    });
    const r = await runAutopilot(deps);
    expect(r.ran).toBe(true);
  });

  it('el ensayo es el plan real menos la ejecución', async () => {
    const { w, deps } = world();
    const dry = await planToday(deps);
    expect(w.executed).toEqual([]);
    expect(w.runs.size).toBe(0);
    const real = await runAutopilot(deps);
    if (!real.ran || !real.plan) throw new Error('no corrió');
    const shape = (items: DecidedItem[]) =>
      items.map((i) => `${i.dedupeKey}|${i.decision}|${i.decisionReason}`).sort();
    expect(shape(dry.items)).toEqual(shape(real.plan.items));
    expect(w.executed.map((e) => e.key).sort()).toEqual(
      dry.items
        .filter((i) => i.decision === 'do')
        .map((i) => i.dedupeKey)
        .sort(),
    );
  });
});

describe('el mensaje al dueño', () => {
  it('dice lo hecho y lo que espera, en una frase', () => {
    expect(ownerMessage({ done: 6, asked: 3, failed: 0, stillWaiting: 0 })).toBe(
      'Hoy hice 6 cosas; necesito tu decisión en 3.',
    );
    expect(ownerMessage({ done: 1, asked: 0, failed: 0, stillWaiting: 0 })).toBe(
      'Hoy hice 1 cosa; no necesito ninguna decisión tuya.',
    );
    expect(ownerMessage({ done: 0, asked: 1, failed: 0, stillWaiting: 2 })).toBe(
      'Hoy no hice nada por mi cuenta; necesito tu decisión en 3.',
    );
    expect(ownerMessage({ done: 2, asked: 0, failed: 2, stillWaiting: 0 })).toBe(
      'Hoy hice 2 cosas; no necesito ninguna decisión tuya. (2 no salieron.)',
    );
  });
});
