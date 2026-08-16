#!/bin/sh
# Dos procesos, un contenedor: PostgREST atrás (puerto fijo 3000, solo
# localhost lo ve) y Caddy adelante en el $PORT que Railway asigna. Si
# cualquiera de los dos muere, el contenedor muere con él y Railway lo
# reinicia — mejor un reinicio limpio que un proxy sirviendo 502 para siempre.
set -e

: "${PGRST_DB_URI:?Falta PGRST_DB_URI (la URL del Postgres de Railway)}"
: "${PGRST_JWT_SECRET:?Falta PGRST_JWT_SECRET (el secreto que firma las llaves)}"

export PGRST_SERVER_PORT=3000
export PGRST_SERVER_HOST=127.0.0.1
export PGRST_DB_SCHEMAS="${PGRST_DB_SCHEMAS:-public}"
export PGRST_DB_ANON_ROLE="${PGRST_DB_ANON_ROLE:-anon}"
# El pooler somos nosotros: PostgREST mantiene sus propias conexiones vivas,
# que es exactamente lo que el pooler de Supabase hacía por la app.
export PGRST_DB_POOL="${PGRST_DB_POOL:-10}"

postgrest &
PGRST_PID=$!

# Si PostgREST no levanta (URL mala, base caída), no tiene sentido que Caddy
# se quede sirviendo 502: se espera un momento y se verifica.
sleep 2
if ! kill -0 "$PGRST_PID" 2>/dev/null; then
  echo "PostgREST no arrancó; revisa PGRST_DB_URI." >&2
  exit 1
fi

exec caddy run --config /etc/caddy/Caddyfile
