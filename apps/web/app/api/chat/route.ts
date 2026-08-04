import { NextResponse, type NextRequest } from "next/server";
import { chatModel, utilityModel, NO_THINKING } from "@cortex/agent-tools";
import {
  streamText,
  generateText,
  tool,
  jsonSchema,
  type CoreMessage,
  type CoreTool,
} from "ai";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { buildToolContext } from "@/lib/agent";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { deniedToolPatterns, isToolDenied } from "@/lib/tool-access";
import { loadAgent } from "@cortex/agents";
import {
  filterTools,
  runTool,
  kbSearch,
  fetchEnabledExternalTools,
  callExternalTool,
  type ExternalServerRow,
} from "@cortex/agent-tools";
import { ConfirmationRequiredError, logger } from "@cortex/core";

export const runtime = "nodejs";
export const maxDuration = 300;

const ACKNOWLEDGMENT_RE =
  /^(ok|yes|no|sure|thanks|got it|sounds good|proceed|continue|sí|claro|dale|perfecto|de acuerdo)[.!?]?$/i;

function shouldRunRag(message: string): boolean {
  const wordCount = message.trim().split(/\s+/).length;
  if (wordCount < 8) return false;
  if (ACKNOWLEDGMENT_RE.test(message.trim())) return false;
  return true;
}

/**
 * Context-aware tool scoping. Sending 80+ function declarations to the model
 * on every message measurably degrades its tool selection ("dumb" picks) and
 * adds latency. Core families are always available; situational families are
 * included only when the recent conversation mentions them.
 */
const CORE_FAMILIES = new Set([
  "kb",
  "rate",
  "sales",
  "web",
  "pipeline",
  "schedule",
  "cortex",
  "format",
]);

const FAMILY_TRIGGERS: Array<{ family: string; re: RegExp }> = [
  {
    family: "hubspot",
    re: /hubspot|deal|pipeline de ventas|crm|prospect|client|cliente|company|empresa|contact/i,
  },
  {
    family: "recruit",
    re: /candidat|recruit|reclut|talent|shortlist|score|entrevista|interview|requisition|vacante/i,
  },
  { family: "workable", re: /workable|ats|stage|etapa|req\b/i },
  {
    family: "gmail",
    re: /email|correo|mail|inbox|draft|enviar|send|responder|reply/i,
  },
  {
    family: "gcal",
    re: /calendar|calendario|meeting|reuni[oó]n|agenda|invite|evento|event|schedule a call/i,
  },
  {
    family: "gsheets",
    re: /sheet|hoja de c[aá]lculo|spreadsheet|excel|fila|row/i,
  },
  { family: "gdrive", re: /drive|documento|document|doc\b|archivo|file/i },
  {
    family: "github",
    re: /github|repo|pull request|\bpr\b|issue|commit|c[oó]digo|code/i,
  },
  { family: "linear", re: /linear|sprint|cycle|ticket|roadmap|eng-\d+/i },
  { family: "slack", re: /slack|canal|channel|mensaje al equipo/i },
  {
    family: "growth",
    re: /signal|se[ñn]al|outreach|lead|prospecc|job post|growth|cold email/i,
  },
  { family: "payroll", re: /payroll|n[oó]mina|salar|pay rate|bill rate|pago/i },
  { family: "people", re: /team member|equipo asignado|roster|staff/i },
];

function scopeTools<T extends { id: string }>(
  tools: T[],
  recentText: string,
): T[] {
  if (tools.length <= 40) return tools;
  const active = new Set(CORE_FAMILIES);
  for (const { family, re } of FAMILY_TRIGGERS) {
    if (re.test(recentText)) active.add(family);
  }
  const scoped = tools.filter((t) => active.has(t.id.split(".")[0] ?? ""));
  // Safety net: never scope below a useful floor.
  return scoped.length >= 10 ? scoped : tools;
}

/**
 * Distill a tool error into a concise, human-readable message the model can
 * relay to the user. Unwraps Google/HubSpot-style JSON error envelopes and caps
 * length so a giant 403 payload doesn't flood the context.
 */
function toToolErrorMessage(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  // Many Google APIs throw with the raw JSON body as the message.
  const brace = msg.indexOf("{");
  if (brace !== -1) {
    try {
      const parsed = JSON.parse(msg.slice(brace));
      const inner = parsed?.error?.message ?? parsed?.message;
      if (typeof inner === "string" && inner.length > 0) msg = inner;
    } catch {
      // not JSON — keep the original string
    }
  }
  return msg.length > 600 ? `${msg.slice(0, 600)}…` : msg;
}

const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});

