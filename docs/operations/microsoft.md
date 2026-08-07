# Microsoft 365 (Outlook mail and calendar)

This document is written to be handed to a customer's IT department. It says
exactly what Cortex asks Microsoft for, why each permission exists, what an
administrator has to approve, and what happens if they approve nothing.

---

## What Cortex does with Microsoft 365

Each person connects **their own** mailbox and calendar. Once connected, Cortex
can:

- **Search their mail** — by sender, subject, date, or free text.
- **Read a full thread** — every message in order, with who wrote it and when.
- **Draft a reply** — a draft that sits in their own Drafts folder. Nothing is
  sent by drafting.
- **Send a draft they approved** — the one action in the whole integration that
  puts something outside the company, and it requires an explicit confirmation
  every single time.
- **Read their calendar** — what is in a window of time, with attendees.
- **Create an event** — with attendees and, optionally, a Teams link.
- **Archive a client thread into Brain Knowledge** — so correspondence with a
  client or supplier can be searched and quoted months later. **Internal mail is
  never archived**; see "What Cortex will not do" below.

It is the same capability set the Google integration has had, for the customers
who run Outlook instead.

---

## Why delegated permissions, and not application permissions

**This is the most important paragraph in this document.** Read it before
approving anything, and push back if any vendor asks you for the other kind.

Microsoft Graph offers two ways to reach a mailbox:

| | **Application permissions** | **Delegated permissions** ← what Cortex uses |
|---|---|---|
| Whose mail can be read | **Every mailbox in the tenant** | Only the mailbox of the person who signed in |
| Who authorises | One administrator, once | Each person, for themselves |
| Who is in the loop | Nobody | The mailbox owner |
| How an individual opts out | They cannot | They disconnect, or you revoke them |
| What a leaked credential costs | The whole company's mail | One person's mail, until it is revoked |

Cortex asks for **delegated permissions only**. Every call it makes to Microsoft
Graph is against `/me` — the URL cannot address anybody else's mailbox — with a
token that a named person granted for their own account. There is no
client-credentials flow in the codebase, no `/users/{id}` call, and nothing in
the product that could read a mailbox nobody connected.

We are explicit about this because the alternative is genuinely easier to build
— there is no per-user connect flow to write — and it is the arrangement that
should stop a security review. "The vendor can read everyone's mail because
somebody clicked approve in 2026" is a breach of the entire company rather than
of one account, and nobody inside the company can see whose mail was read.

**Consequence for you:** if you look at the app registration and see application
permissions granted, they were not granted by us and Cortex is not using them.
Remove them.

---

## The exact permissions requested

All of these are **Delegated** Microsoft Graph permissions.

| Permission | What it lets Cortex do | Why it is needed | Can you withhold it? |
|---|---|---|---|
| `Mail.Read` | Read and search messages in the signed-in user's mailbox | The whole read half: search, list threads, read a thread, archive a client thread | No — without it there is no mail integration at all |
| `Mail.ReadWrite` | Create and edit drafts in the signed-in user's own mailbox | Drafting a reply. A draft delivers nothing; it sits in that person's Drafts folder until they act | **Yes.** Withhold it and Cortex can read and search mail but cannot compose |
| `Mail.Send` | Send a message from the signed-in user's mailbox | Sending a draft the person has already read and approved | **Yes.** Withhold it and Cortex can prepare mail but a human must press Send in Outlook |
| `Calendars.Read` | Read the signed-in user's calendar | Seeing what is on the agenda | **Yes**, if you only want mail |
| `Calendars.ReadWrite` | Create events on the signed-in user's calendar | Scheduling a meeting with attendees | **Yes.** Withhold it and Cortex can read the calendar but not write to it |
| `offline_access` | Keep the connection alive without asking the person to sign in every hour | Microsoft access tokens last about an hour; without this, everything stops working mid-morning, every morning | No, in practice |
| `openid`, `profile`, `email` | Identify who just connected | Standard sign-in; grants no access to content | No |

**That is the complete list.** Cortex does not ask for `Mail.ReadWrite.Shared`,
`MailboxSettings`, `Files.Read`, `Sites.Read.All`, `User.Read.All`,
`Directory.Read.All`, or any `.All` scope of any kind. If you see one of those
on the consent screen, something is wrong — stop and tell us.

### Starting smaller

The connect link accepts a preset, so you can pilot with less:

