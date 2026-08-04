import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import {
  CODER_TOOLS,
  type CheckOutcome,
  type CheckPlan,
  UnsafeCommandError,
  allChecksPassed,
  assertSafeBashCommand,
  buildSystemPrompt,
  buildTaskMessage,
  formatCheckSummary,
  resolveRepoPath,
} from '@cortex/agent-tools';
import type { DevRepository, DevTask } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import type { Sandbox } from '@vercel/sandbox';
import { REPO_ROOT, readTranscript, run, truncateOutput, writeTranscript } from './sandbox';

/**
 * One turn of the coding agent.
 *
 * The loop is written by hand rather than with the SDK's tool runner because
 * the run is sliced across Inngest steps: a runner object cannot survive a
 * function invocation ending, but a message array serialised into the sandbox
 * can. Each call here reads the transcript, makes exactly one model request,
 * executes whatever tools it asked for, appends the results and writes the
 * transcript back. The orchestrator decides whether there is budget for
 * another turn.
 */

/** Model choice: this is coding work, not the chat path's Gemini traffic. */
const MODEL = 'claude-opus-5';
const MAX_TOKENS = 32_000;

export type TurnOutcome =
  | { kind: 'continue'; note: string | null }
  | { kind: 'finished'; outcome: 'complete' | 'needs_input' | 'blocked'; summary: string }
  /**
   * The model asked for the check suite. The turn stops here and hands control
   * back to the orchestrator, because the suite outlives a single function
   * invocation: it is launched detached and polled across later Inngest steps.
   * `applyCheckResults` closes the turn once the suite finishes.
   */
  | { kind: 'checks_requested' };

export interface TurnResult {
  outcome: TurnOutcome;
  usage: { inputTokens: number; outputTokens: number };
}

type Message = Anthropic.MessageParam;

/** Tool results already computed this turn, parked while the suite runs. */
interface PendingTurn {
  checkToolUseId: string;
  results: Anthropic.ToolResultBlockParam[];
}

function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured; dev tasks cannot run.');
  }
  return new Anthropic();
}

export interface TurnContext {
  sandbox: Sandbox;
  task: DevTask;
  repository: DevRepository;
  checkPlan: CheckPlan;
}

