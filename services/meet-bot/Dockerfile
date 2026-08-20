# El bot de reuniones de Cortex.
#
# Se construye desde la RAÍZ del repo (pnpm necesita el manifiesto del
# workspace y el lockfile):
#
#     docker build -f services/meet-bot/Dockerfile .
#
# POR QUÉ NO EN VERCEL, y por qué ni siquiera como el browser: además de
# manejar un Chrome vivo por reunión (que un serverless no sostiene), este
# proceso necesita AUDIO y una pantalla. F0 demostró que Meet degrada a los
# clientes headless, así que el navegador corre bajo Xvfb — una pantalla
# virtual que hace a Chrome «headful» ante los ojos de Meet sin abrir ninguna
# ventana. El audio de la sala se saca con Web Audio dentro de la página
# (services/meet-bot/src/audio-tap.ts), no con PulseAudio, así que no hace
# falta un servidor de sonido — el spike lo probó.

FROM node:20-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/meet-bot/package.json services/meet-bot/
RUN pnpm install --filter @cortex/meet-bot... --frozen-lockfile
COPY tsconfig.base.json ./
COPY services/meet-bot services/meet-bot
RUN pnpm --filter @cortex/meet-bot build

# --- runtime ---------------------------------------------------------------
#
# La imagen de Playwright trae el Chrome real (canal 'chrome') con los códecs
# propietarios que Meet exige — la misma razón por la que F0 tuvo que dejar el
# Chromium pelado. El tag debe casar con la versión de `playwright` en
# package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Xvfb: la pantalla virtual. Sin ella, Meet degrada el cliente y el audio no
# fluye. `xvfb` ya viene en la imagen de Playwright; se arranca en el entrypoint.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/meet-bot/package.json services/meet-bot/
RUN pnpm install --filter @cortex/meet-bot --prod --frozen-lockfile
RUN pnpm --filter @cortex/meet-bot exec playwright install chrome
COPY --from=build /repo/services/meet-bot/dist services/meet-bot/dist

COPY services/meet-bot/docker-entrypoint.sh /usr/local/bin/cortex-meet-entrypoint
RUN chmod +x /usr/local/bin/cortex-meet-entrypoint

EXPOSE 3400
ENTRYPOINT ["/usr/local/bin/cortex-meet-entrypoint"]
