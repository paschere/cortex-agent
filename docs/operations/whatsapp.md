# WhatsApp

Cortex can do three things with WhatsApp:

1. **Read the company's groups and feed them into Brain Knowledge.** This is the
   main one. Half of a Colombian operation happens in WhatsApp groups —
   dispatch coordination, incidents with clients, warehouse problems — and today
   none of it survives the scroll. Archived groups become documents you can
   search and quote months later, with who said each thing and when, exactly
   like a Google Meet call.
2. **Talk to the agent by direct message.** You write to it and it answers with
   the same tools and the same memory as the web.
3. **Answer in a group when somebody @mentions it.** Only then. Without a
   mention it stays exactly as silent as it was before.

It never writes first. Not in a group, not in a chat, not ever.

---

## ⚠️ Read this first

**Baileys is an unofficial client. WhatsApp can ban the number.**

There is no official API for reading a group you belong to. The only way in is a
client that speaks the protocol, and WhatsApp does not sanction that. It is
widely used and reading emits far fewer signals than sending, but the risk is
real and it is not something we can engineer away.

So:

- **Use a dedicated company number.** Never anybody's personal line. If it gets
  banned, the person loses their own WhatsApp account.
- A cheap prepaid SIM or a virtual number that can receive a verification SMS is
  enough. It only needs to receive that one code and then stay linked.
- The bridge **never starts a conversation**. It replies in a 1:1 only where the
  other person wrote first, and in a group only when somebody @mentions it. It
  does not greet, announce itself, follow up, react, or speak because a keyword
  appeared. That is deliberate: the behaviour that gets numbers banned is
  unsolicited outbound.
- **Writing in groups raises the risk above read-only.** Every message is still
  a direct answer to somebody who asked for it by tapping the name, which is
  what makes it defensible — but it is more exposure than archiving alone, and
  there is a per-group hourly ceiling to keep it from becoming a stream. If you
  want the memory without the exposure, archive the group and leave answering
  off; they are separate switches.
- If the number is banned: everything already archived is safe (they are
  ordinary Brain Knowledge documents). Get a new number, pair it, and the group
  choices are still there.

---

## How it is put together

```
  WhatsApp  ──ws──  services/whatsapp  ──https──  Cortex (Vercel)  ──  Postgres
                    (Railway)                     /api/whatsapp/bridge/*
```

**Why two pieces.** Baileys holds an authenticated WebSocket open for days.
Vercel cannot do that: a serverless invocation ends and takes the socket, the
session and everything with it. So the socket lives in a small persistent
service on Railway, and everything it hears it POSTs to Cortex. The bridge holds
no database credentials — every decision (which groups are archived, who a
number belongs to, where a document lands) is made and enforced in Cortex.

**The session lives in Postgres, not on disk.** Baileys' default writes JSON
files, and Railway's filesystem is wiped on every deploy — which would mean
re-scanning the QR every time the service ships. That is the classic Baileys
frustration and it is fixed here: credentials and signal keys are stored in
`whatsapp_sessions` / `whatsapp_session_keys`, read once at boot and cached in
memory. **A deploy, a crash or a rebuild does not require re-pairing.**

---

## Deploying on Railway

The team already uses Railway, so this is a second service in the same project.

### 1. Set the shared secret in Cortex

```bash
openssl rand -base64 32
```

Add it in Vercel as `WHATSAPP_BRIDGE_TOKEN` and redeploy. Until it is set, every
`/api/whatsapp/bridge/*` route refuses — which is the correct default.

### 2. Create the service

- **New service → GitHub repo →** this repository.
- **Settings → Root Directory:** `/` (the repo root — the Dockerfile needs the
  workspace manifest and lockfile).
- **Settings → Config as code:** `services/whatsapp/railway.json`.

That file already sets the Dockerfile path, the `/health` check and, critically,
`numReplicas: 1`.

> **Never scale this past one replica.** Two containers holding the same
> WhatsApp session fight over it and WhatsApp will drop both. This is not a
> service that scales horizontally; it is one phone.

### 3. Variables on the Railway service

| Variable | Value |
|---|---|
| `CORTEX_BASE_URL` | The public https origin of Cortex, e.g. `https://app.cortex.example` |
| `WHATSAPP_BRIDGE_TOKEN` | **The same value** you put in Vercel |
| `WHATSAPP_ORGANIZATION_ID` | The workspace id (`ba_organization.id`) this number belongs to |

Optional tuning is listed in `.env.example`; the defaults are fine.

### 4. Run the migration

```bash
pnpm db:push     # or apply infra/supabase/migrations/0068_whatsapp.sql
```

### 5. Deploy

Watch the logs. On a first boot you should see:

```
no stored session; this boot will need a QR scan
```

---

## Pairing, the first time

1. Open **Cortex → WhatsApp** (in the sidebar, under Connections). The status
   will say *Esperando el emparejamiento* and show a QR code.
2. On the **dedicated phone**, open WhatsApp → **Dispositivos vinculados** →
   **Vincular un dispositivo**.
3. Scan the code on the Cortex screen. It refreshes on its own every few
   seconds, so a code that expires is not a problem — wait for the next one.