const Body = z.object({
  agentSlug: z.string().default("cortex"),
  conversationId: z.string().uuid().optional(),
  messages: z.array(MessageSchema).min(1),
});

export async function POST(req: NextRequest) {
  const user = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { agentSlug, messages } = parsed.data;

  const db = getSupabaseServiceClient();

  // Load agent from DB (gets UUID + system prompt stored in DB)
  let agent: Awaited<ReturnType<typeof loadAgent>>;
  try {
    agent = await loadAgent(db, agentSlug);
  } catch {
    return NextResponse.json(
      { error: `Agent '${agentSlug}' not found` },
      { status: 404 },
    );
  }

  // Resolve or create conversation
  let conversationId = parsed.data.conversationId;
  const lastUserMessage = [...messages]
    .reverse()
    .find((m) => m.role === "user");

  if (!conversationId) {
    const title = (lastUserMessage?.content ?? "New conversation").slice(0, 60);
    const { data: conv, error: convErr } = await db
      .from("conversations")
      .insert({
        user_id: user.id,
        agent_id: agent.id,
        surface: "web",
        title,
      })
      .select("id")
      .single();
    if (convErr || !conv) {
      return NextResponse.json(
        { error: "Failed to create conversation" },
        { status: 500 },
      );
    }
    conversationId = conv.id as string;
  }

  // Persist the user's last message
  if (lastUserMessage) {
    await db.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: lastUserMessage.content,
    });
  }

  const ctx = buildToolContext({
    userId: user.id,
    agentId: agent.id,
    conversationId,
  });

  // RAG prepend: kb.search top 3 on the last user message (conditional).
  // Skipped entirely while the KB has no indexed chunks — saves an embedding
  // round-trip per message on fresh workspaces.
  const ragQuery = lastUserMessage?.content ?? "";
  let ragBlock = "";
  const { count: chunkCount } = await db
    .from("kb_chunks")
    .select("id", { count: "exact", head: true });
  if ((chunkCount ?? 0) > 0 && shouldRunRag(ragQuery)) {
    const ragOut = ragQuery
      ? await runTool(kbSearch, { query: ragQuery, limit: 3 }, ctx).catch(
          () => ({ hits: [] }),
        )
      : { hits: [] };
    const relevant = (
      ragOut.hits as Array<{
        score?: number;
        documentTitle: string;
        chunkIndex: number;
        content: string;
      }>
    ).filter((h) => (h.score ?? 1) >= 0.65);
    if (relevant.length > 0) {
      ragBlock =
        "<context>\n" +
        relevant
          .map(
            (h, i) =>
              `[^${i + 1}] (${(h.score ?? 0).toFixed(2)}) ${h.documentTitle} chunk ${h.chunkIndex}:\n${h.content}`,
          )
          .join("\n\n") +
        "\n</context>";
    }
  }

  const recentText = messages
    .filter((m) => m.role === "user")
    .slice(-4)
    .map((m) => m.content)
    .join("\n");
  const scoped = scopeTools(filterTools(agent.allowedTools), recentText);
  // Team tool permissions are a deny-list layered on the agent's tools:
  // anything blocked by ANY of the user's teams never reaches the model.
  const deniedPatterns = await deniedToolPatterns(db, user.id);
  const allowed =
    deniedPatterns.length > 0
      ? scoped.filter((t) => !isToolDenied(t.id, deniedPatterns))
      : scoped;

  // AI SDK requires tool names matching ^[a-zA-Z0-9_-]+$ — replace dots with underscores
  // Build reverse map to find original tool by its AI SDK name
  const toolNameToId = new Map<string, string>();
  const aiTools: Record<string, CoreTool> = Object.fromEntries(
    allowed.map((t) => {
      const sdkName = t.id.replaceAll(".", "_");
      toolNameToId.set(sdkName, t.id);
      return [
        sdkName,
        tool({
          description: t.description,
          parameters: t.inputSchema,
          execute: async (args, { abortSignal }) => {
            try {
              return await runTool(t, args, { ...ctx, signal: abortSignal });
            } catch (err) {
              if (err instanceof ConfirmationRequiredError) {
                // Return a sentinel value the client can detect to show a confirmation prompt
                return {
                  __requires_confirmation: true,
                  toolId: t.id,
                  input: err.input,
                } as unknown as never;
              }
              // Never throw: a failed tool must not kill the turn. Return a
              // structured error so (a) the model can read it, explain it, and
              // keep going, and (b) the UI renders it as a failed tool card.
              return {
                __error: true,
                tool: t.id,
                message: toToolErrorMessage(err),
              } as unknown as never;
            }
          },
        }),
      ];
    }),
  );

  // Inject per-user external (dynamic) MCP tools. Failures here must never
  // break the chat turn, so the whole fetch is best-effort.
  const externalServers = await fetchEnabledExternalTools(db, user.id).catch(
    () => [],
  );
  for (const { server, tools } of externalServers) {
    for (const t of tools) {
      const prefix = "mcp_" + server.id.replace(/-/g, "").slice(0, 16) + "_";
      const sdkName = (prefix + t.tool_name).slice(0, 64);
      aiTools[sdkName] = tool({
        description: (t.tool_description ?? "").slice(0, 500),
        parameters: jsonSchema(
          (t.input_schema_json ?? {
            type: "object",
            properties: {},
          }) as Parameters<typeof jsonSchema>[0],
        ),
        execute: async (args, { abortSignal }) => {
          if (!server.trusted) {
            return {
              __requires_confirmation: true,
              toolId: sdkName,
              input: args,
            } as unknown as never;
          }
          try {
            return await callExternalTool(
              server as unknown as ExternalServerRow,
              t.tool_name,
              args,
              {
                userId: user.id,
                db,
                signal: abortSignal,
              },
            );
          } catch (err) {
            return {
              __error: true,
              tool: `${server.name}/${t.tool_name}`,
              message: toToolErrorMessage(err),
            } as unknown as never;
          }
        },
      });
    }
  }

  let coreMessages: CoreMessage[] = messages.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));

  if (conversationId) {
    try {
      const { data: dbMessages } = await db
        .from("messages")
        .select("role, content")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (dbMessages && dbMessages.length > 0) {
        const dbSet = new Set(dbMessages.map((m) => `${m.role}::${m.content}`));
        const clientOnly = coreMessages.filter(
          (m) => !dbSet.has(`${m.role}::${String(m.content)}`),
        );
        coreMessages = [
          ...dbMessages
            .reverse()
            .map((m) => ({
              role: m.role as "user" | "assistant" | "system",
              content: m.content as string,
            })),
          ...clientOnly,
        ];
      }
    } catch (err) {
      // non-fatal, use client messages
    }
  }

  // Shared with Google Chat and MCP so a person's standing instructions cannot
  // apply on one surface and silently not on another. See lib/system-prompt.ts.
  const { system } = await buildSystemPrompt({
    userId: user.id,
    basePrompt: agent.systemPrompt,
    sections: [ragBlock],
  });

  const result = streamText({
    model: chatModel(agent.defaultModel),
    system,
    messages: coreMessages,
    tools: aiTools,
    toolChoice: "auto",
    maxSteps: 12,
    onFinish: async ({ text, toolCalls, toolResults, usage }) => {
      try {
        await db.from("messages").insert({
          conversation_id: conversationId,
          role: "assistant",
          content: text,
          tool_calls: toolCalls as unknown as object,
          tool_results: toolResults as unknown as object,
        });
        // Auto-generate title on first turn
        const isFirstTurn =
          coreMessages.filter((m) => m.role === "assistant").length <= 1;
        if (isFirstTurn && lastUserMessage) {
          void (async () => {
            try {
              const { text: titleText } = await generateText({
                model: utilityModel(),
                prompt: `Summarize this sales conversation starter in 5 words or fewer, no punctuation: "${lastUserMessage.content.slice(0, 200)}"`,
                // Thinking off + real headroom: Claude counts reasoning against
                // maxTokens, so the old 20-token cap would truncate before the
                // title itself was ever emitted.
                experimental_providerMetadata: NO_THINKING,
                maxTokens: 256,
              });
              await db
                .from("conversations")
                .update({ title: titleText.trim() })
                .eq("id", conversationId);
            } catch {
              /* non-fatal */
            }
          })();
        }
        await db.from("audit_events").insert({
          user_id: user.id,
          agent_id: agent.id,
          conversation_id: conversationId,
          tool_id: "__agent_turn",
          input_hash: "turn",
          status: "ok",
          latency_ms: 0,
          metadata: {
            model: agent.defaultModel,
            tokensIn: usage?.promptTokens ?? 0,
            tokensOut: usage?.completionTokens ?? 0,
          },
        });
      } catch {
        // Non-fatal: don't kill the stream if persistence fails
      }
    },
  });

  return result.toDataStreamResponse({
    headers: { "X-Conversation-Id": conversationId },
    // An error part on the data stream makes useChat drop the assistant message
    // it was building, so a hiccup the model itself recovered from wiped the
    // whole answer from the screen — the reply was in the database and only
    // reappeared on reload. Surfacing the real reason turns a silent
    // "An error occurred." into something both the user and we can act on.
    getErrorMessage: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("chat stream error", { message });
      return message.slice(0, 300);
    },
  });
}
