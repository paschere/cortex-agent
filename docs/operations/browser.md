# Trámites web

Cortex can now do paperwork on other people's websites: open a portal, log in,
fill a form, and come back with the certificate.

1. A person does the errand **once**, sharing the tab, and Cortex reads the
   recording and proposes the steps.
2. Cortex immediately runs the proposal against the real site. Only a clean
   end-to-end run makes it **probado**; otherwise it stays **propuesto**.
3. From then on it repeats the errand with **no language model in the loop** —
   a few seconds, no cost, the same result every time.
4. When the portal changes, it tries to find the moved element and **updates
   the flow**, so the fix is paid for once rather than every time.

It never invents a trámite. Everything it can do is something a person
demonstrated, and anything that writes on a third-party system asks a human
first.

---

## ⚠️ Read this first

- **`BROWSER_SERVICE_TOKEN` is operator infrastructure, not a customer
  credential.** Anything holding it can make Cortex drive a browser, and the
  request body it accepts carries **decrypted portal passwords**. It belongs in
  exactly two places — the Railway service and Vercel — and is never issued to a
  customer, rendered in the UI or sent to a browser.
- **A `propuesto` trámite has never been shown to work.** It is a model's
  reading of a recording. It is runnable by hand, deliberately invisible to the
  agent in chat, and must not be scheduled.
- **A trámite marked `write` acts with the company's identity on a system nobody
  here administers.** It is gated by the ordinary approval card, and there is no
  undo from Cortex.
- **Only ever share one tab.** The screen shows this before recording starts.
  Sharing a window or the whole screen is refused with an explanation, because
  a full-screen share captures the notification from another client that slides
  in mid-errand.
- **No video and no frame is stored anywhere.** Not in Postgres, not in object
  storage, not on disk. See § 4.
- **One replica.** Each run gets its own browser context, but the concurrency
  ceiling (`BROWSER_MAX_CONCURRENT`) is per process, and a second replica would
  double it silently on a box sized for one.

---

## 1. How it is put together

```
  Person's tab ──frames──▶ Cortex (Vercel) ──▶ model ──▶ proposed steps
                             │
                             │  https + bearer
                             ▼
                        services/browser  ──▶  the portal
                          (Railway)
                          Playwright + Chromium
```

**Why two pieces.** Playwright drives a real Chromium: a process with a few
hundred megabytes resident that has to stay alive across the dozen navigations
one errand takes. A serverless invocation structurally cannot hold that. So the
browser lives on Railway and talks to Cortex over HTTPS, exactly like
`services/whatsapp`.

**The service owns no data.** It has no database credentials, keeps nothing
between runs, and does not know what a workspace is. Cortex sends it a step
list, the values to fill in, and — for a trámite that logs in — the decrypted
credential for that one call. Every decision about who may run what, and every
row that results, is on the Cortex side.

**One browser, one context per run.** Launching Chromium costs about a second;
a context costs almost nothing. The context is also the isolation boundary that
matters: cookies, `localStorage` and any session a login just created belong to
it and die with it, so two workspaces running errands on the same portal in the
same second cannot see each other's session.

| File | What it is |
|---|---|
| `infra/supabase/migrations/0087_browser_flows.sql` | The schema, and the reasoning for every table |
| `packages/agent-tools/src/browser/extract.ts` | Reading an errand off a recording |
| `packages/agent-tools/src/browser/execute.ts` | The run: replay → classify → repair |
| `packages/agent-tools/src/browser/classify.ts` | "the site changed" vs "the errand failed" |
| `packages/agent-tools/src/browser/redact.ts` | Why a credential cannot reach a log or a row |
| `packages/agent-tools/src/browser/access.ts` | Who may spend a login they cannot see |
| `services/browser/src/snapshot.ts` | How the page is described, and the locator ranking |
| `services/browser/src/replay.ts` | The step loop. No model anywhere in it |
| `apps/web/app/(app)/browser/` | The screen |

---

## 2. Deploying on Railway

### 1. Set the shared secret in Cortex

```sh
openssl rand -base64 32
```

Put it on Vercel as `BROWSER_SERVICE_TOKEN`, and `BROWSER_SERVICE_URL` as the
public origin Railway gives the service (no trailing slash).

### 2. Create the service

New service in the same Railway project as the WhatsApp bridge.

- **Root Directory:** `/` (the whole repo — pnpm needs the workspace manifest)
- **Config as code:** `services/browser/railway.json`

