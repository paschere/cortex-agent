# La API de datos de Cortex fuera de Supabase: PostgREST + un proxy de ruta.
#
# ===========================================================================
# POR QUÉ EXISTE ESTE SERVICIO
# ===========================================================================
# Todo el acceso a datos de la app está escrito con supabase-js: cientos de
# `db.from('tabla').select(...)`. supabase-js no habla con «Supabase»: habla
# con PostgREST, que es software libre y corre donde sea. Hospedarlo nosotros
# convierte el éxodo de Supabase en un cambio de TRES variables de entorno en
# vez de una reescritura de cientos de queries.
#
# ===========================================================================
# POR QUÉ HAY UN CADDY DELANTE
# ===========================================================================
# supabase-js construye sus URLs como `{SUPABASE_URL}/rest/v1/...` — ese
# prefijo lo ponía el gateway de Supabase, no PostgREST, que sirve en la raíz.
# El Caddy hace exactamente una cosa: quitar `/rest/v1` y pasar el resto.
# Cambiar el prefijo en supabase-js no se puede (está fijado en el
# constructor), así que el proxy es el punto correcto — quince líneas de
# configuración contra tocar una librería ajena.
#
# PostgREST se descarga como binario ESTÁTICO del release oficial (por eso el
# `-static-` en el nombre: no depende de la libc de la imagen), y Caddy es un
# binario Go igual de portable que se copia de su imagen oficial.

FROM debian:bookworm-slim

# La 12.2.x es la serie que corre Supabase hoy: mismo dialecto exacto que las
# queries del producto llevan años ejercitando. Subir de major es una decisión
# aparte, con sus release notes leídas — no un efecto colateral de un deploy.
ARG POSTGREST_VERSION=v12.2.12
ARG TARGETARCH

# libpq5: el binario de x86-64 es estático y no lo necesita, pero el de
# aarch64 (donde se ensaya en local) enlaza dinámico contra libpq. Cuesta
# unos KB y hace que la MISMA imagen corra en las dos arquitecturas.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates xz-utils libpq5 \
  && ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "ubuntu-aarch64" || echo "linux-static-x86-64") \
  && curl -fsSL -o /tmp/pgrst.tar.xz \
    "https://github.com/PostgREST/postgrest/releases/download/${POSTGREST_VERSION}/postgrest-${POSTGREST_VERSION}-${ARCH}.tar.xz" \
  && tar -xJf /tmp/pgrst.tar.xz -C /usr/local/bin postgrest \
  && rm /tmp/pgrst.tar.xz \
  && apt-get purge -y curl xz-utils && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY --from=caddy:2 /usr/bin/caddy /usr/local/bin/caddy

# Rutas desde la raíz del repo: Railway construye con el repositorio entero
# como contexto (igual que services/whatsapp), no con este directorio.
COPY services/pgrest/Caddyfile /etc/caddy/Caddyfile
COPY services/pgrest/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

CMD ["/usr/local/bin/start.sh"]
