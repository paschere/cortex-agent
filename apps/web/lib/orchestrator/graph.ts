import type { TaskStatus } from './types';

/**
 * The plan graph and the scheduling primitives that walk it.
 *
 * Pure, dependency-free and shared by both sides of the wire: the executor uses
 * it to decide what runs next, and the live console uses `computeWaves` to draw
 * which sub-agents are running side by side.
 */

export interface GraphNode {
  /** 1-based position in the plan. */
  seq: number;
  dependsOn: number[];
}

/**
 * Rewrites the planner's dependency lists into a guaranteed DAG.
 *
 * A task may only depend on tasks that come BEFORE it. That single rule kills
 * three failure modes at once, for free: seq numbers that do not exist,
 * self-references, and cycles — each of which would otherwise leave the
 * executor spinning on a batch that never becomes ready. Dropping a forward
 * edge is a far cheaper bug than a run that hangs forever, and the planner is
 * told the rule in its prompt anyway, so this normally changes nothing.
 *
 * @param dependsOn one entry per task, in plan order (index 0 is seq 1).
 */
export function normalizeDependencies(dependsOn: number[][]): number[][] {
  return dependsOn.map((deps, index) => {
    const seq = index + 1;
    const clean = new Set((deps ?? []).filter((d) => Number.isInteger(d) && d >= 1 && d < seq));
    return [...clean].sort((a, b) => a - b);
  });
}

/**
 * Depth of each task in the graph, 1-based.
 *
 * Everything sharing a wave has no dependency on anything else in that wave, so
 * a wave is exactly the set the executor is allowed to run in parallel — which
 * is what makes it the right unit to draw in the console.
 *
 * Backward-only edges (see `normalizeDependencies`) mean a single ascending
 * pass settles every depth; no fixpoint loop needed.
 */
export function computeWaves(nodes: GraphNode[]): Map<number, number> {
  const known = new Set(nodes.map((n) => n.seq));
  const wave = new Map<number, number>();
  for (const node of [...nodes].sort((a, b) => a.seq - b.seq)) {
    const deps = node.dependsOn.filter((d) => known.has(d));
    const depth = deps.length === 0 ? 1 : Math.max(...deps.map((d) => wave.get(d) ?? 1)) + 1;
    wave.set(node.seq, depth);
  }
  return wave;
}

export interface Batch {
  /** Pending tasks whose dependencies all completed — safe to run in parallel. */
  ready: number[];
  /** Pending tasks that can never run because a dependency failed or was skipped. */
  skip: number[];
}

/**
 * What to do next, given where every task currently stands.
 *
 * `skip` exists so one failed task does not stall the run: everything
 * downstream of it is retired immediately and the executor carries on with the
 * branches that are still viable. Callers should apply the skips, then ask
 * again — skips cascade one level per call.
 */
export function nextBatch(nodes: GraphNode[], states: Map<number, TaskStatus>): Batch {
  const known = new Set(nodes.map((n) => n.seq));
  const ready: number[] = [];
  const skip: number[] = [];

  for (const node of nodes) {
    if ((states.get(node.seq) ?? 'pending') !== 'pending') continue;
    // Edges to tasks that are not in the graph are ignored rather than treated
    // as unmet: a dangling edge must not be able to freeze a run.
    const deps = node.dependsOn.filter((d) => known.has(d));
    const depStates = deps.map((d) => states.get(d) ?? 'pending');
    if (depStates.some((s) => s === 'failed' || s === 'skipped')) {
      skip.push(node.seq);
      continue;
    }
    if (depStates.every((s) => s === 'completed')) ready.push(node.seq);
  }

  return { ready, skip };
}

/**
 * Runs `fn` over `items` with at most `limit` in flight.
 *
 * The orchestrator can legitimately produce a wave of eight independent
 * sub-agents; firing all of them at the model API at once is how a run earns a
 * 429 for the whole workspace. Results come back in input order.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}
