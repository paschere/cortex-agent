# El worker de la cola de Cortex (pg-boss).
#
# Se construye desde la RAÍZ del repositorio, no desde este directorio:
#
#     docker build -f services/jobs/Dockerfile .
#
# porque pnpm necesita el manifiesto del workspace y el lockfile para resolver.
# `railway.json` fija esa misma raíz. El patrón es idéntico al de
# services/whatsapp, que lleva meses corriendo así en Railway.

FROM node:20-slim AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/jobs/package.json services/jobs/
RUN pnpm install --filter @cortex/jobs-worker... --frozen-lockfile

COPY services/jobs/tsconfig.json services/jobs/
COPY services/jobs/src services/jobs/src
RUN pnpm --filter @cortex/jobs-worker build

FROM node:20-slim
WORKDIR /repo
ENV NODE_ENV=production

# pg_dump 18 para el backup diario (LOCAL_JOBS en el manifiesto). Del
# repositorio PGDG porque bookworm trae el cliente 15, y un pg_dump más viejo
# que el servidor (Postgres 18 en Railway) se niega a volcar — con razón.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends postgresql-client-18 \
  && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/services/jobs/node_modules ./services/jobs/node_modules
COPY --from=build /repo/services/jobs/dist ./services/jobs/dist
COPY --from=build /repo/services/jobs/package.json ./services/jobs/

CMD ["node", "services/jobs/dist/index.js"]
