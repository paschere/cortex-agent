# Programas contables conectados directo

Un administrador conecta el programa de contabilidad de la empresa una vez y Cortex trae terceros, productos, facturas de venta y pagos recibidos a tablas de la empresa, y las facturas con saldo a la cartera y a «plata en riesgo». Siigo también trae facturas de compra a cuentas por pagar. Hoy: **Siigo Nube**, **Alegra** y **QuickBooks Online**, los tres sobre la misma capa (mismo motor, mismas tablas, misma cartera). La conexión usa la migración `0165_accounting_connectors.sql`.

## Cómo se usa
- **Integraciones → Programas contables** (`/integrations#programas-contables`, sólo dueños y administradores). En cada tarjeta: qué traer, cada cuánto (60 min por defecto, de 15 min a un día) y si avisa, más:
  - **Siigo**: *Usuario API* y *Access key* (Siigo Nube → Alianzas → «Mi credencial API»).
  - **Alegra**: *Correo de la cuenta* y *Token de la API* (Alegra → Configuración → «API - Integraciones con otros sistemas»).
  - En las dos, **Probar y conectar** prueba la llave contra el programa y lee una fila antes de guardar: una llave que no sirve no se guarda.
  - **QuickBooks Online**: no hay llave que pegar. **Conectar con QuickBooks** lleva a Intuit (OAuth), la persona elige la empresa y da permiso de sólo lectura (`com.intuit.quickbooks.accounting`), y la vuelta lee el nombre de la empresa y guarda el permiso. Si la instalación no tiene la app de Intuit configurada, la tarjeta dice «Falta configurar la app de QuickBooks…» y el botón queda apagado.
- Después: estado (al día / trayendo la primera carga / error en español), qué trajo la última corrida con enlace a cada tabla, **Sincronizar ahora**, **Ajustes** (qué traer, frecuencia, avisos, pausa), **Cambiar llave** (en QuickBooks, **Volver a conectar**) y **Desconectar** (borra la llave; en QuickBooks además le pide a Intuit revocar el permiso; las tablas, la cartera y los pagos se quedan).
- En el chat: `accounting.status` (cómo va, qué tablas llena, último error) y `accounting.sync_now` (trae ya, pide confirmación; sin decir cuál, el único conectado). Conectar no se hace desde el chat: la llave nunca pasa por el modelo.
- El autoservicio (Inicio / primeros diez minutos) ofrece «Tu programa contable», que lleva a esta sección.

## Qué llega a dónde
| Siigo | Tabla de la empresa | Además |
|---|---|---|
| Terceros (`/v1/customers`) | «Clientes (Siigo)» `siigo_clientes`, con relación Cliente / Proveedor / Otro | los clientes se vinculan al CRM; proveedores no se crean como clientes |
| Productos (`/v1/products`) | «Productos (Siigo)» `siigo_productos` | — |
| Facturas de venta (`/v1/invoices`) | «Facturas (Siigo)» `siigo_facturas` (número, cliente, NIT, fecha, vence, total, saldo, estado, factura electrónica…) | `accounting_invoices` → cartera y plata en riesgo |
| Recibos de caja (`/v1/vouchers`) | «Recibos de caja (Siigo)» `siigo_pagos` | Pagos, por `importSystemPayments` con `source_system = 'siigo'` |
| Facturas de compra (`/v1/purchases`) | — | Cuentas por pagar; historial reanudable |

| Alegra | Tabla de la empresa | Además |
|---|---|---|
| Clientes (`/contacts?type=client`) | «Clientes (Alegra)» `alegra_clientes` | nombres para facturas y pagos |
| Ítems (`/items`) | «Productos (Alegra)» `alegra_productos` | — |
| Facturas de venta (`/invoices`) | «Facturas (Alegra)» `alegra_facturas` (número `numberTemplate.fullNumber`, saldo `balance`, vence `dueDate`, estado open/closed/void; los borradores no entran) | `accounting_invoices` con `source_system = 'alegra'` |
| Pagos recibidos (`/payments?type=in`) | «Pagos recibidos (Alegra)» `alegra_pagos` (los anulados no entran) | Pagos con `source_system = 'alegra'` |

| QuickBooks Online | Tabla de la empresa | Además |
|---|---|---|
| `Customer` | «Clientes (QuickBooks)» `quickbooks_clientes` | nombres para facturas y pagos |
| `Item` (sin categorías) | «Productos (QuickBooks)» `quickbooks_productos` | — |
| `Invoice` | «Facturas (QuickBooks)» `quickbooks_facturas` (`DocNumber`, `TxnDate`, `DueDate`, `TotalAmt`, `Balance`, `CustomerRef.name`, `CurrencyRef`) | `accounting_invoices` con `source_system = 'quickbooks'` |
| `Payment` | «Pagos recibidos (QuickBooks)» `quickbooks_pagos` (una línea por factura de `Line[].LinkedTxn`; lo no aplicado, como pago sin factura) | Pagos con `source_system = 'quickbooks'` |

