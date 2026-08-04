"use client";

import {
  type ChatDmStatus,
  type PreferencesView,
  TIMEZONES,
} from "@/app/api/settings/preferences/schema";
import { Button } from "@/components/ui/button";
import { Eyebrow, Panel } from "@/components/ui/panel";
import { clsx } from "clsx";
import {
  Check,
  Loader2,
  Mail,
  MessageCircle,
  Send,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/** A labelled switch — the same control the master opt-in and the channels use. */
function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-ink">{label}</div>
        {description && (
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">
            {description}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors",
          "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15",
          checked ? "bg-primary" : "bg-surface-2 border border-border",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <span
          className={clsx(
            "absolute top-1/2 h-[18px] w-[18px] -translate-y-1/2 rounded-full bg-white shadow-sm transition-[left]",
            checked ? "left-[23px]" : "left-[3px]",
          )}
        />
      </button>
    </div>
  );
}

export function SettingsForm({
  initial,
  chatDm,
}: {
  initial: PreferencesView;
  /** Resolved on the server from `google_chat_links` — see the page component. */
  chatDm: ChatDmStatus;
}) {
  const [prefs, setPrefs] = useState<PreferencesView>(initial);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [testStatus, setTestStatus] = useState<Status>({ kind: "idle" });
  const [testDmStatus, setTestDmStatus] = useState<Status>({ kind: "idle" });

  const set = <K extends keyof PreferencesView>(
    key: K,
    value: PreferencesView[K],
  ) => {
    setPrefs((p) => ({ ...p, [key]: value }));
    setStatus({ kind: "idle" });
  };

  async function save() {
    setStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/settings/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inboxDigestEnabled: prefs.inboxDigestEnabled,
          inboxDigestTime: prefs.inboxDigestTime,
          timezone: prefs.timezone,
          deliverEmail: prefs.deliverEmail,
          deliverChat: prefs.deliverChat,
          chatWebhookUrl: prefs.chatWebhookUrl,
          deliverChatDm: prefs.deliverChatDm,
          digestFocus: prefs.digestFocus,
        }),
      });
      const json = (await res.json()) as {
        preferences?: PreferencesView;
        error?: string;
      };
      if (!res.ok) {
        setStatus({
          kind: "error",
          message: json.error ?? "Could not save your settings.",
        });
        return;
      }
      if (json.preferences) setPrefs(json.preferences);
      setStatus({ kind: "saved" });
    } catch {
      setStatus({ kind: "error", message: "Could not reach the server." });
    }
  }

  async function sendTest() {
    setTestStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/settings/test-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl: prefs.chatWebhookUrl }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      setTestStatus(
        res.ok
          ? { kind: "saved" }
          : {
              kind: "error",
              message: json.error ?? "The test message did not go through.",
            },
      );
    } catch {
      setTestStatus({ kind: "error", message: "Could not reach the server." });
    }
  }

  /** No body: the route resolves the caller's own DM thread server-side. */
  async function sendTestDm() {
    setTestDmStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/settings/test-chat-dm", { method: "POST" });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      setTestDmStatus(
        res.ok
          ? { kind: "saved" }
          : {
              kind: "error",
              message: json.error ?? "The test message did not go through.",
            },
      );
    } catch {
      setTestDmStatus({
        kind: "error",
        message: "Could not reach the server.",
      });
    }
  }

  const on = prefs.inboxDigestEnabled;
  const dmReady = chatDm.configured && chatDm.linked;

  return (
    <div className="space-y-4">
      {/* ---- The opt-in, and exactly what it means ------------------------- */}
      <Panel className="p-5">
        <Toggle
          checked={on}
          onChange={(v) => set("inboxDigestEnabled", v)}
          label="Daily inbox digest"
          description="Once a day, Cortex reads your recent email and sends you a short summary: what is waiting on your reply, what you are waiting on from other people, and what is just worth knowing."
        />

        <div className="mt-4 rounded-[12px] border border-border bg-surface-2 p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <Eyebrow>What Cortex reads, and what it does not</Eyebrow>
          </div>
          <ul className="mt-2.5 space-y-1.5 text-[12.5px] leading-relaxed text-ink-muted">
            <li>
              <strong className="text-ink">Only your mailbox.</strong> Cortex
              reads the recent conversations in your own inbox — who wrote,
              when, the subject and the message content — using the Google
              access you already granted when you signed in. Nobody else&apos;s
              mail is ever involved.
            </li>
            <li>
              <strong className="text-ink">Summarized on our side.</strong> The
              messages are condensed on our servers into the digest you receive.
              The mail itself is never stored, never added to the Knowledge
              Base, and never handed to the assistant you chat with.
            </li>
            <li>
              <strong className="text-ink">Delivered only to you.</strong> The
              digest goes to your own email address, to a Google Chat space you
              set up yourself, or as a direct message from Cortex that only you
              can see. It is never shared with your team, your manager or anyone
              else.
            </li>
            <li>
              <strong className="text-ink">Newsletters are filtered out</strong>{" "}
              before anything is read closely, and each digest tells you what it
              left out and why.
            </li>
            <li>
              <strong className="text-ink">Off is off.</strong> Turn this switch
              off and Cortex stops reading your mail on a schedule, immediately.
            </li>
          </ul>
        </div>
      </Panel>

      {/* ---- When ---------------------------------------------------------- */}
      <Panel className={clsx("p-5 transition-opacity", !on && "opacity-55")}>
        <Eyebrow>When it arrives</Eyebrow>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="digest-time"
              className="mb-1 block text-xs font-medium text-ink-muted"
            >
              Time
            </label>
            <input
              id="digest-time"
              type="time"
              value={prefs.inboxDigestTime}
              disabled={!on}
              onChange={(e) => set("inboxDigestTime", e.target.value)}
              className="w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
          <div>
            <label
              htmlFor="digest-tz"
              className="mb-1 block text-xs font-medium text-ink-muted"
            >
              Time zone
            </label>
            <select
              id="digest-tz"
              value={prefs.timezone}
              disabled={!on}
              onChange={(e) => set("timezone", e.target.value)}
              className="w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz.value} value={tz.value}>
                  {tz.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="mt-2 text-[12px] text-ink-faint">
          Cortex checks every half hour, so the digest lands within 30 minutes
          of the time you pick.
        </p>
      </Panel>

      {/* ---- Where --------------------------------------------------------- */}
      <Panel className={clsx("p-5 transition-opacity", !on && "opacity-55")}>
        <Eyebrow>Where it goes</Eyebrow>

        <div className="mt-3 space-y-4">
          <div className="rounded-[12px] border border-border p-4">
            <Toggle
              checked={prefs.deliverEmail}
              disabled={!on}
              onChange={(v) => set("deliverEmail", v)}
              label="Email"
              description={`Sent to ${prefs.email}`}
            />
            <div className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-faint">
              <Mail className="h-3.5 w-3.5" />
              This is the address on your Cortex account and cannot be changed
              here.
            </div>
          </div>

          <div className="rounded-[12px] border border-border p-4">
            <Toggle
              checked={prefs.deliverChat}
              disabled={!on}
              onChange={(v) => set("deliverChat", v)}
              label="Google Chat — a space"
              description="Posted into a space you choose, through a webhook you create yourself. Everyone in that space can read it."
            />

            <div className="mt-3">
              <label
                htmlFor="chat-webhook"
                className="mb-1 block text-xs font-medium text-ink-muted"
              >
                Webhook URL
              </label>
              <input
                id="chat-webhook"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://chat.googleapis.com/v1/spaces/…/messages?key=…&token=…"
                value={prefs.chatWebhookUrl}
                disabled={!on}
                onChange={(e) => {
                  set("chatWebhookUrl", e.target.value);
                  setTestStatus({ kind: "idle" });
                }}
                className="w-full rounded-[10px] border border-border bg-surface px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
              />

              <ol className="mt-2.5 space-y-1 text-[12px] leading-relaxed text-ink-muted">
                <li>
                  1. In Google Chat, open the space you want the digest in.
                </li>
                <li>
                  2. Click the space name →{" "}
                  <strong className="text-ink">Apps &amp; integrations</strong>.
                </li>
                <li>
                  3. Choose <strong className="text-ink">Webhooks</strong> →{" "}
                  <strong className="text-ink">Add webhook</strong>, name it
                  &ldquo;Cortex&rdquo;.
                </li>
                <li>4. Copy the whole URL it gives you and paste it above.</li>
              </ol>
              <p className="mt-2 text-[12px] text-ink-faint">
                Anyone in that space will see your digest — put it in a space
                that is just yours if you would rather keep it private.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    !on || !prefs.chatWebhookUrl || testStatus.kind === "saving"
                  }
                  onClick={sendTest}
                >
                  {testStatus.kind === "saving" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <MessageCircle className="h-3.5 w-3.5" />
                  )}
                  Send test message to the space
                </Button>
                {testStatus.kind === "saved" && (
                  <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-emerald">
                    <Check className="h-3.5 w-3.5" />
                    Sent — check the space.
                  </span>
                )}
                {testStatus.kind === "error" && (
                  <span className="flex items-start gap-1.5 text-[12.5px] text-rose">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {testStatus.message}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* ---- Google Chat, privately ------------------------------------ */}
          <div className="rounded-[12px] border border-border p-4">
            <Toggle
              checked={prefs.deliverChatDm}
              disabled={!on || !chatDm.configured}
              onChange={(v) => {
                set("deliverChatDm", v);
                setTestDmStatus({ kind: "idle" });
              }}
              label="Google Chat — direct message"
              description="Cortex sends the digest straight to you in Google Chat. Nobody else is in that conversation — and the routines you own arrive there too."
            />

            <div className="mt-3">
              {/* The link status is the whole point of this block: without it,
                  the toggle is a checkbox that can silently do nothing. */}
              {!chatDm.configured ? (
                <div className="flex items-start gap-2 rounded-[10px] border border-border bg-surface-2 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-muted">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    The Cortex Chat app is not set up on this environment yet,
                    so direct messages cannot be sent. Ask an aCortexo enable
                    it.
                  </span>
                </div>
              ) : dmReady ? (
                <div className="flex items-start gap-2 rounded-[10px] border border-border bg-emerald-soft px-3 py-2.5 text-[12.5px] leading-relaxed text-emerald">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Connected as{" "}
                    <strong className="font-semibold">
                      {chatDm.displayName ?? prefs.email}
                    </strong>{" "}
                    — messages will arrive in your Cortex chat.
                  </span>
                </div>
              ) : (
                <div className="rounded-[10px] border border-border bg-amber-soft px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-muted">
                  <div className="flex items-start gap-2 font-medium text-amber">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Not connected yet — nothing can be delivered here.
                    </span>
                  </div>
                  <p className="mt-1.5 pl-[22px]">
                    Cortex can only write in a conversation you started. Open
                    Google Chat, search for{" "}
                    <strong className="text-ink">Cortex</strong>, say hi — then
                    refresh this page.
                  </p>
                </div>
              )}

              <p className="mt-2 text-[12px] text-ink-faint">
                This is the private option: unlike the space above, the digest
                goes only to you.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!on || !dmReady || testDmStatus.kind === "saving"}
                  onClick={sendTestDm}
                >
                  {testDmStatus.kind === "saving" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  Send test DM
                </Button>
                {testDmStatus.kind === "saved" && (
                  <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-emerald">
                    <Check className="h-3.5 w-3.5" />
                    Sent — check your Cortex chat.
                  </span>
                )}
                {testDmStatus.kind === "error" && (
                  <span className="flex items-start gap-1.5 text-[12.5px] text-rose">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {testDmStatus.message}
                  </span>
                )}
              </div>

              {prefs.deliverChatDm && chatDm.configured && !chatDm.linked && (
                <p className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-amber">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  You can save this now, but the digest will not reach Google
                  Chat until you have said hi to Cortex there.
                </p>
              )}
            </div>
          </div>
        </div>
      </Panel>

      {/* ---- Focus --------------------------------------------------------- */}
      <Panel className={clsx("p-5 transition-opacity", !on && "opacity-55")}>
        <Eyebrow>What matters to me</Eyebrow>
        <p className="mt-1.5 text-[12.5px] text-ink-muted">
          Tell Cortex how to rank your morning. Written in your own words — it
          is used to order the digest, not to decide what gets read.
        </p>
        <textarea
          value={prefs.digestFocus}
          disabled={!on}
          maxLength={600}
          rows={3}
          onChange={(e) => set("digestFocus", e.target.value)}
          placeholder="Clients first, then anything about open roles. Internal newsletters can go to the bottom."
          className="mt-2.5 w-full resize-y rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="mt-1 text-right text-[11px] text-ink-faint">
          {prefs.digestFocus.length}/600
        </div>
      </Panel>

      {/* ---- Save ---------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-3 pb-2">
        <Button
          type="button"
          onClick={save}
          disabled={status.kind === "saving"}
        >
          {status.kind === "saving" && (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          )}
          Save settings
        </Button>
        {status.kind === "saved" && (
          <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-emerald">
            <Check className="h-3.5 w-3.5" />
            Saved.
          </span>
        )}
        {status.kind === "error" && (
          <span className="flex items-start gap-1.5 text-[12.5px] text-rose">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {status.message}
          </span>
        )}
      </div>
    </div>
  );
}