4. The screen turns green (*Conectado*) with the number.

**Two other ways to get the code**, for when Cortex is not reachable:

- It is printed as ASCII in the service logs: `railway logs`.
- `GET https://<the-railway-domain>/qr?token=<WHATSAPP_BRIDGE_TOKEN>` renders it
  as a page you can point a camera at.

**You should only ever do this once.** If you find yourself scanning a QR after
every deploy, the session is not being stored — check `CORTEX_BASE_URL` and the
token, because the bridge refuses to start with an empty session when it cannot
read the stored one (precisely so a network blip does not silently discard a
working pairing).

---

## The two group permissions

Every group has **two independent switches** on the Cortex → WhatsApp screen,
and neither implies the other:

| | What it does | What it risks |
|---|---|---|
| **Archivar** | The conversation becomes searchable documents in Brain Knowledge | Disclosure *inside* the company — everyone who can read the space can read the group |
| **Responder si lo mencionan** | Cortex replies in the group when @mentioned | Disclosure *outside* the company — clients and suppliers in the room read the answer |

A client group is very often one you want archived and never want the agent
talking in. An internal coordination group is often the reverse. Choose them
separately, per group.

## Choosing which groups are archived

Nothing is archived by default. Groups appear on the Cortex → WhatsApp screen a
few seconds after the number connects (it lists the groups the account is in —
their names and headcount, nothing that was said in them).

For each group you want:

1. Pick the **Brain Knowledge space** the conversations go into.
2. Press **Archivar**.

Some things worth knowing before you do:

- **It starts now.** Switching a group on never reaches backwards. Two years of
  history that nobody was told was being archived stays unarchived.
- **The space is the permission.** Everyone who can read that space can read
  those conversations. Putting a client's group into a company-wide space
  publishes it to the whole company — which is why only an org admin can choose
  a company-wide space, and why it has to be chosen per group rather than once.
- **Turning it off is immediate** and leaves what was already saved alone. Those
  are ordinary documents now; delete them from Brain Knowledge if you want them
  gone.
- Direct messages between a person and Cortex are **never** archived. They are
  that person's conversation, and they show up in their own chat history like
  any other Cortex conversation.

### What a group becomes

Not one document per message — a message is not a document. Messages are grouped
into **conversation windows**: a window opens with a message and closes after 45
minutes of silence, and never crosses local midnight or runs longer than eight
hours. A WhatsApp group bursts around an event and then goes quiet, so the
window is the episode, and the episode is what somebody looks for later.

Each window becomes one document whose first passage names the group, the date,
the time span and who took part, and whose passages each carry who wrote them
and how far into the conversation. Re-reading the same window updates the
document instead of making a second one.

- **Voice notes** are transcribed with Deepgram (the key Cortex already uses)
  and appear as that person's words, marked 🎤. The audio is not kept.
- **Images and video** appear as a marker plus their caption. The caption is
  indexed; there is no vision pipeline, so storing the pixels would buy nothing.
- **Files** — PDF, Word, plain text, CSV — are saved as their own Brain
  Knowledge document in the same space, and the conversation notes that they
  were. A supplier's invoice shared in a group is exactly what should end up in
  the company's memory.

---

## Letting Cortex answer in a group

Press **Dejar que responda** on the group and pick what it may reach for. The
screen states each option in words and shows the current one on every group.

### What counts as being mentioned

- ✅ **A real @mention** — you type `@` and pick Cortex from WhatsApp's list.
  This is the one that matters.
- ✅ **A reply to something Cortex said** — quote its message and write
  underneath. This is how you ask a follow-up without re-tagging.
- ❌ **Just typing the name** — "cortex, mira esto" does **nothing**, on purpose.
  "Yo le pregunto a Cortex y te cuento" is a sentence people say to each other
  constantly, and a bot that answers it has interrupted a conversation between
  two humans in a room with a client in it. A missed mention costs one tap; a
  false one cannot be taken back.

### What it may reach for — pick per group

| Scope | What Cortex can use to answer |
|---|---|
| **Solo la conversación** (default) | The messages in the group and nothing else. It summarises what was agreed, translates, does the arithmetic, drafts the message. **It cannot reach a single company system**, so nothing it says can come from one. |
| **Conversación + un espacio** | The above, plus read-only Brain Knowledge — limited to **one company-wide space you choose**. Personal spaces can never be cited in a group; the option is not offered and would be refused if it were. |
| **Grupo interno** | The above, plus the asker's read-only work tools. **Only for groups with no clients or suppliers in them.** |

Payroll, personal data, candidate records and Gmail are unreachable from a
group at **every** scope, including the widest one.

On top of that, if an answer still turns out to touch something sensitive,
Cortex says so in the group **without the content** and sends the detail to the
person who asked — by WhatsApp if they have written to it before, by email
otherwise. Useful without leaking.

### Who can trigger it

The same rule as direct messages: **a number that is not linked to a Cortex
person cannot make Cortex run anything.** A stranger in the group who taps the
name gets one short line saying it only answers registered people — said once
per person per day, so it never becomes noise — and no tool, no lookup and no
model run happens at all.

