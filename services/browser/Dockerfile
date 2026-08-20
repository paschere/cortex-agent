# The Cortex browser service.
#
# Built from the REPOSITORY ROOT, not from this directory:
#
#     docker build -f services/browser/Dockerfile .
#
# because pnpm needs the workspace manifest and the lockfile to resolve
# anything. `railway.json` sets the same root and dockerfile path.
#
# WHY THIS IS NOT ON VERCEL. Playwright drives a real Chromium: a process with
# a few hundred megabytes of resident memory that has to stay alive across the
# dozen navigations one errand takes. A serverless invocation cannot hold that,
# and there is no runtime flag that changes it. Same structural reason
# services/whatsapp exists, different protocol.

FROM node:20-slim AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Manifests first: this layer is cached until a dependency actually changes,
# which is what keeps a code-only deploy down to seconds.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/browser/package.json services/browser/
RUN pnpm install --filter @cortex/browser-service... --frozen-lockfile

COPY tsconfig.base.json ./
COPY services/browser services/browser
RUN pnpm --filter @cortex/browser-service build

# --- runtime ---------------------------------------------------------------
#
# Microsoft's Playwright image rather than node:20-slim plus an install script.
# Chromium needs some forty shared libraries -- fonts, nss, at-spi, libdrm --
# and every one of them missing is the same symptom: the browser launches and
# immediately dies with an exit code and no message. This image pins the
# library set to the Playwright version, so the two cannot drift apart.
#
# The tag MUST match the `playwright` version in services/browser/package.json.
# Playwright refuses to run against browsers built for a different release.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/browser/package.json services/browser/
RUN pnpm install --filter @cortex/browser-service --prod --frozen-lockfile

COPY --from=build /repo/services/browser/dist services/browser/dist

# Not root — but via the entrypoint rather than `USER`. This process renders
# pages from the open internet, which is the broadest attack surface anything
# in this repo has, so it runs as `pwuser` (ships with the Playwright image,
# owns the browser cache under /ms-playwright). The container STARTS as root
# for exactly one line: Railway mounts the profiles volume owned by root, and
# somebody has to hand it over before dropping privileges. See
# docker-entrypoint.sh — the running process is pwuser, same as always.
COPY services/browser/docker-entrypoint.sh /usr/local/bin/cortex-browser-entrypoint
RUN chmod +x /usr/local/bin/cortex-browser-entrypoint
ENTRYPOINT ["/usr/local/bin/cortex-browser-entrypoint"]

# Stateless by default: every replay context is created fresh and destroyed at
# the end of the run, so one workspace's cookies can never be present while
# another workspace's flow is executing. The ONE exception is opt-in: mount a
# volume and set BROWSER_PROFILES_DIR and the live-tab sessions (browser v2)
# get a persistent Chromium profile PER TENANT — separate directories, separate
# processes, so the isolation claim above still holds between workspaces.
# Without the variable, nothing is written and this comment is the whole truth.
EXPOSE 3300
CMD ["node", "services/browser/dist/index.js"]
