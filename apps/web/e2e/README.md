# Pruebas de extremo a extremo

Una sola suite, y vigila una sola cosa: **que abrir el panel de al lado no
desmonte la conversación**. Es la premisa sobre la que está construido todo el
panel — si falla, el panel no arregla nada, sólo cambia una forma de perder el
turno en vuelo por otra más silenciosa.

Lo que se puede decidir leyendo el código ya está en `vitest`
(`components/panel/mount.test.ts` comprueba la FORMA del árbol de `AppShell`).
Aquí está lo que sólo contesta un navegador: React montando de verdad, un
`useChat` de verdad y un `fetch` a medio consumir.

## Antes de correrlas

```sh
supabase start                  # la base local, en 127.0.0.1:54321
pnpm --filter @cortex/web dev   # el servidor, en el puerto de APP_BASE_URL
```

Y luego, desde `apps/web`:

```sh
pnpm test:e2e
```

No hace falta preparar ninguna cuenta ni ningún dato: `auth.setup.ts` crea la
cuenta si no existe, deja que `requireSession()` aprovisione el espacio de
trabajo, y `seed.ts` siembra lo que los cinco paneles enseñan. Todo es
idempotente y todo vive dentro de esa organización de prueba.

**No compiles en el mismo árbol mientras corren.** `next build` borra `.next`
al empezar, y un `next dev` sirviendo se queda sin manifiestos a mitad de una
petición: se traduce en 500 en `/chat` y en una suite roja que no tiene nada que
ver con el panel.

## Qué hay dentro

| Archivo | Qué hace |
|---|---|
| `auth.setup.ts` | Entra una vez, guarda la sesión y siembra. |
| `seed.ts` | Los datos de los cinco paneles, por SQL directo. |
| `panel.spec.ts` | La suite. La primera prueba es la que importa. |

Los artefactos (trazas, sesión guardada) van a un directorio temporal, fuera de
`apps/web`: `next dev` vigila este árbol y un fichero nuevo a mitad de una
prueba le cuesta una recompilación. Se cambia con `PLAYWRIGHT_ARTIFACTS`, y las
capturas con `PANEL_SHOTS`.

## El turno es simulado, y eso es lo correcto

`panel.spec.ts` sustituye `window.fetch` **sólo** para `POST /api/chat` y
devuelve el protocolo de datos del AI SDK goteado trozo a trozo. No es por
ahorrarse una llamada a Anthropic: es que la prueba necesita que el stream siga
abierto en un instante exacto —el instante en que se abre el panel— y una
respuesta real termina cuando quiere. Un turno que se cierra antes de tiempo
daría verde sin haber probado nada.

Lo simulado es la respuesta. Todo lo demás es el producto.

## Cómo se sabe que la prueba no está verde por casualidad

Se comprobó al revés: haciendo que el chat CAMBIE de posición en el árbol cuando
hay panel —que es lo que pasaría si `PanelHost` se dibujara como padre de
`{children}` en vez de como hermano— la prueba se pone roja, y roja por el
motivo correcto: el stream termina en la red pero los mensajes ya no están en la
pantalla. Es exactamente el fallo que esta suite existe para impedir.