### Noise and loops

- One reply per mention, ever. WhatsApp re-delivers messages; Cortex does not
  re-answer them.
- A ceiling of **10 replies per group per hour** by default. Past it Cortex goes
  quiet rather than announcing that it has gone quiet.
- It never replies to itself or to another bot.
- It answers with a short human delay and the "escribiendo…" indicator, and the
  reply quotes the message that mentioned it, so it is obvious what is being
  answered.

### Approvals

Same as in a direct message and for a stronger reason: a group has nowhere to
show an Approve/Decline card and nobody in it has authority over somebody else's
approval. So **nothing that needs approval is ever run from a group.** It is
staged, the card goes to the person who asked by email and Google Chat, and
Cortex says one line in the group saying it is waiting.

## Linking numbers to people

A direct message runs real tools — payroll, HubSpot, Brain Knowledge — so it
runs **as a person**, with their integrations, their permissions and their name
in the audit log. A number nobody has linked gets a short refusal, the attempt is
recorded on the Security page, and nothing runs. There is no anonymous mode.

On **Cortex → WhatsApp → Quién puede escribirle** (org admins only):

1. Type the number with its country code: `+57 300 111 2233`.
2. Pick the person.
3. **Vincular.**

Removing a link takes effect on the next message.

There is deliberately no self-service "verify my number" flow: it would rest on
possession of a phone, and the prize here is an agent that can already reach
payroll and the CRM.

### Approvals

Tools that need approval are **never run from WhatsApp** and WhatsApp has
nowhere to draw an Approve/Decline card. So the request is staged anyway and the
card reaches the person by email and by Google Chat DM; WhatsApp says in one
line what it was about to do and that it is waiting. Approve it there or on
`/approvals`. Auto-approving because the channel is inconvenient would make
"needs approval" mean "needs approval unless you ask from your phone".

---

## When something goes wrong

### The screen says "El servicio no está reportando"

The bridge has not checked in for three minutes. It is a Railway problem, not a
WhatsApp one. `railway logs`, check the deploy is running. **Nothing already
archived is lost** and no messages sent while it is down are archived — WhatsApp
delivers a short backlog on reconnect, so a brief outage usually self-heals.

### The screen says "WhatsApp cerró la sesión"

Somebody unlinked the device from the phone, or WhatsApp did. The stored
credentials are dead; the bridge wipes them, deliberately does **not** retry in a
loop (hammering a logged-out account is the fastest way to get flagged), and
comes back once after a few minutes showing a fresh QR. Re-pair as above. Your
group choices and everything archived are untouched.

### The screen says "Sin conexión"

The service is up but cannot reach WhatsApp. It is already retrying with
exponential backoff and will recover on its own. If it persists for more than an
hour, check whether the number still works in the WhatsApp app itself — this is
what a ban looks like from here.

### A group is not appearing

The list refreshes when the number connects and when groups change. Make sure
the dedicated number is actually a **member** of the group — Cortex can only see
what that account can see. Then wait one heartbeat (30 s) and reload.

### Cortex is not answering when we mention it

Check, in order: is **Responder si lo mencionan** on for that group; did you use
a real @mention (picking it from WhatsApp's list) rather than just typing the
name; is the mentioning person's number **linked** on this screen; and has the
group already had its 10 replies this hour. All four are visible on the Cortex →
WhatsApp screen.

### Cortex answered "te lo mandé por interno" and nothing else

That is the privacy guard working. The answer touched something that should not
be read by everyone in that room, so it went to the person who asked — their
WhatsApp chat with the number if they have one, their email otherwise.

### A group is archiving but no documents appear

Conversations only become documents once they finish — 45 minutes of silence.
A group that is talking continuously will not produce a document until it
pauses. Check `whatsapp_messages` for staged rows; if they are there, the
messages arrived and are simply waiting.

### Voice notes come through as "[voice note — not transcribed]"

`DEEPGRAM_API_KEY` is missing or the account has no balance. Everything written
is still archived. Fix the key; already-stored notes are not retried
automatically.

### Somebody asks "did you archive my group?"

The Cortex → WhatsApp screen answers exactly that: which groups are being
archived, into which space, and since when. Turning one off takes one click.

---

## Related

- `infra/supabase/migrations/0068_whatsapp.sql` — the tables, and the reasoning
  behind the grouping rule and the mandatory destination space.
- `infra/supabase/migrations/0072_whatsapp_mentions.sql` — why answering and
  archiving are separate permissions, and the three layers that stop a group
  reply leaking.
- `packages/agent-tools/src/whatsapp/windows.ts` — why conversations are grouped
  the way they are.
- `packages/agent-tools/src/whatsapp/mentions.ts` — what counts as a mention and
  what each scope may reach for.
- `packages/agent-tools/src/whatsapp/group-reply.ts` — the order of the gates
  between a mention and an answer.
- `packages/agent-tools/src/whatsapp/media.ts` — what happens to voice notes,
  images and files.
- `services/whatsapp/src/socket.ts` — the reconnection policy and what the
  account will and will not do.
- `docs/operations/google-chat-app.md` — the other messaging surface; the agent
  turn itself is shared code.
