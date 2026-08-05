# The Cortex WhatsApp bridge.
#
# Built from the REPOSITORY ROOT, not from this directory:
#
#     docker build -f services/whatsapp/Dockerfile .
#
# because pnpm needs the workspace manifest and the lockfile to resolve
# anything. `railway.json` sets the same root and dockerfile path.
#
# Two stages so the image that runs in production has no compiler, no dev
# dependencies and no TypeScript in it — a long-lived process is exactly the
# thing you do not want carrying a build toolchain around for months.

FROM node:20-slim AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Manifests first: this layer is cached until a dependency actually changes,
# which is what keeps a code-only deploy down to seconds.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/whatsapp/package.json services/whatsapp/
RUN pnpm install --filter @cortex/whatsapp-bridge... --frozen-lockfile

COPY tsconfig.base.json ./
COPY services/whatsapp services/whatsapp
RUN pnpm --filter @cortex/whatsapp-bridge build

# --- runtime ---------------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/whatsapp/package.json services/whatsapp/
RUN pnpm install --filter @cortex/whatsapp-bridge --prod --frozen-lockfile

COPY --from=build /repo/services/whatsapp/dist services/whatsapp/dist

# Not root. This process talks to the open internet and holds a credential.
USER node

# There is NO VOLUME here and that is deliberate. Baileys' default file-backed
# auth state would need one, and it would pin the service to a single instance
# in a single region while still losing the session on a rebuild. The session is
# in Postgres instead; see services/whatsapp/src/auth-state.ts.
EXPOSE 3200
CMD ["node", "services/whatsapp/dist/index.js"]