| Link | Grants |
|---|---|
| `/api/integrations/microsoft?preset=mail_readonly` | `Mail.Read` only — Cortex can read and search, and can compose nothing |
| `/api/integrations/microsoft?preset=mail` | The three mail permissions |
| `/api/integrations/microsoft?preset=calendar_readonly` | `Calendars.Read` only |
| `/api/integrations/microsoft?preset=calendar` | Both calendar permissions |
| `/api/integrations/microsoft?preset=all` (the button on the screen) | Everything in the table above |

`mail_readonly` is a reasonable first grant for a security-conscious pilot, and
people can widen it later — reconnecting adds permissions to what they already
gave rather than replacing it.

---

## What Cortex will not do

- **It will not read a mailbox nobody connected.** There is no tenant-wide
  access, so a person who never completes the connect flow is invisible to it.
- **It will not archive internal mail.** Only threads that include somebody
  *outside* your own email domains can be saved into Brain Knowledge — a client,
  a supplier, a customs broker, a carrier. A mail between two of your employees
  is that person's private correspondence and is never read into a shared space.
  This mirrors the WhatsApp integration, which archives groups and never direct
  messages.
  - This depends on the `INTERNAL_EMAIL_DOMAINS` setting being correct. If it is
    not set, Cortex **archives nothing at all** and says so, rather than
    guessing.
- **It will not send anything without a human approving that specific message.**
  Sending is gated on an explicit confirmation, every time, and the confirmation
  shows the recipient and the subject before it is given.
- **It will not delete or move mail.** There is no tool that does, and no
  permission that would allow it.

---

## Registering the application in Azure — step by step

You need an account that can create app registrations (Application Developer,
Cloud Application Administrator, or Global Administrator).

### 1. Create the registration

