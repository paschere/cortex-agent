import "server-only";
import { createSign } from "node:crypto";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { logger } from "@cortex/core";

/**
 * Outbound Google Chat — posting messages AS the Cortex Chat app.
 *
 * Two different Google Chat integrations exist in this codebase and they must
 * not be confused:
 *
 *  - `packages/agent-tools/src/chat/*` posts through an INCOMING WEBHOOK the
 *    person pastes into their own space. No app, no admin approval, one space.
 *  - This file posts through the CHAT APP itself, authenticated with a service
 *    account (`GOOGLE_CHAT_SERVICE_ACCOUNT_JSON`, scope `chat.bot`). It can DM
 *    anyone who has ever messaged the app, and it is what makes the webhook at
 *    /api/chat-app/google able to answer asynchronously.
 *
 * Everything here FAILS SOFT: a Chat outage must never break an approval, a
 * scheduled run, or a chat turn. Callers get `{ sent: false, reason }`; nothing
 * throws.
 *
 * ── DELIBERATE DUPLICATION ────────────────────────────────────────────────
 * `packages/agent-tools/src/chat/service-account.ts` is this file's twin inside
 * the tools package (it backs the `chat.send_dm` tool and the digest's DM
 * channel). The JWT → token → POST flow is copied rather than shared because
 * `packages/**` must never import from `apps/web/**`: the tools package also
 * runs under the MCP server and the scheduler, neither of which has a Next.js
 * runtime, `server-only`, or the `@/` alias. This file additionally owns the
 * INBOUND side (/api/chat-app/google) and its own Supabase client. Keep the two
 * in sync when the auth flow or Chat's limits change.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Required env:
 *   GOOGLE_CHAT_SERVICE_ACCOUNT_JSON  service-account key, raw JSON or base64
 *   APP_BASE_URL                      used for the "full report" fallback link
 */

/** Google Chat rejects text messages longer than this. */
export const CHAT_TEXT_LIMIT = 4096;

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

export interface ChatSendResult {
  sent: boolean;
  /** Short machine-ish reason when `sent` is false. Safe to log. */
  reason?: string;
  /** `spaces/X/messages/Y` when the post succeeded. */
  messageName?: string;
}

/**
 * One entry of a message's `cardsV2`.
 *
 * Deliberately untyped inside `card`: Chat's card schema is large, versioned by
 * Google, and we only ever build it in one place (lib/approval-card.ts). Typing
 * the whole widget tree here would be a second, always-stale copy of Google's
 * reference. `cardId` is ours and must be stable per logical card.
 */