export async function runTurn(ctx: TurnContext): Promise<TurnResult> {
  const messages = ((await readTranscript(ctx.sandbox)) as Message[] | null) ?? [
    { role: 'user', content: buildTaskMessage(ctx.task) },
  ];

  const system = buildSystemPrompt({
    repository: ctx.repository,
    checkPlan: ctx.checkPlan,
    repoRoot: REPO_ROOT,
  });

  // Streamed because max_tokens is far above the threshold where a
  // non-streaming request risks an HTTP timeout.
  const stream = client().messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'xhigh' },
    tools: CODER_TOOLS,
    messages,
  });
  const response = await stream.finalMessage();

  const usage = {
    inputTokens:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    outputTokens: response.usage.output_tokens,
  };

  // A refusal is a real outcome, not an exception: stop and say so.
  if (response.stop_reason === 'refusal') {
    return {
      usage,
      outcome: {
        kind: 'finished',
        outcome: 'blocked',
        summary:
          'The model declined to work on this task. It was not implemented and no pull ' +
          'request was opened. A human should look at the issue text.',
      },
    };
  }

  // A truncated turn can carry a half-written tool call, and appending it would
  // leave the transcript in a state the API rejects on the next request. Stop
  // here rather than corrupting the run.
  if (response.stop_reason === 'max_tokens') {
    return {
      usage,
      outcome: {
        kind: 'finished',
        outcome: 'blocked',
        summary: [
          `A single response exceeded the ${MAX_TOKENS.toLocaleString('en-US')}-token limit`,
          'and was cut off, so the run could not continue safely. This usually means the task',
          'needs breaking into smaller pieces.',
        ].join(' '),
      },
    };
  }

  messages.push({ role: 'assistant', content: response.content });

  const toolUses = response.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (toolUses.length === 0) {
    // No tool call and no finish: nudge rather than spin. The nudge is a real
    // user turn so the model sees it, and it costs one budgeted iteration.
    messages.push({
      role: 'user',
      content:
        'You did not call a tool. Continue the task, or call `finish` if you are done, ' +
        'blocked, or need a human to answer something.',
    });
    await writeTranscript(ctx.sandbox, messages);
    return { usage, outcome: { kind: 'continue', note: null } };
  }

  const results: Anthropic.ToolResultBlockParam[] = [];
  let terminal: TurnOutcome | null = null;
  let checkToolUseId: string | null = null;

  // Tools can arrive in any order in one turn, so decide up front rather than
  // letting the outcome depend on which block came first. `finish` alongside
  // `run_checks` defers to the checks: finishing on the strength of a suite
  // that has not run yet is exactly the unverified claim this design prevents.
  const checksRequested = toolUses.some((call) => call.name === 'run_checks');

  for (const call of toolUses) {
    if (call.name === 'finish') {
      if (checksRequested) {
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content:
            'Your `finish` call was set aside: you asked for the checks in the same turn, so ' +
            'they are running now. Read the results, then call `finish` again.',
        });
        continue;
      }
      const input = call.input as { outcome?: string; summary?: string };
      const outcome =
        input.outcome === 'complete' || input.outcome === 'needs_input' ? input.outcome : 'blocked';
      terminal = {
        kind: 'finished',
        outcome,
        summary: (input.summary ?? '').trim() || 'The run finished without a summary.',
      };
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: 'Run recorded. Nothing further to do.',
      });
      continue;
    }

    if (call.name === 'run_checks') {
      // Not run here. The suite can take a quarter of an hour, which no single
      // invocation may span; park the turn and let the orchestrator drive it
      // across steps.
      checkToolUseId = call.id;
      continue;
    }

    try {
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: await executeTool(ctx.sandbox, call),
      });
    } catch (err) {
      // Tool failures are information for the model, not run failures. Only an
      // exhausted budget or a broken sandbox ends a run early.
      const message =
        err instanceof UnsafeCommandError
          ? err.message
          : `Tool failed: ${(err as Error).message.slice(0, 800)}`;
      results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: message });
    }
  }

  const note = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 400);

  if (checkToolUseId) {
    // The transcript ends on the assistant turn; the matching user turn is
    // owed and will be written by applyCheckResults. Park the results we
    // already have so nothing is recomputed after the suite finishes.
    await writeTranscript(ctx.sandbox, messages);
    await writePending(ctx.sandbox, { checkToolUseId, results });
    return { usage, outcome: { kind: 'checks_requested' } };
  }

  messages.push({ role: 'user', content: results });
  await writeTranscript(ctx.sandbox, messages);

  if (terminal) return { usage, outcome: terminal };
  return { usage, outcome: { kind: 'continue', note: note || null } };
}

/**
 * Close a turn that was parked on `run_checks`, feeding the suite's verdict
 * back as the tool_result the model is waiting on.
 */
export async function applyCheckResults(
  sandbox: Sandbox,
  outcomes: CheckOutcome[],
): Promise<{ passed: boolean }> {
  const pending = await readPending(sandbox);
  const messages = ((await readTranscript(sandbox)) as Message[] | null) ?? [];
  if (!pending || messages.length === 0) {
    throw new Error('Check results arrived with no parked turn to attach them to.');
  }

  const passed = allChecksPassed(outcomes);
  const failures = outcomes
    .filter((o) => !o.passed)
    .map((o) => `### ${o.label} (exit ${o.exitCode})\n\n\`\`\`\n${o.output}\n\`\`\``)
    .join('\n\n');

  messages.push({
    role: 'user',
    content: [
      ...pending.results,
      {
        type: 'tool_result',
        tool_use_id: pending.checkToolUseId,
        is_error: !passed,
        content: truncateOutput(
          `${formatCheckSummary(outcomes)}${
            failures ? `\n\n${failures}` : '\n\nEvery check passed.'
          }`,
        ),
      },
    ],
  });

  await writeTranscript(sandbox, messages);
  await clearPending(sandbox);
  return { passed };
}