- Cada fila se identifica por el id del programa (`tracker_rows.external_key`): nueva se agrega, cambiada se actualiza, igual no se toca. Los campos que el equipo agregue a la tabla («gestor», «notas») no se pisan. Las tablas sirven para vistas como cualquier otra.
- **Cartera**: las facturas entran con el **saldo que dice el programa**, que ya descontó sus pagos; por eso no se les resta ningún pago de Pagos. Una factura que también está como documento confirmado (mismo número, sin importar guiones) cuenta una vez, la del documento. Un pago del programa que nombra una factura del programa no aparece como «pago sin atribuir». Los avisos de mora (0159) también cubren estas facturas (`receivable_notices.accounting_invoice_id`).
- Moneda: un documento de Siigo sin `currency` está en pesos (la moneda de la empresa en Siigo Nube Colombia); uno en dólares se queda en dólares. En Alegra, sin `currency` va la moneda de la empresa (`GET /company`); en QuickBooks, sin `CurrencyRef`, la de `Preferences.CurrencyPrefs.HomeCurrency` (cada una se pregunta una vez por sesión y sólo si hace falta).
- NIT: Alegra trae la identificación del cliente en la factura (se cruza con `clients.tax_id`). QuickBooks devuelve el número tributario enmascarado, así que sus facturas entran sin NIT y se nombran por el cliente.

## Cómo corre
- `accounting/dispatch` cada 15 min (pg-boss en `services/jobs` + Inngest de respaldo) → `accounting/run` por conexión vencida. La toma (`claimAccountingConnection`) impide dos corridas a la vez.
- Primera vez: Siigo recorre todos los terceros (incluidos proveedores e inactivos), los productos, el historial de facturas de venta, recibos de caja y facturas de compra disponible por API. Las compras se reanudan por página y tienen un repaso histórico cada 30 días. Alegra y QuickBooks conservan el último año inicial de facturas y pagos. Una vez al día se repasan las facturas de los últimos 6 meses, porque un abono no siempre marca la factura como modificada. Después, lo incremental depende del programa (10 min de margen en todos):
  - **Siigo**: lo creado **y** lo modificado desde la corrida anterior (`created_start` / `updated_start`).
  - **QuickBooks**: `MetaData.LastUpdatedTime >= …` en orden de modificación (una consulta cubre lo nuevo y lo cambiado).
  - **Alegra** no tiene filtro de «cambiado desde»: facturas con fecha desde 3 días antes de la corrida anterior (`date_afterOrNow`); pagos del más reciente al más viejo hasta 7 días antes (Alegra no filtra pagos por fecha, así que se corta al pasar la fecha); clientes y productos completos una vez al día (la primera corrida de cada día en Bogotá). Consecuencia: un abono a una factura vieja se ve en la tabla de pagos en la hora, pero el saldo de esa factura en la cartera se corrige en el repaso diario (hasta 24 h).
- Cada corrida tiene 8 minutos. Si no alcanza (primera carga grande), anota dónde iba (`cursors.*.resume`), queda `partial` y se re-encola sola hasta terminar.
- Siigo permite 100 peticiones/min por empresa (10 en la empresa de pruebas): el cliente espera ~700 ms entre peticiones y ante un 429 reintenta con espera creciente o la de `Retry-After`. El token (24 h) se guarda cifrado y se renueva media hora antes de vencer.
- Alegra: HTTP Basic (`correo:token` en base64) en cada petición, sin token de sesión. Páginas de 30 (`start`/`limit`, el máximo), con `metadata=true` para el total. 150 peticiones/min por usuario: ~450 ms entre peticiones; un 429 espera `X-Rate-Limit-Reset` (o `Retry-After`) y reintenta. 401 = llave mala; 402 = cuenta suspendida o plan sin API.
- QuickBooks: consultas `SELECT * FROM <Entidad> WHERE … ORDERBY … STARTPOSITION n MAXRESULTS 1000` en `/v3/company/{realmId}/query`, con `minorversion=75`. 500 peticiones/min por empresa: ~150 ms entre peticiones, 429 con backoff. El access token (1 h) se guarda cifrado en `token_enc` y se renueva 5 min antes de vencer o ante un 401 (una vez). **El refresh token rota**: cada renovación que devuelve uno nuevo lo guarda primero (la llave entera, re-cifrada en `credentials_enc` vía `ProviderTokenStore.saveCredentials`) y si no se puede guardar la corrida falla en vez de seguir con un permiso que se perdería. Un refresh token vencido o revocado (`invalid_grant`) deja el error «Vuelve a conectar desde Integraciones».
- Campana (`table_sync`) para quien conectó: al terminar la primera carga, cuando entran facturas o pagos nuevos, y la primera vez que algo falla.

