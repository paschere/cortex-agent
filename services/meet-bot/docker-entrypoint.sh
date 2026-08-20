#!/bin/bash
set -e

# La pantalla virtual, encendida antes que el servicio.
#
# Meet degrada a los clientes headless (F0 lo mostró: sin pantalla el audio no
# fluía). Xvfb da un display :99 al que Chrome dibuja sin abrir ventana — para
# Meet, un cliente headful; para el contenedor, cero píxeles en pantalla real.
# El volumen de perfiles se monta con dueño root, así que se entrega a pwuser
# y se baja privilegios en la misma línea, igual que services/browser.

export DISPLAY=:99
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
sleep 1

if [ -n "${MEET_PROFILES_DIR:-}" ] && [ -d "${MEET_PROFILES_DIR}" ]; then
  chown pwuser:pwuser "${MEET_PROFILES_DIR}" || true
fi

exec runuser -u pwuser -- node services/meet-bot/dist/index.js