The Dockerfile builds from the repository root and runs on
`mcr.microsoft.com/playwright:v1.49.1-jammy`. **That tag must match the
`playwright` version in `services/browser/package.json`** — Playwright refuses
to run against browsers built for a different release, and the symptom is a
container that starts and immediately dies with no message.

### 3. Variables on the Railway service

| Variable | Value |
|---|---|
| `BROWSER_SERVICE_TOKEN` | the same secret you put on Vercel |
| `PORT` | Railway injects it; the default is 3300 |
| `BROWSER_MAX_CONCURRENT` | optional, default `3` — contexts at once |
| `BROWSER_RUN_TIMEOUT_MS` | optional, default `180000` — one whole errand |
| `BROWSER_STEP_TIMEOUT_MS` | optional, default `20000` — one step |
| `BROWSER_SESSION_IDLE_MS` | optional, default `300000` — idle session sweep |
| `BROWSER_VIEWPORT_WIDTH` / `_HEIGHT` | optional, default `1366×900` |
| `LOG_LEVEL` | optional, default `info` |

Give it **1 GB of memory minimum**. Chromium plus a heavy portal will use
several hundred megabytes, and an OOM kill mid-errand looks like a timeout.

> **Keep `numReplicas` at 1.** `railway.json` sets it. The concurrency ceiling
> is per process; a second replica doubles the load on a box sized for one.

### 4. Run the migration

`infra/supabase/migrations/0087_browser_flows.sql` — six tables, all RLS-on and
service-role only, like everything since 0064.

### 5. Deploy

The first boot logs, in order:

```
{"level":"info","service":"cortex-browser","msg":"browser service listening","port":3300}
{"level":"info","service":"cortex-browser","msg":"chromium ready"}
```

`chromium ready` is the line that matters — it means the image has the forty-odd
shared libraries Chromium needs. If it is missing, the base image is wrong.

`/health` is unauthenticated on purpose (Railway polls it) and answers **200 even
when Chromium is down**: the container is healthy and relaunches the browser on
demand, and failing the check would have Railway restart the process in the
middle of doing exactly that.

---

## 3. Teaching a trámite

**Trámites web → Enséñame.** Share the tab, do the errand, press Terminar.

What Cortex extracts from the recording:

- **The sequence of actions** — navigate, fill, choose, click, read, download.
- **A ranked list of ways to find each element**, best first. All semantic:
  the element's role plus its visible name, the label printed beside a field,
  the placeholder inside it, the form field's `name`, the words on a link. A
  structural CSS path is last, and is only ever a fallback.
- **Which typed values change between runs** — the plate, the NIT, the month —
  declared as variables, so one recording serves every plate. Anything the
  extractor left as fixed that should vary is corrected on the review screen
  before saving; getting this wrong is the difference between a procedure and a
  souvenir.
- **Two or three page landmarks per step** — a heading, the portal's name. Not
  used to find anything. Used later to answer "is this even the page we
  learned on".

### Why those locators survive a redesign

Playwright resolves elements the way a person does: by role, by accessible name,
by the label next to the field. Those are also exactly the things a picture of a
page shows, which is what makes reading a recording viable in the first place.

The ranking, best first, and what each one survives:

| Rank | Locator | Survives |
|---|---|---|
| 1 | `data-testid` | anything — it was put there for automation |
| 2 | role + accessible name | restyle, wrapper divs, class renames, a framework migration |
| 3 | the field's label | anything short of rewording the form |
| 4 | placeholder | a restyle; placeholders get reworded more often than labels |
| 5 | `name` attribute | any cosmetic change — the JSF/ASP.NET stacks most Colombian portals run on almost never touch it |
| 6 | visible link/button text | a restyle |
| 7 | `#id`, when it does not look generated | a restyle |
| 8 | CSS path | very little. First to break |

**Several per step, and that is the feature.** At replay the flow tries each in
order and takes the first that resolves to exactly one visible element. When
rank 0 stops matching and rank 2 works, the flow just absorbed a redesign: no
model, no failed run, and the step is rewritten with the survivor first
(`drifted` in the version history). The step trace marks it *vía alterna*, which
is how you see a portal changing weeks before it breaks.

Ambiguity counts as not-found. Two matches means acting on a guess, and on a
page that files something with a government body a guess is the one outcome
worth failing to avoid.

### Propuesto vs probado

Saving does not just store the proposal. Cortex runs it against the real site
with the values you gave, and:

- **it completes** → **probado**, with the date. Visible to the agent in chat.
- **a step the model misread fails** → Cortex shows the model the live page,
  lets it correct that one step, and runs the whole thing again. If it now
  completes it is **probado** and the correction is saved as a `refined`
  version.
