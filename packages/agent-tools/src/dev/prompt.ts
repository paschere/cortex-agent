/**
 * The coding agent's system prompt and tool schemas.
 *
 * Kept as pure data, away from the SDK call, so the wording is reviewable and
 * the tool contract is testable without a network round trip.
 */

import type { CheckPlan } from "./checks";
import type { DevRepository, DevTask } from "./types";

export const CODER_TOOLS = [
  {
    name: "list_files",
    description:
      "List files under a directory in the checkout, recursively, respecting .gitignore. " +
      "Use this to orient yourself before reading.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: 'Directory relative to the repo root. "." for root.',
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description:
      "Search file contents with a regular expression (ripgrep). Returns matching lines with " +
      "their file and line number. Prefer this over listing large directories.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Regular expression to search for.",
        },
        path: {
          type: "string",
          description: "Directory to search. Defaults to the repo root.",
        },
        glob: {
          type: "string",
          description: 'Optional file glob filter, e.g. "**/*.ts".',
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      "Read a file from the checkout. Returns the file with 1-based line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path relative to the repo root.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Write a file in the checkout, creating parent directories as needed. This replaces the " +
      "whole file, so read it first and send back the complete new contents.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path relative to the repo root.",
        },
        content: { type: "string", description: "Complete new file contents." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command in the checkout. Use it for scoped things the other tools do not " +
      "cover — deleting a file, running one test file, inspecting a build artifact. Git commands " +
      "are refused: branching, committing and pushing are handled for you.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The shell command to run." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "run_checks",
    description:
      "Run the repository's own verification suite (install, typecheck, lint, tests, build) and " +
      "return the results. This is the only evidence that counts. It is slow — make a coherent " +
      "set of changes first, then run it.",
    input_schema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description:
      "End the run. Call this exactly once, when the work is done and verified, when the task " +
      "is too ambiguous to implement, or when you cannot make the checks pass.",
    input_schema: {
      type: "object" as const,
      properties: {
        outcome: {
          type: "string",
          enum: ["complete", "needs_input", "blocked"],
          description:
            '"complete" only when you changed code AND run_checks passed. "needs_input" when the ' +
            'task is ambiguous and a human must answer a question. "blocked" when you cannot ' +
            "finish or cannot make the checks pass.",
        },
        summary: {
          type: "string",
          description:
            'For "complete": what you changed and why, and what the checks verified. For ' +
            '"needs_input": the specific question, with the options you considered. For ' +
            '"blocked": what you tried and what stopped you. Markdown, addressed to a reviewer.',
        },
      },
      required: ["outcome", "summary"],
      additionalProperties: false,
    },
  },
];

export function buildSystemPrompt(params: {
  repository: DevRepository;
  checkPlan: CheckPlan;
  repoRoot: string;
}): string {
  const { repository, checkPlan, repoRoot } = params;
  const checkList = checkPlan.isConclusive
    ? checkPlan.steps.map((s) => `\`${s.cmd} ${s.args.join(" ")}\``).join(", ")
    : "none detected";

  return `You are Cortex, the company's engineering agent. You have been handed one issue and a
checkout of the \`${repository.key}\` repository at ${repoRoot}, on a fresh branch off
\`${repository.default_branch}\`. Your job is to make the change and prove it works.

## How this run ends

Call \`finish\` exactly once. Everything you do before that is preparation for it.
Nothing is committed, pushed or opened as a pull request until you finish with
\`complete\` — and \`complete\` is only honest if \`run_checks\` passed after your last edit.

## Rules

- **Verify before you claim.** \`run_checks\` runs this repo's own suite (${checkList}).
  Passing it is the only evidence that counts. If you cannot make it pass, finish with
  \`blocked\` and explain what stopped you. Do not finish \`complete\` on a failing suite,
  and do not weaken a check, skip a test, or loosen a type to make one pass.
- **Ask rather than guess.** If the issue is ambiguous in a way that changes what you
  would build — two plausible readings, a missing decision, an unstated interface — finish
  with \`needs_input\` and ask the specific question. A question is a good outcome. A
  confidently wrong implementation is not.
- **Stay in scope.** Make the change the issue asks for. Do not refactor surrounding code,
  add abstractions for hypothetical future needs, or fix unrelated problems you notice
  along the way; mention them in your summary instead.
- **Match the codebase.** Read neighbouring files before you write. Follow the naming,
  structure and idioms already there rather than importing your own conventions.
- **Write tests for real logic.** If you add behaviour with branches or edge cases, test it
  the way this repo already tests things.
- **Git is not yours.** Branch, commit, push and pull request are handled for you, on a
  branch that can never be a default branch. \`bash\` refuses git commands.

## Working style

Read before you write; \`search\` is usually faster than \`list_files\`. Group your edits
into one coherent change, then run the checks — the suite is slow and you have a bounded
budget of turns. Keep your messages between tool calls short: a sentence when you find
something load-bearing or change direction, nothing for routine steps.`;
}

export function buildTaskMessage(task: DevTask): string {
  const lines = [
    `# ${task.external_identifier}: ${task.title}`,
    "",
    task.description?.trim() ||
      "_The issue has no description beyond its title._",
  ];
  if (task.external_url) lines.push("", `Linear issue: ${task.external_url}`);
  if (task.requester_name) lines.push(`Assigned by: ${task.requester_name}`);
  return lines.join("\n");
}

/**
 * The PR body. Every field is drawn from what actually happened in the run —
 * the issue link, the agent's own summary, and the verbatim check results — so
 * a reviewer can tell what was verified from evidence rather than assertion.
 */
export function buildPullRequestBody(params: {
  task: DevTask;
  summary: string;
  checkSummary: string;
  iterations: number;
  tokens: number;
  durationMs: number;
}): string {
  const { task, summary, checkSummary, iterations, tokens, durationMs } =
    params;
  const issueLine = task.external_url
    ? `Closes [${task.external_identifier}](${task.external_url})`
    : `Closes ${task.external_identifier}`;

  return `${issueLine}

## What changed

${summary}

## What was verified

${checkSummary}

---

<sub>Opened by Cortex for ${task.requester_name ?? "an unattended run"} · ${iterations} model
turns · ${tokens.toLocaleString("en-US")} tokens · ${Math.round(durationMs / 1000)}s ·
task \`${task.id}\`. Cortex cannot merge this; a human review is required.</sub>`;
}

export function buildPullRequestTitle(task: DevTask): string {
  const title = `${task.external_identifier}: ${task.title}`.trim();
  return title.length > 240 ? `${title.slice(0, 237)}...` : title;
}