1. Go to the [Azure portal](https://portal.azure.com) → **Microsoft Entra ID** →
   **App registrations** → **New registration**.
2. **Name:** `Cortex` (this is what your people will see on the consent screen —
   name it something they will recognise).
3. **Supported account types:** *Accounts in this organizational directory only
   (single tenant)*. Choose this unless you have a specific reason not to: it
   means Microsoft itself refuses any account outside your directory, before a
   token is ever issued.
4. **Redirect URI:** platform **Web**, value:

   ```
   https://<your-cortex-host>/api/integrations/microsoft/callback
   ```

   For a local development instance:
   `http://localhost:3000/api/integrations/microsoft/callback`.
5. **Register.**

### 2. Copy the two identifiers

From the **Overview** page:

- **Application (client) ID** → `MICROSOFT_CLIENT_ID`
- **Directory (tenant) ID** → `MICROSOFT_TENANT_ID`

### 3. Create a client secret

1. **Certificates & secrets** → **Client secrets** → **New client secret**.
2. Description `Cortex`, expiry **24 months** (Azure's maximum; put a calendar
   reminder at 22 months — an expired secret breaks every connection at once).
3. Copy the **Value** immediately — Azure never shows it again.
   → `MICROSOFT_CLIENT_SECRET`

### 4. Add the API permissions

1. **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions**.

   > If you click **Application permissions** here, you are on the wrong screen.
   > Cortex does not use them. See "Why delegated permissions" above.

2. Tick exactly these:
   - `Mail.Read`
   - `Mail.ReadWrite`
   - `Mail.Send`
   - `Calendars.Read`
   - `Calendars.ReadWrite`
   - `offline_access`
   - `openid`, `profile`, `email`
3. **Add permissions.**

### 5. Grant admin consent

This is the step that takes real time in a real company, and it is the only one
that needs an administrator.

- **API permissions** → **Grant admin consent for \<your tenant\>**.
- The status column should read *Granted for \<tenant\>* for every row.

**What this does and does not do.** Admin consent here means "the people in this
company are allowed to authorise Cortex for their own mailbox". It does **not**
give Cortex access to anybody's mail. Each person still has to sign in and
approve their own account, and each of them can be revoked individually.

**If you skip it:** in most Microsoft 365 tenants user consent is disabled, so
the first person who tries to connect gets *"Need admin approval"* and nothing
else happens. If your tenant allows user consent, people can approve for
themselves and this step is optional — but it means every person sees a consent
screen listing all the permissions, which usually generates more questions than
granting consent once.

### 6. Set the environment variables

```
MICROSOFT_CLIENT_ID=<Application (client) ID>
MICROSOFT_CLIENT_SECRET=<the secret VALUE, not its id>
MICROSOFT_REDIRECT_URI=https://<your-cortex-host>/api/integrations/microsoft/callback
MICROSOFT_TENANT_ID=<Directory (tenant) ID>
```

Also make sure `INTERNAL_EMAIL_DOMAINS` lists your own mail domains — without it
Cortex archives no correspondence at all.

Restart the app. The **Microsoft 365** card on `/integrations` becomes
connectable.

---

## How each person connects

1. Open Cortex → **Integraciones**.
2. **Microsoft 365** → **Conectar**.
3. Sign in with the work account and approve.

They land back on the Integrations screen with the card showing how many
permissions they granted. Their mailbox — and only their mailbox — is now
reachable.

---

## How the tokens are stored

- Both the access token and the refresh token are encrypted with **AES-256-GCM**
  under `TOKEN_ENCRYPTION_KEY` before they touch the database, in the same
  `integrations` table and by the same code path as Google's.
- Neither is ever written to a log, returned from an API, or included in an
  error message. The failure messages in this integration were written
  specifically to avoid echoing Microsoft's error payloads, which quote parts of
  the request.
- Rows are scoped to one workspace. A person in one company cannot reach
  another company's tokens or archived mail; there is a test that asserts it.

---

## Keeping the connection alive, and what breaks it

Microsoft access tokens last about an hour. Cortex refreshes them
automatically, a minute before expiry, using the refresh token — and stores the
**new** refresh token Entra ID returns each time, because Microsoft rotates them
and the previous one stops working immediately.

A connection genuinely dies when:

| What happened | What the person sees | What fixes it |
|---|---|---|
| Password changed | "Your Microsoft 365 connection is no longer valid… Reconnect Microsoft 365 from the Integrations screen" | Reconnect |
| An administrator revoked the app or the user's sessions | Same message | Reconnect (after the admin re-consents, if the app itself was revoked) |
| Nobody used the connection for 90 days | Same message | Reconnect |
| A conditional-access policy now requires a fresh sign-in or a compliant device | Same message | Reconnect from a device that satisfies the policy |
| The client secret expired | Every person's connection fails at once | Create a new secret in Azure and update `MICROSOFT_CLIENT_SECRET` |

Retrying never helps with any of these, which is why the message says to
reconnect rather than to try again.

Two failures that are **not** revocations and are worth telling apart:

- **Throttling (429).** Graph limits how fast one mailbox can be read. Cortex
  reports how long to wait. Nothing is broken and nothing was lost.
- **Permission never consented (403).** The account is fine but that specific
  permission was withheld. The message names it; the fix is an administrator
  approving it, not a reconnect.

---

## Revoking access

Any of these works, immediately:

- **The person:** [myaccount.microsoft.com](https://myaccount.microsoft.com) →
  *Apps & devices* (or *Privacy*) → revoke Cortex.
- **An administrator, for one person:** Entra ID → *Enterprise applications* →
  Cortex → *Users and groups* → remove them. Or *Revoke sessions* on the user.
- **An administrator, for everyone:** Entra ID → *Enterprise applications* →
  Cortex → *Properties* → **Delete**. Every connection stops at once.

Deleting a person's connection in Cortex removes the stored tokens but does not
revoke the grant at Microsoft; do both if the point is offboarding.

---

## What the tools are called

Useful when reading an audit log. Each one is the twin of the Google tool beside
it, with the same arguments and the same result shape.

| Microsoft 365 | Google | What it does |
|---|---|---|
| `outlook.search` | `gmail.search` | Search the mailbox, returns conversations |
| `outlook.list_threads` | `gmail.list_threads` | Everything with one contact |
| `outlook.read_thread` | `gmail.read_thread` | A whole thread, in order |
| `outlook.draft` | `gmail.draft` | Create a draft. Sends nothing |
| `outlook.send_draft` | `gmail.send_draft` | Send an approved draft. Confirmation required |
| `outlook.archive_thread` | *(no twin)* | Save a client thread into Brain Knowledge |
| `mscal.list_events` | `gcal.list_events` | Calendar rows in a window |
| `mscal.create_event` | `gcal.create_event` | Create an event. Confirmation required |

One behavioural difference worth knowing: **Microsoft always emails the
invitation** to whoever is listed as an attendee on a new event. Graph has no
"do not notify" option, so `mscal.create_event` has no equivalent of Google's
`sendUpdates: none`.