- **it still fails** → **propuesto**, with the failing step named. Runnable by
  hand from the screen; invisible to the agent.

---

## 4. What happens to the recording, and to what you typed

**No video is ever created.** The page samples the shared tab into a canvas and
keeps only the frames where the picture visibly changed — typically twelve to
twenty for a whole errand, capped at twenty. There is no `MediaRecorder`, no
blob and no stream upload.

**No frame is ever stored.** They go up in one request to
`/api/browser/extract`, straight to the model, and the response is a step list.
Nothing writes them to Postgres, to object storage or to disk; there is no queue
and no job holding them. When the request returns they are garbage. All that
survives is `recording_frames` (a count) and `extraction_cost_usd`, so the
teaching step can be audited and priced without keeping the pictures.

This is why extraction is synchronous even though it takes most of a minute.
A background job would need somewhere to park the frames while it waited, and
"somewhere" is a copy of somebody's screen that then has to be defended,
audited, and eventually deleted by a sweeper that will one day not run. **The
cheapest way not to leak a recording is not to have one.**

**Passwords.** Three defences, in order of how much they are relied on:

1. **A password field renders as dots.** The camera sees `••••••••`. This
   covers the ordinary case completely.
2. **The extractor is told never to transcribe a credential** and to emit a
   `secret` placeholder instead.
3. **`enforceSecrets` assumes it did anyway.** Any step whose label or locator
   looks like a credential field — contraseña, clave, usuario, PIN, token,
   código de verificación — has whatever text came back **discarded** and is
   rewritten to `{kind:'secret'}`. This is what catches a revealed password, a
   "show password" eye toggle, and a password manager overlay. The characters
   are dropped, not masked.

**Pause** is on screen the whole time a recording runs, as a large button, and
it stops sampling entirely. Somebody will need to open another customer's record
mid-errand, and the honest answer to that is a button rather than a promise
about what we do with the pixels afterwards.

---

## 5. The measured comparison

`pnpm browser:bench` — the numbers below are its output, not an estimate.

It runs the same errand two ways against the same fixture portal
(`scripts/browser-benchmark/portal.ts`, a stand-in for the RUNT: three pages, a
form with a server-generated field name, a results table, and a fixed 350 ms of
latency per page **paid identically by both sides**, so it cancels out).

| | Time (median) | Cost | Model calls |
|---|---:|---:|---:|
| **Aprendido** (replay) | **2.28 s** | **US$0.0000** | **0** |
| **Razonado** (model drives the browser) | 11.71 s | US$0.0089 | 3 |

**5.1× faster, and free.** Priced at Anthropic's list rate for `claude-sonnet-5`
($3/$15 per MTok); the promotional rate in force until 2026-08-31 halves the
reasoned figure and leaves the learned one at zero.

The reasoned baseline is not a strawman: it gets the same browser, the same page
snapshot with the same semantic locators, and it succeeded on all three runs.
(An earlier version of the benchmark reported 28× — because the snapshot only
carried interactive elements, so the reasoning agent could not read a results
table and gave up. Adding page text to the snapshot fixed the baseline and cut
the headline number in half. The smaller number is the true one.)

**How it scales, and why the gap widens.** The errand above is four steps. The
reasoned side spent 3 calls, ~3.9 s and ~$0.003 each — roughly one call per
meaningful decision. A learned replay is a for-loop, so its cost stays flat in
the number of model calls at zero and grows only with the portal's own latency.
A twelve-step errand is about the same replay plus more page waits, against
roughly nine to twelve model calls on the reasoned side.

Put in a month: an errand run 40 times costs **$0.00** learned and about
**$0.36** reasoned, and takes 1.5 minutes rather than 8. Teaching it cost one
extraction — around **$0.08** for twenty frames, once.

**The other number worth knowing:** after the fixture portal renames its submit
button, the learned replay fails in **2.27 s without calling the model at all**,
and the evidence it hands back (landmarks present, zero candidate matches,
HTTP 200, no refusal text) is what the classifier reads. Failing fast and cheap
is what makes it affordable to be careful about when to repair.

---

## 6. What cannot be learned from a recording

A shared tab gives **pixels, not events**. There is no click stream, no keydown
and no DOM — everything is inferred from what changed on screen. That is enough
for the overwhelming majority of portal work, and these are the exceptions,
stated rather than papered over:

| Step kind | Why the recording is not enough | What to do |
|---|---|---|
| **Hover-only menus** | A menu that opens on hover and closes when the mouse leaves may never appear in a sampled frame, and even when it does, the *hover* that caused it is invisible. Cortex will usually record the click on the final item and miss the step that revealed it. | Click the parent menu instead of hovering while teaching, if the portal allows it. Otherwise the flow needs the hover step added by hand. |
| **File uploads** | The OS file picker is a native dialog outside the tab. It is not in the capture at all, and there is no `upload` action in the step vocabulary. | Not supported. A trámite that uploads a document has to stay manual for now; adding it means an `upload` action plus somewhere for the file to come from. |
| **Codes that arrive elsewhere** | An OTP by SMS or email is on a phone, not the tab. The recording shows six digits appearing in a box and nothing about where they came from. | The step is captured as a `secret`, which is the right shape but not yet a working one — nothing feeds it. Portals with mandatory 2FA on every login are out of scope. |
| **Captchas** | Deliberately unlearnable. | Out of scope. `vehicles/client.ts` solves this with OCR for two specific sites; generalising it is a different project. |
| **Canvas / PDF viewers / iframes from another origin** | A value drawn on a `<canvas>` or inside a cross-origin iframe has no element behind it to locate, even though it is plainly visible in the frame. | `extract` will fail. Download the document instead where the portal offers it. |
| **Drag and drop, and anything timing-dependent** | The intermediate states are between frames. | Not supported. |

**If a portal needs several of these, recording is the wrong mechanism for it** —
the answer would be to also capture browser events, which means an extension or
a Cortex-driven browser, which is the trade-off this design deliberately made
the other way. Adoption beats fidelity for the ninety percent; the ten percent
should be named rather than half-supported.

---

## 7. When something goes wrong

### The screen says "El servicio de navegador no está conectado"

`BROWSER_SERVICE_URL` or `BROWSER_SERVICE_TOKEN` is missing on Vercel. Nothing
is broken; the feature is dark until both are set.

### "El servicio de navegador rechazó nuestra clave"

The tokens on Vercel and Railway no longer match. Rotate both together.

### "El servicio de navegador está ocupado"

`BROWSER_MAX_CONCURRENT` contexts are already in flight. Raise it if the box has
the memory, or wait — errands are seconds long.

### A trámite says "El portal respondió y rechazó el trámite"

It worked; the answer was no. The message quotes what the portal said — a plate
that does not exist, a rejected password, an expired session, a validation
error. **Cortex deliberately did not touch the flow.** Fix the input or the
credential.

### A trámite says "El portal cambió" and is now marked roto

The repair either could not identify the moved element with confidence, or it
did and the repaired flow still failed. Both leave the steps exactly as they
were — nothing is saved on the strength of the model having answered. Re-teach
it from a new recording.

### A trámite repaired itself three times today and is now roto

The thrash guard (`MAX_REPAIRS_PER_WINDOW`, three in 24 hours). A flow being
rewritten repeatedly by a model against a page nobody has looked at is not
drifting; it needs a person. Look at the version history — every repair is a row
with the model's own sentence about what it changed.

### The step trace shows "vía alterna" on some steps

The preferred locator stopped matching and a lower-ranked one carried the step.
Nothing is wrong; the flow rewrote itself and no model was involved. It is
worth reading as an early warning that the portal is being worked on.

### A recording produced no steps

The shared tab was in the background the whole time, so nothing changed on
screen. Keep the portal tab visible while doing the errand.

### "Compartiste una ventana o la pantalla completa"

Deliberate refusal. Share the tab: it is the narrowest thing the browser offers
and it is what keeps everything behind it out of the capture.

### Somebody asks whether their password was recorded

No. It renders as dots on screen, so the camera never sees the characters; the
extractor is told not to transcribe credentials; and any step that looks like a
credential field has its text discarded before the proposal is even returned to
the browser. What is stored is the *name* of the field and a pointer to an
encrypted credential. The step trace shows `***`, which is a fixed string and
not a mask — not even the length is kept.

---

## Related

- `infra/supabase/migrations/0087_browser_flows.sql` — the schema and the reasoning behind every table, including why credentials are separate from flows
- `packages/agent-tools/src/browser/classify.ts` — the failure taxonomy, and the login-page rule that stops an expired session from corrupting a good flow
- `packages/agent-tools/src/browser/execute.ts` — why a repair only counts if the whole errand then works
- `packages/agent-tools/src/browser/__tests__/browser.test.ts` — the five properties, asserted
- `services/browser/README.md` — the service on its own terms
- `docs/operations/whatsapp.md` — the other Railway service, same deployment shape