const PENDING_PATH = `${REPO_ROOT}/.cortex/pending.json`;

async function writePending(sandbox: Sandbox, pending: PendingTurn): Promise<void> {
  await sandbox.writeFiles([{ path: PENDING_PATH, content: JSON.stringify(pending) }]);
}

async function readPending(sandbox: Sandbox): Promise<PendingTurn | null> {
  const buffer = await sandbox.readFileToBuffer({ path: PENDING_PATH });
  if (!buffer) return null;
  try {
    return JSON.parse(buffer.toString('utf8')) as PendingTurn;
  } catch {
    return null;
  }
}

async function clearPending(sandbox: Sandbox): Promise<void> {
  await sandbox.writeFiles([{ path: PENDING_PATH, content: 'null' }]);
}

async function executeTool(sandbox: Sandbox, call: Anthropic.ToolUseBlock): Promise<string> {
  const input = call.input as Record<string, unknown>;

  switch (call.name) {
    case 'read_file': {
      const path = resolveRepoPath(REPO_ROOT, String(input.path ?? ''));
      const buffer = await sandbox.readFileToBuffer({ path });
      if (!buffer) return `No such file: ${input.path}`;
      const numbered = buffer
        .toString('utf8')
        .split('\n')
        .map((line, i) => `${String(i + 1).padStart(5, ' ')}\t${line}`)
        .join('\n');
      return truncateOutput(numbered);
    }

    case 'write_file': {
      const path = resolveRepoPath(REPO_ROOT, String(input.path ?? ''));
      const content = input.content;
      if (typeof content !== 'string') return 'write_file requires a string `content`.';
      const dir = path.slice(0, path.lastIndexOf('/'));
      if (dir) await sandbox.mkDir(dir);
      await sandbox.writeFiles([{ path, content }]);
      return `Wrote ${content.split('\n').length} lines to ${input.path}.`;
    }

    case 'list_files': {
      const path = resolveRepoPath(REPO_ROOT, String(input.path ?? '.'));
      // git ls-files honours .gitignore for free and keeps node_modules out.
      const listed = await run(sandbox, {
        cmd: 'git',
        args: ['ls-files', '--cached', '--others', '--exclude-standard', '--', path],
        cwd: REPO_ROOT,
      });
      return listed.output || '(no tracked files under that path)';
    }

    case 'search': {
      const pattern = String(input.pattern ?? '');
      if (!pattern) return 'search requires a `pattern`.';
      const path = resolveRepoPath(REPO_ROOT, String(input.path ?? '.'));
      // `git grep` rather than ripgrep: git is guaranteed present (the repo got
      // here by being cloned) and it already honours .gitignore, so a search
      // never drowns in node_modules.
      const args = [
        'grep',
        '--line-number',
        '--no-color',
        '--untracked',
        '--extended-regexp',
        '-e',
        pattern,
        '--',
        // A glob is a pathspec here; without one, scope to the requested path.
        typeof input.glob === 'string' && input.glob ? `:(glob)${input.glob}` : path,
      ];
      const found = await run(sandbox, { cmd: 'git', args, cwd: REPO_ROOT, timeoutMs: 60_000 });
      // git grep exits 1 on "no matches", which is an answer, not a fault.
      if (found.exitCode === 1 && !found.output) return 'No matches.';
      if (found.exitCode > 1) return `Search failed: ${found.output}`;
      const lines = found.output.split('\n');
      return lines.length > 300
        ? `${lines.slice(0, 300).join('\n')}\n… ${lines.length - 300} more matches; narrow the search.`
        : found.output || 'No matches.';
    }

    case 'bash': {
      const command = String(input.command ?? '');
      assertSafeBashCommand(command);
      const result = await run(sandbox, {
        cmd: 'bash',
        args: ['-lc', command],
        cwd: REPO_ROOT,
        timeoutMs: 120_000,
      });
      return `exit ${result.exitCode}\n\n${result.output || '(no output)'}`;
    }

    default:
      logger.warn('dev-task: model called an unknown tool', { tool: call.name });
      return `Unknown tool: ${call.name}`;
  }
}
