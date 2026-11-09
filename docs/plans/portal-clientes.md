# Portal de clientes: «Mis prealertas» (Operación de carga)

Pantalla de código `mis_prealertas` (implementación en `screens/portal.tsx`; el slug `portal` está reservado por la plataforma) para el rol externo `cliente`.

## Piezas
- `screens/portal.tsx`, `screens/mis_prealertas.tsx` (reexporta), `lib/portal-datos.ts` (AWB mod 7, pegado de Excel, estado legible), `lib/portal-ui.tsx` (sin importar ui.tsx), `lib/portal.css`.
- Datos: `cortex-ops/portal-clientes/` (`aplicar.sh`, `aplicar.sql`, `deshacer.sql`, `verificar.sh/mjs`, `gen.ts`). Vista previa: `portal-clientes/preview/`.

## Seguridad (lo que garantiza el servidor)
- Lectura de `prealertas` solo con `cliente = $user.cliente` (comparación exacta del texto). Ninguna otra tabla.
- Al crear, el servidor escribe `cliente` desde el atributo (no se puede falsificar; mandar `cliente` da 403).
- Lista blanca de escritura: guia, numero_vuelo, aerolinea, origen, fecha_estimada, piezas, kilos, descripcion_carga, documento, canal, cancelacion. No escribe vuelo, estado, estado_cruce.
- Lo que NO garantiza: editar/cancelar «solo mientras no esté cruzada» (el motor no tiene condición por estado; lo aplica la pantalla); ver campos internos de sus propias filas (p. ej. `notaciones`); `canal` lo elige el cliente (si lo cambia, no dispara el aviso); `ai.ask` y `functions.call` existen para el rol (con tope por minuto).
- `docs.scan` no está permitido a usuarios externos: no hay lectura automática del documento.
- El campo `guia` tiene formato AWB estricto: el servidor rechaza un dígito de control malo; la pantalla avisa antes y muestra el rechazo.

## Aplicar
1. `./verificar.sh` (ensayo con ROLLBACK) y luego `./aplicar.sh` en `cortex-ops/portal-clientes/`.
2. `cortex-ops/operacion-carga/instalar.sh` (sube el código y crea la pantalla).
3. Publicar versión de la app (los externos ven la versión publicada: rol, pantalla y build).
4. Invitar desde el chat de Cortex: `apps.invite_users` con app «Control de vuelos de carga», nombre, correo, roleKey `cliente`, atributos `{"cliente":"<nombre tal como está en prealertas.cliente>"}`. Enlace: `/a/c2facd8a-104c-4628-8c38-6c4801838c06`; entran con código de 6 dígitos por correo.
