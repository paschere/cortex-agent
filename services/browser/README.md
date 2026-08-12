# `@cortex/browser-service`

A Playwright process that executes learned trámites on third-party websites.

**Read [`docs/operations/browser.md`](../../docs/operations/browser.md) before
deploying or debugging this.** It has the Railway steps, the measured
speed/cost comparison, and the troubleshooting list.

## Why it exists

Playwright drives a real Chromium: a few hundred megabytes of resident memory
that has to stay alive across the dozen navigations one errand takes. A
serverless invocation structurally cannot hold that, so this runs on Railway and
talks to Cortex over HTTPS — the same reason `services/whatsapp` exists, a
different protocol.

## What it is not

It is **not** an application. It has no database credentials, keeps nothing
between runs, and does not know what a workspace is. It receives a step list,
executes it, and reports what happened. Every decision — who may run what, which
credential to unlock, whether a failure means the site changed or the errand was
refused, what gets written down — is made on the Cortex side, where it can be
tested without a browser and where the tenancy rules already live.

| File | What it is |
|---|---|
| `src/index.ts` | Entrypoint: config, worker, server, graceful shutdown |
| `src/config.ts` | Env, read once, validated loudly |
| `src/logger.ts` | JSON lines, with a denylist so a typed value can never reach a log |
| `src/server.ts` | Four routes. Bearer token in constant time; `/health` open |
| `src/browser.ts` | One Chromium, one context per run, and the interactive sessions |
| `src/replay.ts` | The step loop. **No model, no prompt, no provider client** |
| `src/locators.ts` | A stored target turned back into a Playwright locator |
| `src/snapshot.ts` | How a page is described, and the locator ranking that makes flows durable |
| `src/types.ts` | The wire. A hand-written copy of the agent-tools types, checked by a test on the other side |

## Local development

```sh
export BROWSER_SERVICE_TOKEN=dev-token
export PORT=3300
npx playwright install chromium     # once, matching the pinned version
pnpm --filter @cortex/browser-service dev
```

Point Cortex at it with `BROWSER_SERVICE_URL=http://127.0.0.1:3300` and the same
token in `.env.local`.

To exercise it without a real portal:

```sh
pnpm browser:bench
```

which starts a fixture portal, this service, and times a learned run against a
model-driven one.

## Operational rules

- **Nothing typed into a page ever goes in the log.** Not at debug level, not
  inside an error object. Log the step index, the action, the selector kind, the
  duration. Never the value. `src/logger.ts` enforces a denylist on top of that,
  but the call sites are the actual defence.
- **One replica.** The concurrency ceiling is per process.
- **The Playwright version in `package.json` and the base image tag in the
  Dockerfile must match.** Playwright refuses to run against browsers built for
  a different release, and the symptom is a container that starts and dies with
  no message.
- **`/health` answers 200 even when Chromium is down.** The container is healthy
  and relaunches the browser on demand; failing the check would have Railway
  restart the process mid-relaunch.
