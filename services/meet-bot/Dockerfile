# El bot de reuniones de Cortex.
#
# Se construye desde la RAÍZ del repo (pnpm necesita el manifiesto del
# workspace y el lockfile):
#
#     docker build -f services/meet-bot/Dockerfile .
#
# Playwright 1.56 (mismo que Vexa) + Chrome real (códecs de Meet) + Xvfb + xdotool
# para el input humanizado (XTEST, isTrusted=true).

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
# La imagen oficial de Playwright trae Chromium; Meet exige Chrome real
# (H.264/AAC). El tag casa con `playwright` en package.json (1.56.0).
FROM mcr.microsoft.com/playwright:v1.56.0-jammy AS runtime
USER root
WORKDIR /app
ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=America/Bogota

# Xvfb: pantalla virtual (Meet degrada headless).
# xdotool: clicks XTEST del join humanizado de Vexa.
# x11vnc: vista en vivo si la admisión escala a needs_human_help.
# PulseAudio: Chrome no decodifica WebRTC remoto sin un dispositivo de salida
# (si no, pistas muted, peak=0, Deepgram mudo). Null sink, nadie lo oye.
RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb fonts-liberation xdotool x11vnc pulseaudio pulseaudio-utils \
  && rm -rf /var/lib/apt/lists/* \
  && printf '%s\n' \
    '#!/usr/bin/pulseaudio -nF' \
    '.nofail' \
    'load-module module-native-protocol-unix' \
    'load-module module-null-sink sink_name=cortex_out sink_properties=device.description=CortexOut' \
    'load-module module-always-sink' \
    'set-default-sink cortex_out' \
    > /etc/pulse/default.pa \
  && printf '%s\n' 'exit-idle-time = -1' >> /etc/pulse/daemon.conf
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/meet-bot/package.json services/meet-bot/
RUN pnpm install --filter @cortex/meet-bot --prod --frozen-lockfile
RUN pnpm --filter @cortex/meet-bot exec playwright install chrome
COPY --from=build /repo/services/meet-bot/dist services/meet-bot/dist

RUN mkdir -p /app/storage/screenshots /profiles \
  && chown -R pwuser:pwuser /app/storage /profiles

COPY services/meet-bot/docker-entrypoint.sh /usr/local/bin/cortex-meet-entrypoint
RUN chmod +x /usr/local/bin/cortex-meet-entrypoint

EXPOSE 3400
ENTRYPOINT ["/usr/local/bin/cortex-meet-entrypoint"]
