# Cortex as a Google Chat app — setup runbook

This turns Cortex into a real Google Chat app: people DM it, @mention it in team
spaces, and it can message them proactively (approvals, scheduled routine
results). It answers with the same brain, the same tools, and the same audit
trail as Zipdev OS.

Audience: a Google Workspace admin. You do not need to read any code.

Endpoint (production): `https://cortex-zipdev.vercel.app/api/chat-app/google`

---

## 0. Environment variables

Set these in Vercel (Project → Settings → Environment Variables), for
**Production** and **Preview**.

| Variable | Required | What it is | Example / where it comes from |
| --- | --- | --- | --- |
| `GOOGLE_CHAT_AUDIENCE` | **Yes** | The Google Cloud **project number** of the project hosting the Chat app. Every request Google Chat sends is a signed token whose audience is this value; the endpoint rejects anything else. Comma-separate to accept more than one (e.g. a project number *and* a custom audience URL). | `105834691535` (project `zipdev-matching`) — see §2, step 6 |
| `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` | **Yes** | The service-account key the app uses to POST messages back into Chat. Accepts the raw JSON **or** base64 of it (base64 is strongly preferred in Vercel — a PEM with newlines does not survive the UI well). | base64 of the key for `zipdev-backend@zipdev-matching.iam.gserviceaccount.com` — see §3 |
| `APP_BASE_URL` | Yes (already set) | Used for the `/approvals` link and the "see the full report in Zipdev OS" link when an answer exceeds Chat's length limit. | `https://cortex-zipdev.vercel.app` |
| `RESEND_API_KEY` | Optional (already set) | Email fallback when a sensitive answer has to leave a space but the person has no DM open with Cortex yet. | Resend dashboard |

> **Missing `GOOGLE_CHAT_AUDIENCE` in production means every Chat request is
> rejected with 401.** That is deliberate: without an expected audience, a token
> minted for somebody else's Chat app would pass a signature check. Outside
> production (local dev, tunnels) an unset audience logs a loud warning and
> accepts the request so you can test before the app exists.

---

## 1. Google Cloud project — enable the API

1. Open <https://console.cloud.google.com/> and select the project that will own
   the Chat app (ours: **zipdev-matching**).
2. **APIs & Services → Library** → search "Google Chat API" → **Enable**.

---

## 2. Configure the Chat app

**APIs & Services → Google Chat API → Configuration** (or directly:
<https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat>).

Fill in exactly:

| Field | Value |
| --- | --- |
| **App name** | `Cortex` |
| **Avatar URL** | `https://cortex-zipdev.vercel.app/icon.png` |
| **Description** | `Zipdev's agent. Ask about the pipeline, candidates, rates, tickets and the Knowledge Base — answered with your own permissions.` |

**Functionality** — tick BOTH:

- ☑ **Receive 1:1 messages** — lets people DM Cortex.
- ☑ **Join spaces and group conversations** — lets people add Cortex to a team
  space and @mention it there.

**Connection settings**:

- Select **HTTP endpoint URL**.
- URL: `https://cortex-zipdev.vercel.app/api/chat-app/google`
- (Not "Cloud Pub/Sub", not "Dialogflow", not "Apps Script".)

**Slash commands** (optional — a plain @mention always works without these).
Add three, each of type *Slash command*, pointing at the same endpoint:

| Name | Command ID | Description |
| --- | --- | --- |
| `/ask` | `1` | Ask Cortex anything |
| `/brief` | `2` | Short briefing: three bullets, numbers first |
| `/report` | `3` | Structured report: verdict, numbers, risks |

**Where to find the project number** for `GOOGLE_CHAT_AUDIENCE`:
Google Cloud Console → click the project picker → the **Project number** column,
or **IAM & Admin → Settings → Project number**. It is a 12-digit number, *not*
the project ID (`zipdev-matching`).

Click **Save**.

---

## 3. Service account for outbound messages

Cortex replies asynchronously and messages people proactively, so it needs to
call the Chat API as itself.

1. **IAM & Admin → Service Accounts → Create service account**.
   - Name: `zipdev-backend` (ours already exists:
     `zipdev-backend@zipdev-matching.iam.gserviceaccount.com`).