## Seguridad
- La llave (Siigo: usuario + access key; Alegra: correo + token; QuickBooks: `realm_id` + refresh token + nombre de la empresa) se guarda como un blob cifrado (`credentials_enc`, AES-256-GCM con `TOKEN_ENCRYPTION_KEY`, igual que los tokens de OAuth), y el token de sesión en `token_enc`. Sólo `openAccountingSession` (accounting/store.ts) los lee; ninguna otra lectura los selecciona, y ninguna acción ni herramienta los devuelve. En QuickBooks la pantalla no recibe ningún campo de la llave (`credentialFields` vacío en `ProviderInfo`).
- OAuth de QuickBooks (`apps/web/app/api/integrations/quickbooks/route.ts` → Intuit → `…/callback/route.ts`): el `state` lleva un nonce que también queda en una cookie httpOnly (`qb_oauth_state`, 10 min), va firmado (HMAC-SHA256 con una llave derivada de `TOKEN_ENCRYPTION_KEY`, dominio propio) y atado a la persona y al espacio; la vuelta exige sesión de administrador del mismo espacio. Lo elegido en la tarjeta (qué traer, frecuencia, avisos) viaja dentro del `state` firmado (`lib/accounting/quickbooks-oauth.ts`). Las rutas usan la sesión (no están en `PUBLIC_PATHS`, igual que Google y Microsoft) y el cliente con alcance del espacio. Ningún token se registra ni va en una redirección.
- Tablas `tenant()`: `accounting_connections` y `accounting_invoices` con `organization_id`, RLS y sin acceso para `anon`/`authenticated`.

## Configuración
- `SIIGO_PARTNER_ID` (opcional, por defecto `Cortex`): el nombre de la integración que Siigo exige en la cabecera `Partner-Id` (3–100 letras/números, sin espacios).
- Alegra: nada de la instalación; cada empresa pega su correo y token.
- QuickBooks (en Vercel, donde corren la tarjeta, las rutas de OAuth y `accounting/run`):
  - `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`: la app de Intuit (developer.intuit.com → la app → Keys & credentials; las de producción piden completar el perfil de la app).
  - `QUICKBOOKS_ENVIRONMENT`: `production` (por defecto) o `sandbox` (empresas de prueba de Intuit, `sandbox-quickbooks.api.intuit.com`).
  - En la app de Intuit, Redirect URI: `<APP_BASE_URL>/api/integrations/quickbooks/callback` (o `QUICKBOOKS_REDIRECT_URI`, si tiene que ser otra; tiene que coincidir exacta).
  - Sin id ni secreto nada se cae: la tarjeta lo dice y no deja conectar.
- Aplicar la migración 0165 y **redesplegar el worker de Railway** (`services/jobs`): el manifiesto ganó `accounting/dispatch` y `accounting/run`.

## Sumar otro programa
Escribir `packages/agent-tools/src/accounting/providers/<programa>.ts` (y su `-client.ts`) con la forma de `siigo.ts`, `alegra.ts` o `quickbooks.ts` — credenciales, `open()` (autenticar, listar por páginas) y la traducción a la forma común de `accounting/types.ts` — registrarlo en `providers/index.ts` y ampliar el `check` de `provider` en `accounting_connections` (migración nueva). El motor, las tablas, la cartera, los pagos, las herramientas y la tarjeta no cambian. Un programa con OAuth declara `connect: 'oauth'` y `setupMissing()`, guarda su refresh token con `tokenStore.saveCredentials` y necesita sus rutas de inicio y vuelta como las de QuickBooks.

## Límites
- La sincronización sólo lee. Otras acciones del producto que escriben en el programa necesitan una aprobación independiente.
- La primera carga de compras de Siigo llega a cuentas por pagar; notas crédito, egresos, cotizaciones y comprobantes contables aún no tienen carga propia.
- Un pago anulado después de traído (Alegra `void`, Siigo) no se borra de Pagos; una factura borrada en QuickBooks (no anulada) se queda en la tabla y la cartera con su último saldo.
- Alegra: un pago a varias facturas sin el valor de cada una entra como un pago sin factura (no se reparte a ciegas).
- La cartera mira hasta 1.000 facturas abiertas por consulta, como el resto del módulo.
- Probado con pruebas unitarias (clientes con `fetch` falso: auth Basic de Alegra, paginación, 429, 401; en QuickBooks paginación de consultas, 401 → renovación con el refresh token nuevo guardado, 429, `invalid_grant`), mapeos con los ejemplos de la documentación oficial, el motor contra una base falsa con los tres programas, el `state` de OAuth, y la migración en PGlite; **no** contra cuentas reales de Siigo, Alegra o QuickBooks.
