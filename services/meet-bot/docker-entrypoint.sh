#!/bin/bash
set -e

# La pantalla virtual, encendida antes que el servicio.
#
# Meet degrada a los clientes headless (F0 lo mostró: sin pantalla el audio no
# fluía). Xvfb da un display :99 al que Chrome dibuja sin abrir ventana — para
# Meet, un cliente headful; para el contenedor, cero píxeles en pantalla real.
# El volumen de perfiles se monta con dueño root, así que se entrega a pwuser
# y se baja privilegios en la misma línea, igual que services/browser.
#
# PulseAudio + null sink: Xvfb no da altavoces. Sin un sink de salida Chrome
# no decodifica RTP remoto (pistas muted, peak=0). No hay virtual_mic — la
# voz del bot entra por replaceTrack, no por el monitor del sink (eco).

export DISPLAY=:99
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-pwuser}"
PW_HOME=/home/pwuser
mkdir -p /app/storage/screenshots "$XDG_RUNTIME_DIR" "$PW_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
chown pwuser:pwuser "$XDG_RUNTIME_DIR" "$PW_HOME" || true

Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
sleep 1

echo "[cortex-meet] starting PulseAudio dummy sink"
PA_ENV=(env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" HOME="$PW_HOME")
# -n: ignore default.pa. Load only the unix socket + a null sink so Chrome
# has speakers. --start swallows the real error; -D + a log file does not.
runuser -u pwuser -- "${PA_ENV[@]}" \
  pulseaudio -D -n --exit-idle-time=-1 --disallow-exit \
    --log-target=file:/tmp/pulse.log --log-level=info \
    --load="module-native-protocol-unix" \
    --load="module-null-sink sink_name=cortex_out sink_properties=device.description=CortexOut" \
    --load="module-always-sink" \
  || runuser -u pwuser -- "${PA_ENV[@]}" \
  pulseaudio --start --exit-idle-time=-1 --log-target=file:/tmp/pulse.log --log-level=info \
  || echo "[cortex-meet] PulseAudio failed to start — remote tracks will stay muted"
sleep 0.5
if ! runuser -u pwuser -- "${PA_ENV[@]}" pactl info >/dev/null 2>&1; then
  echo "[cortex-meet] PulseAudio not answering; log:"
  cat /tmp/pulse.log 2>/dev/null || true
else
  runuser -u pwuser -- "${PA_ENV[@]}" pactl set-default-sink cortex_out || true
  runuser -u pwuser -- "${PA_ENV[@]}" pactl list short sinks || true
fi

if [ -n "${MEET_PROFILES_DIR:-}" ] && [ -d "${MEET_PROFILES_DIR}" ]; then
  chown pwuser:pwuser "${MEET_PROFILES_DIR}" || true
fi

exec runuser -u pwuser -- env DISPLAY=:99 XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" HOME="$PW_HOME" \
  node services/meet-bot/dist/index.js