2. **Grant this service account access to project: SKIP IT.** Do not assign any
   IAM role. The Chat app's identity and permissions come from the Chat API
   configuration in §2, not from project IAM. An unnecessary role here is pure
   blast radius.
3. Skip "Grant users access to this service account" too.
4. Open the service account → **Keys → Add key → Create new key → JSON**. The
   file downloads once; there is no second chance.
5. Base64-encode it and paste the result into
   `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` in Vercel:

   ```bash
   base64 -w0 zipdev-matching-xxxxx.json      # Linux
   base64 -i zipdev-matching-xxxxx.json       # macOS
   ```

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("zipdev-matching-xxxxx.json"))
   ```

   Raw JSON also works if you prefer it; the app detects which form it got.
6. Delete the downloaded key file from your laptop.
7. Redeploy so the new environment variables take effect.

The app requests exactly one scope: `https://www.googleapis.com/auth/chat.bot`.

---

## 4. Visibility — publish internally

Still on the Chat API **Configuration** page:

1. **Visibility** → tick **Make this Chat app available to specific people and
   groups in <your domain>** and enter `zipdev.com`, **or** choose the
   organization-wide option to publish to everyone in the domain.
2. **App status** → **LIVE — available to users**.
3. Click **Save**.

**A Workspace admin must approve/deploy it for the organization.** In the
[Google Admin console](https://admin.google.com) → **Apps → Google Workspace →
Google Chat → Manage Chat apps**, find **Cortex** and set it to **Allowed** for
the organization (or for the specific OUs that should have it). Until this is
done, most people will not find Cortex when they search for it in Chat.

---

## 5. Adding Cortex to a team space

Anyone in the domain can do this once the app is live:

1. Open the space in Google Chat.
2. Space name → **Apps & integrations → Add apps** → search `Cortex` → **Add**.
3. Cortex posts a short greeting explaining how it works in a space.

In a space, **Chat only notifies the app when it is @mentioned** — Cortex does not
read the room's other messages, and cannot. Ask it something with
`@Cortex how many open reqs does Acme have?`.

---

## 6. How it behaves (read this before rolling it out)

**Identity is per-person.** The actor is always the *sender*, matched to a Zipdev
OS account by their work email. Tools run with that person's own integrations
and team permissions, and every audit row is attributed to them. Two people can
@mention Cortex with the same question in the same space and get different
answers — that is correct, not a bug. Someone without a Zipdev OS account gets a
polite refusal and nothing runs.

**Cortex acknowledges, then answers.** Google Chat gives an app about 5 seconds to
respond, and a real Cortex turn (retrieval plus up to twelve tool steps) takes
longer. So it replies "On it ⚡" immediately and posts the finished answer into
the same thread a few seconds later. That is expected behaviour, not a stall.

### The DM-redirect privacy rule ← the important one

A group space is a **broadcast**. Every individual permission can check out and
the answer can still be a leak.

> Someone asks in `#hiring-latam` (eight people): **"@Cortex what's María's pay
> rate?"** The asker is a manager and is fully entitled to that number. The other
> seven are not. Posting it in the space discloses a colleague's compensation to
> seven people who never had that access.

So in a **space** (never in a DM), when a turn touches:

- a **financial** family — `payroll.*`, `rate.*`
- a **PII-heavy** family — `recruit.*`, `workable.*`, `people.*`, `gmail.*`
- or anything the security classifier rates **high** or **critical**

…Cortex does **not** paste the answer into the space. It posts a short note in
the thread —

> *That one carries compensation data, so I sent it to you directly ⚡*

— and delivers the real answer to the sender's **DM**. If that person has never
opened a DM with Cortex, it falls back to **email** rather than posting or
dropping it.

Ordinary answers (HubSpot, Linear, GitHub, the Knowledge Base, the web,
aggregates and rollups) post normally in the space.

### Approvals in a space

Anything that writes to a real system (sending an email, moving a candidate,
posting to Slack, creating a deal) never runs on the first ask. In a space, the
approval request goes **only to the requester** — as a Chat DM and an email
pointing at `/approvals` — because nobody else in the room should be able to act
on it. In the thread, Cortex only says that it needs their approval and that the
request has been sent to them.

### Where the conversation shows up

Every Chat exchange is stored as an ordinary Zipdev OS conversation, so it
appears in **Conversations** alongside web and Claude sessions. A DM is one
continuous conversation per person; each thread in a space is its own
conversation, titled after the space.

---

## 7. Verification

Do these in order after deploying.

1. **DM the app.** In Google Chat, search for `Cortex` → start a direct message.
   Adding it should produce the greeting paragraph ("Hi — I'm Cortex ⚡ …").
   *If nothing appears, the app is not live or not approved for your OU (§4).*
2. **Ask something read-only.** e.g. `what do we know about Acme?` You should see
   `On it ⚡` within a second or two, then the real answer a few seconds later.
3. **Check Zipdev OS.** Open `https://cortex-zipdev.vercel.app/conversations` —
   the exchange should be there, titled `Chat · <your name>`.
4. **Check the audit log.** `…/admin` → audit log. The tool calls must appear
   under **your** name, not a service account, with the tools you'd expect.
5. **Add it to a space** (§5) and `@Cortex` something ordinary — the answer should
   post in the thread.
6. **Test the privacy rule.** In the same space, ask something that hits payroll
   or a candidate profile. The space should get the short redirect note, and the
   full answer should arrive in your DM with Cortex.
7. **Test an approval.** Ask it to draft and send an email. It must not send:
   you should get an approval DM plus an email, and `/approvals` should list the
   pending action.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Chat shows **"Cortex isn't responding"** and nothing arrives | The endpoint returned 401. Almost always `GOOGLE_CHAT_AUDIENCE` missing or wrong. | Confirm it is the **project number** (12 digits), not the project ID. Check Vercel logs for `google-chat: rejected an unverified request`. |
| 401s that started suddenly, having worked for months | Google rotated the signing certificates and the fetch failed. | The endpoint caches certs for an hour and refetches on an unknown key id; a persistent failure means outbound network trouble. Check logs for `could not fetch signing certificates`. |
| **"Cortex isn't responding"** but the answer shows up seconds later anyway | Normal. This is the acknowledge-then-answer pattern (§6) and Chat occasionally races it. | Nothing to fix. |
| Ack arrives (`On it ⚡`) but the real answer never does | Outbound is broken: `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` unset, malformed, or the key was revoked. | Re-create the key (§3). Look for `google-chat: token exchange failed` or `could not post the answer` in the logs. |
| *"I don't see a Zipdev OS account for your address"* | The sender's Chat email has no matching Zipdev OS user. | Create the user in Zipdev OS with the same address, then message Cortex again. |
| *"Google Chat isn't sharing your work address"* | An external / consumer account, or an app not restricted to the domain. | This app is for `zipdev.com` accounts only. Check the visibility settings in §4. |
| Answers get cut off with *"See the full report in Zipdev OS"* | Google Chat hard-caps messages at ~4096 characters. | Expected. Follow the link, or ask for a shorter answer (`/brief`). |
| Cortex ignores messages in a space | In spaces, Chat only delivers messages that **@mention** the app. | @mention it. If mentions still do nothing, "Join spaces and group conversations" is unticked in §2. |
| A sensitive answer keeps going to DM when you wanted it in the room | Working as designed — see the DM-redirect rule in §6. | Ask for an aggregate instead (totals, counts, ranges), which posts normally. |
| Chat replies land in a new thread instead of under the question | The originating thread was deleted, or the message came from a very old client. | Cosmetic; the reply still reaches the space. |

---

## 9. What this does NOT do

- It does **not** read messages in a space that don't @mention it.
- It does **not** act with a shared or elevated identity — no sender, no answer.
- It does **not** execute writes without an explicit approval from the requester.
- It is **not** the same thing as the per-user Chat *webhook* delivery used for
  inbox digests (Space → Apps & integrations → Webhooks). That one needs no
  admin setup and posts into a single space; this one is the actual app.
