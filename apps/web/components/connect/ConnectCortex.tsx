"use client";

import { clsx } from "clsx";
import { Bot, Check, Copy, MessagesSquare, Plug, Terminal } from "lucide-react";
import { useState } from "react";

type TargetId = "claude" | "chatgpt" | "claude-code" | "other";

const TARGET_ORDER = [
  "claude",
  "chatgpt",
  "claude-code",
  "other",
] as const satisfies readonly TargetId[];

interface Target {
  id: TargetId;
  label: string;
  icon: React.ReactNode;
  /** Small line under the tabs describing where this applies. */
  caption: string;
  /** Numbered steps. `**text**` renders emphasized (menu paths, buttons). */
  steps: string[];
  /** Optional copyable snippet rendered under the steps. */
  snippet?: string;
  /** Optional honest caveat / tip. */
  note?: string;
}

/** Splits `**bold**` markers into renderable, uniquely keyed segments. */
function segments(
  text: string,
): { key: string; text: string; bold: boolean }[] {
  const out: { key: string; text: string; bold: boolean }[] = [];
  const parts = text.split("**");
  let offset = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const chunk = parts[i] ?? "";
    if (chunk)
      out.push({ key: `${offset}:${chunk}`, text: chunk, bold: i % 2 === 1 });
    offset += chunk.length + 2;
  }
  return out;
}

function Step({ text }: { text: string }) {
  return (
    <>
      {segments(text).map((s) =>
        s.bold ? (
          <strong key={s.key} className="font-semibold text-ink">
            {s.text}
          </strong>
        ) : (
          <span key={s.key}>{s.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Copies `text` and flips to a Check + "Copied" label for ~2s.
 *
 * Exported because the dashboard and the connect page both need it; it is the
 * only client-side bit of an otherwise server-rendered surface.
 */
export function CopyButton({
  text,
  label = "Copy",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (e.g. insecure context); fail silently.
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied" : label}
      className={clsx(
        "inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors",
        copied
          ? "border-emerald/40 bg-emerald-soft text-emerald"
          : "border-border bg-surface text-ink-muted hover:border-primary/30 hover:text-primary",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {copied ? "Copied" : label}
    </button>
  );
}

/** Mono line + its own copy button. */
function CodeLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-[10px] border border-border bg-surface-2 px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[11.5px] leading-relaxed text-ink">
        {text}
      </code>
      <CopyButton text={text} />
    </div>
  );
}

/** The connector URL, plus per-client setup steps. Single source of truth. */
export function ConnectCortex({ url }: { url: string }) {
  const [active, setActive] = useState<TargetId>("claude");

  const targets: Record<TargetId, Target> = {
    claude: {
      id: "claude",
      label: "Claude",
      icon: <Bot className="h-3.5 w-3.5" />,
      caption: "Claude on web, desktop and mobile",
      steps: [
        "Open **Settings → Connectors**.",
        "Choose **Add custom connector**.",
        "Paste the connector URL above.",
        "Sign in with your **@Cortex.com** Google account and hit **Approve**.",
      ],
      note: "Inside a chat, enable the connector from the tools menu so Cortex can use it.",
    },
    chatgpt: {
      id: "chatgpt",
      label: "ChatGPT",
      icon: <MessagesSquare className="h-3.5 w-3.5" />,
      caption: "ChatGPT with connector support enabled",
      steps: [
        "Open **Settings → Connectors** — or a custom connector / developer mode, depending on your plan.",
        "Add an MCP server pointing at the same URL above.",
        "Authorize with your Google account when prompted.",
      ],
      note: "Availability depends on your ChatGPT plan, and the feature may still be labeled beta.",
    },
    "claude-code": {
      id: "claude-code",
      label: "Claude Code",
      icon: <Terminal className="h-3.5 w-3.5" />,
      caption: "The CLI, in any terminal",
      steps: [
        "Run the command below once — it registers Cortex for your user.",
        "Authorize in the browser window it opens.",
      ],
      snippet: `claude mcp add --transport http cortex ${url}`,
      note: "Working inside the cortex-agent repo? It is picked up automatically from .mcp.json — no setup needed.",
    },
    other: {
      id: "other",
      label: "Other clients",
      icon: <Plug className="h-3.5 w-3.5" />,
      caption: "Cursor, Windsurf, or your own client",
      steps: [
        "Any client that supports **remote MCP servers with OAuth 2.1** works.",
        "Register the same URL as a remote MCP server.",
        "Complete the Google sign-in the client opens for you.",
      ],
      snippet: url,
      note: "Discovery is automatic — the client reads the authorization metadata and the tool list from the URL itself.",
    },
  };

  const current = targets[active];

  return (
    <div className="mt-4">
      {/* Connector URL */}
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
        Connector URL
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface-2 px-3 py-2.5">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[13px] font-semibold text-ink">
          {url}
        </code>
        <CopyButton text={url} label="Copy URL" />
      </div>

      {/* Target picker */}
      <div className="mt-4 flex flex-wrap gap-1 rounded-pill border border-border bg-surface-2 p-1">
        {TARGET_ORDER.map((id) => targets[id]).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActive(t.id)}
            aria-pressed={t.id === active}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-[12.5px] font-semibold transition-all",
              t.id === active
                ? "bg-surface text-ink shadow-card"
                : "text-ink-muted hover:text-ink",
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Steps for the active target */}
      <div className="mt-3 rounded-card border border-border bg-surface p-4">
        <div className="text-[11.5px] text-ink-faint">{current.caption}</div>
        <ol className="mt-2.5 space-y-2">
          {current.steps.map((step, i) => (
            <li key={step} className="flex items-start gap-2.5">
              <span className="stat-num mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary-soft text-[11px] text-primary">
                {i + 1}
              </span>
              <span className="text-[12.5px] leading-relaxed text-ink-muted">
                <Step text={step} />
              </span>
            </li>
          ))}
        </ol>

        {current.snippet && (
          <div className="mt-3">
            <CodeLine text={current.snippet} />
          </div>
        )}

        {current.note && (
          <p className="mt-3 border-t border-border pt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
            {current.note}
          </p>
        )}
      </div>
    </div>
  );
}
