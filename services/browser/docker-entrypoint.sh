#!/bin/bash
set -e

# El único trabajo de root, y por qué existe este archivo:
#
# Railway monta el volumen de perfiles con dueño root, y el proceso corre como
# `pwuser` a propósito (el Dockerfile dice por qué: esto renderiza páginas del
# internet abierto). Sin este puente, el primer perfil muere en
# «EACCES: permission denied, mkdir '/profiles/<owner>'» — se vio en
# producción a los cinco minutos de montar el volumen.
#
# Así que root entrega el directorio y se baja EN LA MISMA LÍNEA: el proceso
# que queda corriendo es pwuser, igual que antes. Solo el punto de montaje —
# los subdirectorios que el servicio cree adentro ya nacen suyos.
if [ -n "${BROWSER_PROFILES_DIR:-}" ] && [ -d "${BROWSER_PROFILES_DIR}" ]; then
  chown pwuser:pwuser "${BROWSER_PROFILES_DIR}"
fi

exec runuser -u pwuser -- "$@"