export interface ChatCardV2 {
  cardId: string;
  card: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Service-account credentials
// ---------------------------------------------------------------------------

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

/**
 * Accepts either the raw service-account JSON or a base64 blob of it — Vercel
 * env values survive base64 much better than multi-line JSON with `\n` inside
 * a PEM, so both spellings are supported.
 */
function decodeServiceAccount(raw: string): ServiceAccountKey | null {
  const trimmed = raw.trim();
  let json = trimmed;
  if (!trimmed.startsWith("{")) {
    try {
      json = Buffer.from(trimmed, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(json) as Partial<ServiceAccountKey>;
    if (!parsed.client_email || !parsed.private_key) return null;
    return {
      client_email: parsed.client_email,
      // Env vars frequently carry the PEM with literal "\n" sequences.
      private_key: parsed.private_key.replace(/\\n/g, "\n"),
      ...(parsed.private_key_id
        ? { private_key_id: parsed.private_key_id }
        : {}),
    };
  } catch {
    return null;
  }
}

// `undefined` = not looked up yet, `null` = looked up and unavailable.
let serviceAccountCache: ServiceAccountKey | null | undefined;

function serviceAccount(): ServiceAccountKey | null {
  if (serviceAccountCache !== undefined) return serviceAccountCache;
  const raw = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON;
  serviceAccountCache = raw ? decodeServiceAccount(raw) : null;
  if (raw && !serviceAccountCache) {
    logger.error(
      "google-chat: GOOGLE_CHAT_SERVICE_ACCOUNT_JSON is set but unparseable",
    );
  }
  return serviceAccountCache;
}

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

// Access tokens live an hour; cache and refresh a minute early.
let tokenCache: { token: string; expiresAt: number } | null = null;

/**
 * Self-signed JWT → OAuth2 access token (the "two-legged" service-account
 * flow). No user consent is involved: the Chat app's own identity is what
 * posts the message.
 */
async function getAccessToken(): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000)
    return tokenCache.token;

  const key = serviceAccount();
  if (!key) return null;

  const now = Math.floor(Date.now() / 1000);
  const header: Record<string, string> = { alg: "RS256", typ: "JWT" };
  if (key.private_key_id) header.kid = key.private_key_id;
  const claims = {
    iss: key.client_email,
    scope: CHAT_BOT_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  };

  let assertion: string;
  try {
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    assertion = `${signingInput}.${signer.sign(key.private_key, "base64url")}`;
  } catch (err) {
    logger.error("google-chat: could not sign the service-account assertion", {
      error: (err as Error).message,
    });
    return null;
  }

  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error("google-chat: token exchange failed", {
        status: res.status,
        body: body.slice(0, 300),
      });
      return null;
    }
    const parsed = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!parsed.access_token) return null;
    tokenCache = {
      token: parsed.access_token,
      expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    };
    return tokenCache.token;
  } catch (err) {
    logger.error("google-chat: token exchange threw", {
      error: (err as Error).message,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Accepts `spaces/AAAA` or a bare `AAAA`; rejects anything else. */
function normalizeSpace(space: string): string | null {
  const trimmed = space.trim().replace(/^\/+/, "");
  if (!trimmed) return null;
  const name = trimmed.startsWith("spaces/") ? trimmed : `spaces/${trimmed}`;
  return /^spaces\/[A-Za-z0-9_-]+$/.test(name) ? name : null;
}

/**
 * Post a message into a space as the Chat app.
 *
 * Threading: pass `threadName` (`spaces/X/threads/Y`, straight off an inbound
 * event) to answer inside an existing thread, or `threadKey` — an arbitrary
 * string of ours — to group related proactive messages. Either way we use
 * REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD so a stale thread never drops the
 * message on the floor.
 */
export async function sendChatMessage(opts: {
  space: string;
  text: string;
  threadKey?: string;
  threadName?: string;
  /** Interactive card(s). `text` then only anchors the notification preview. */
  cards?: ChatCardV2[];
}): Promise<ChatSendResult> {
  const text = opts.text?.trim() ?? "";
  const cards = opts.cards ?? [];
  // A card-only message is valid to Chat; an empty one is not.
  if (!text && cards.length === 0)
    return { sent: false, reason: "empty message" };

  const space = normalizeSpace(opts.space ?? "");
  if (!space) return { sent: false, reason: "invalid space" };

  const token = await getAccessToken();
  if (!token) {
    return {
      sent: false,
      reason: "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON not configured",
    };
  }

  const url = new URL(`${CHAT_API_BASE}/${space}/messages`);
  const body: Record<string, unknown> = {};
  if (text) body.text = text.slice(0, CHAT_TEXT_LIMIT);
  if (cards.length > 0) body.cardsV2 = cards;
  if (opts.threadName) {
    body.thread = { name: opts.threadName };
  } else if (opts.threadKey) {
    body.thread = { threadKey: opts.threadKey };
    url.searchParams.set("threadKey", opts.threadKey);
  }
  if (opts.threadName || opts.threadKey) {
    url.searchParams.set(
      "messageReplyOption",
      "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    );
  }

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      logger.error("google-chat: message post failed", {
        space,
        status: res.status,
        body: errBody.slice(0, 300),
      });
      return { sent: false, reason: `chat ${res.status}` };
    }
    const created = (await res.json().catch(() => ({}))) as { name?: string };
    return created.name
      ? { sent: true, messageName: created.name }
      : { sent: true };
  } catch (err) {
    logger.error("google-chat: message post threw", {
      space,
      error: (err as Error).message,
    });
    return { sent: false, reason: "network error" };
  }
}

/**
 * Rewrite a message we already posted.
 *
 * This is what lets the "on it" placeholder become the answer instead of
 * sitting above it forever: Chat gives us the message name on creation, and a
 * turn that takes twenty seconds ends as ONE message rather than two. Failure
 * is non-exceptional — the caller falls back to posting a new message, which
 * is worse-looking but never silent.
 */
export async function updateChatMessage(opts: {
  messageName: string;
  text: string;
  /**
   * Replacement card(s). Pass `[]` explicitly to STRIP the cards off a message
   * — that is how an answered approval loses its buttons. Omitting the field
   * leaves whatever cards the message already has, because `cardsV2` then stays
   * out of the update mask.
   */
  cards?: ChatCardV2[];
}): Promise<ChatSendResult> {
  const text = opts.text?.trim() ?? "";
  if (!text && !opts.cards) return { sent: false, reason: "empty message" };
  if (
    !/^spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.-]+$/.test(
      opts.messageName,
    )
  ) {
    return { sent: false, reason: "invalid message name" };
  }

  const token = await getAccessToken();
  if (!token) {
    return {
      sent: false,
      reason: "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON not configured",
    };
  }

  // The mask decides what is REPLACED. A card left out of it survives the
  // update, so an approval that has been decided must name cardsV2 explicitly.
  const mask = ["text", ...(opts.cards ? ["cardsV2"] : [])].join(",");
  const url = new URL(`${CHAT_API_BASE}/${opts.messageName}`);
  url.searchParams.set("updateMask", mask);

  const body: Record<string, unknown> = {
    text: text.slice(0, CHAT_TEXT_LIMIT),
  };
  if (opts.cards) body.cardsV2 = opts.cards;

  try {
    const res = await fetch(url.toString(), {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      logger.error("google-chat: message update failed", {
        status: res.status,
        body: errBody.slice(0, 300),
      });
      return { sent: false, reason: `chat ${res.status}` };
    }
    return { sent: true, messageName: opts.messageName };
  } catch (err) {
    logger.error("google-chat: message update threw", {
      error: (err as Error).message,
    });
    return { sent: false, reason: "network error" };
  }
}

/**
 * Is this space the private 1:1 between one person and the app?
 *
 * `spaceType: DIRECT_MESSAGE` is NOT enough — Google uses it for group direct
 * messages too, which have other humans in them. `singleUserBotDm` is the only
 * claim that means what we need, so a space that does not assert it is treated
 * as not private. Chat outages resolve to `false`: withholding a private
 * message is recoverable, posting it to the wrong audience is not.
 *
 * Cached briefly — a routine fans out to the same handful of people.
 */
const dmCheckCache = new Map<string, { at: number; ok: boolean }>();
const DM_CHECK_TTL_MS = 10 * 60_000;

async function isPrivateBotDm(space: string): Promise<boolean> {
  const cached = dmCheckCache.get(space);
  if (cached && Date.now() - cached.at < DM_CHECK_TTL_MS) return cached.ok;

  const token = await getAccessToken();
  if (!token) return false;
  try {
    const res = await fetch(`${CHAT_API_BASE}/${space}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const body = (await res.json()) as {
      singleUserBotDm?: boolean;
      spaceType?: string;
      membershipCount?: { joinedDirectHumanUserCount?: number };
    };
    const ok =
      body.singleUserBotDm === true ||
      (body.spaceType === "DIRECT_MESSAGE" &&
        body.membershipCount?.joinedDirectHumanUserCount === 1);
    dmCheckCache.set(space, { at: Date.now(), ok });
    return ok;
  } catch (err) {
    logger.error("google-chat: could not confirm the space is a private DM", {
      space,
      error: (err as Error).message,
    });
    return false;
  }
}

/**
 * DM a Cortex user in Google Chat.
 *
 * The DM space is discovered passively: it is recorded the first time the
 * person messages the app (see /api/chat-app/google). We cannot create a DM
 * out of nowhere, so an unlinked user is a normal, non-exceptional outcome —
 * `{ sent: false, reason: 'not linked' }`, never a throw.
 */
export async function sendChatDm(opts: {
  userId: string;
  text: string;
  threadKey?: string;
  /** Interactive card(s) — see sendChatMessage. */
  cards?: ChatCardV2[];
}): Promise<ChatSendResult> {
  if (!opts.userId) return { sent: false, reason: "not linked" };
  try {
    const db = getSupabaseServiceClient();
    const { data } = await db
      .from("google_chat_links")
      .select("dm_space")
      .eq("user_id", opts.userId)
      .not("dm_space", "is", null)
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const space = (data?.dm_space as string | null | undefined) ?? null;
    if (!space) return { sent: false, reason: "not linked" };

    // Confirm with Chat that this really is the 1:1 with the app before saying
    // anything private into it. Google labels a GROUP direct message
    // `spaceType: DIRECT_MESSAGE` as well, so a space learned from a two-person
    // DM used to be stored here and every digest, routine result and approval
    // went to a conversation with someone else in it. A wrong space is cleared
    // rather than kept, so the next 1:1 message relearns the right one.
    if (!(await isPrivateBotDm(space))) {
      logger.warn(
        "google-chat: stored DM space is not a private 1:1 — clearing it",
        { space },
      );
      await db
        .from("google_chat_links")
        .update({ dm_space: null })
        .eq("user_id", opts.userId)
        .eq("dm_space", space);
      return { sent: false, reason: "not linked" };
    }

    const payload: Parameters<typeof sendChatMessage>[0] = {
      space,
      text: opts.text,
    };
    if (opts.threadKey) payload.threadKey = opts.threadKey;
    if (opts.cards) payload.cards = opts.cards;
    return await sendChatMessage(payload);
  } catch (err) {
    logger.error("google-chat: DM lookup failed", {
      userId: opts.userId,
      error: (err as Error).message,
    });
    return { sent: false, reason: "lookup failed" };
  }
}

/** True when the app has credentials to post proactively. Cheap, no network. */
export function isChatOutboundConfigured(): boolean {
  return serviceAccount() !== null;
}

/** Does this Cortex user have a DM space with the Chat app? */
export async function getChatDmSpace(userId: string): Promise<string | null> {
  if (!userId) return null;
  try {
    const db = getSupabaseServiceClient();
    const { data } = await db
      .from("google_chat_links")
      .select("dm_space")
      .eq("user_id", userId)
      .not("dm_space", "is", null)
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.dm_space as string | null | undefined) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Markdown → Google Chat text
// ---------------------------------------------------------------------------

/**
 * Google Chat text messages understand a SMALL markdown subset:
 *
 *   *bold*   _italic_   ~strike~   `code`   ```block```   <url|label>
 *
 * and nothing else. Double asterisks render literally, `##` renders literally,
 * and a markdown table becomes a wall of pipes. Cortex writes ordinary markdown,
 * so everything it says is flattened through here before it reaches Chat.
 */
export function toChatText(
  markdown: string,
  opts?: { limit?: number; moreUrl?: string },
): string {
  const limit = opts?.limit ?? CHAT_TEXT_LIMIT;
  const source = (markdown ?? "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const out: string[] = [];

  let inFence = false;
  let table: string[] = [];
  const flushTable = () => {
    if (table.length === 0) return;
    out.push(...tableToBullets(table));
    table = [];
  };

  for (const line of lines) {
    // Fenced code survives verbatim — Chat renders ``` blocks as monospace.
    if (/^\s*```/.test(line)) {
      flushTable();
      inFence = !inFence;
      out.push(line.trim());
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    if (isTableRow(line)) {
      table.push(line);
      continue;
    }
    flushTable();

    const trimmed = line.trim();

    // Horizontal rules are visual noise in a chat bubble.
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      out.push("");
      continue;
    }

    // Headings become bold lines, with breathing room above the big ones.
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const text = inlineToChat(heading[2] ?? "");
      if (text) {
        if (level <= 2 && out.length > 0 && out[out.length - 1] !== "")
          out.push("");
        out.push(`*${text}*`);
      }
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const indent = " ".repeat(Math.min((bullet[1] ?? "").length, 8));
      out.push(`${indent}• ${inlineToChat(bullet[2] ?? "")}`);
      continue;
    }

    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      const indent = " ".repeat(Math.min((numbered[1] ?? "").length, 8));
      out.push(
        `${indent}${numbered[2] ?? ""}. ${inlineToChat(numbered[3] ?? "")}`,
      );
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      out.push(inlineToChat(quote[1] ?? ""));
      continue;
    }

    out.push(trimmed ? inlineToChat(trimmed) : "");
  }
  flushTable();

  // Chat renders every blank line, so collapse runs of them.
  const collapsed: string[] = [];
  for (const line of out) {
    if (line === "" && collapsed[collapsed.length - 1] === "") continue;
    collapsed.push(line);
  }
  const text = collapsed.join("\n").trim();
  return capForChat(text, limit, opts?.moreUrl);
}

/**
 * Trim to Chat's length ceiling on a line boundary, pointing at the full
 * version in Cortex rather than silently swallowing the tail.
 */
export function capForChat(
  text: string,
  limit = CHAT_TEXT_LIMIT,
  moreUrl?: string,
): string {
  if (text.length <= limit) return text;
  const base = (moreUrl ?? process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
  const tail = base
    ? `\n…\n<${base}|See the full report in Cortex>`
    : "\n…\n(See the full report in Cortex.)";
  const room = Math.max(0, limit - tail.length);
  const cut = text.slice(0, room);
  const lastBreak = cut.lastIndexOf("\n");
  return `${(lastBreak > room * 0.5 ? cut.slice(0, lastBreak) : cut).trimEnd()}${tail}`;
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 2;
}

const SEPARATOR_CELL = /^:?-{2,}:?$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Chat has no tables. One bullet per row — first column as the label, the rest
 * as `header: value` pairs — is the only shape that stays readable on a phone.
 */
function tableToBullets(rows: string[]): string[] {
  const cells = rows.map(splitRow);
  const headerIdx = cells.findIndex((_, i) =>
    cells[i + 1]?.every((c) => SEPARATOR_CELL.test(c)),
  );
  const header = headerIdx >= 0 ? (cells[headerIdx] ?? []) : [];
  const body = cells.filter(
    (row, i) => i !== headerIdx && !row.every((c) => SEPARATOR_CELL.test(c)),
  );
  if (body.length === 0) return [];

  return body.map((row) => {
    const label = inlineToChat(row[0] ?? "");
    const rest = row
      .slice(1)
      .map((value, i) => {
        const v = inlineToChat(value);
        if (!v) return "";
        const key = header[i + 1];
        return key ? `${inlineToChat(key)}: ${v}` : v;
      })
      .filter(Boolean);
    return rest.length > 0
      ? `• *${label}* — ${rest.join(" · ")}`
      : `• *${label}*`;
  });
}

/** Inline markdown → the Chat subset. */
function inlineToChat(s: string): string {
  return (
    s
      // Images carry nothing in a text message — drop them before links match.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(
        /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
        (_m, label: string, url: string) => {
          const clean = label.trim();
          return !clean || clean === url ? `<${url}>` : `<${url}|${clean}>`;
        },
      )
      // Chat has no bold+italic, so the strongest signal wins.
      .replace(/\*\*\*([^*]+)\*\*\*/g, "*$1*")
      .replace(/\*\*([^*]+)\*\*/g, "*$1*")
      .replace(/__([^_]+)__/g, "*$1*")
      .replace(/~~([^~]+)~~/g, "~$1~")
      .trim()
  );
}
