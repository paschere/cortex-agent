# Programas contables conectados directo

Un administrador conecta el programa de contabilidad de la empresa una vez y Cortex trae solo clientes, productos, facturas de venta y pagos recibidos a tablas de la empresa, y las facturas con saldo a la cartera y a «plata en riesgo». Hoy: **Siigo Nube**. Alegra y QuickBooks Online aparecen como «Próximamente» y usan la misma capa. Migración `0165_accounting_connectors.sql`.

## Cómo se usa
- **Integraciones → Programas contables** (sólo dueños y administradores). En la tarjeta de Siigo: *Usuario API* y *Access key* (Siigo Nube → Alianzas → «Mi credencial API»), qué traer, cada cuánto (60 min por defecto, de 15 min a un día) y si avisa. **Probar y conectar** autentica contra Siigo y lee una fila antes de guardar: una llave que no sirve no se guarda.
- Después: estado (al día / trayendo la primera carga / error en español), qué trajo la última corrida con enlace a cada tabla, **Sincronizar ahora**, **Ajustes** (qué traer, frecuencia, avisos, pausa), **Cambiar llave** y **Desconectar** (borra la llave; las tablas, la cartera y los pagos se quedan).
- En el chat: `accounting.status` (cómo va, qué tablas llena, último error) y `accounting.sync_now` (trae ya, pide confirmación). Conectar no se hace desde el chat: la llave nunca pasa por el modelo.

## Qué llega a dónde
| Siigo | Tabla de la empresa | Además |
|---|---|---|
| Clientes (`/v1/customers`) | «Clientes (Siigo)» `siigo_clientes` | nombres para facturas y pagos |
| Productos (`/v1/products`) | «Productos (Siigo)» `siigo_productos` | — |
| Facturas de venta (`/v1/invoices`) | «Facturas (Siigo)» `siigo_facturas` (número, cliente, NIT, fecha, vence, total, saldo, estado, factura electrónica…) | `accounting_invoices` → cartera y plata en riesgo |
| Recibos de caja (`/v1/vouchers`) | «Recibos de caja (Siigo)» `siigo_pagos` | Pagos, por `importSystemPayments` con `source_system = 'siigo'` |

- Cada fila se identifica por el id de Siigo (`tracker_rows.external_key`): nueva se agrega, cambiada se actualiza, igual no se toca. Los campos que el equipo agregue a la tabla («gestor», «notas») no se pisan. Las tablas sirven para vistas como cualquier otra.
- **Cartera**: las facturas de Siigo entran con el **saldo que dice Siigo**, que ya descontó sus recibos; por eso no se les resta ningún pago de Pagos. Una factura que también está como documento confirmado (mismo número, sin importar guiones) cuenta una vez, la del documento. Un recibo de Siigo que nombra una factura de Siigo no aparece como «pago sin atribuir». Los avisos de mora (0159) también cubren estas facturas (`receivable_notices.accounting_invoice_id`).
- Moneda: un documento de Siigo sin `currency` está en pesos (la moneda de la empresa en Siigo Nube Colombia); uno en dólares se queda en dólares.

## Cómo corre
- `accounting/dispatch` cada 15 min (pg-boss en `services/jobs` + Inngest de respaldo) → `accounting/run` por conexión vencida. La toma (`claimAccountingConnection`) impide dos corridas a la vez.
- Primera vez: el último año de facturas y recibos y todos los clientes y productos. Después: lo creado **y** lo modificado desde la corrida anterior (`created_start` / `updated_start`, 10 min de margen). Una vez al día, además, las facturas de los últimos 6 meses, porque un abono no siempre marca la factura como modificada.
- Cada corrida tiene 8 minutos. Si no alcanza (primera carga grande), anota dónde iba (`cursors.*.resume`), queda `partial` y se re-encola sola hasta terminar.
- Siigo permite 100 peticiones/min por empresa (10 en la empresa de pruebas): el cliente espera ~700 ms entre peticiones y ante un 429 reintenta con espera creciente o la de `Retry-After`. El token (24 h) se guarda cifrado y se renueva media hora antes de vencer.
- Campana (`table_sync`) para quien conectó: al terminar la primera carga, cuando entran facturas o pagos nuevos, y la primera vez que algo falla.

## Seguridad
- La llave (usuario + access key) se guarda como un blob cifrado (`credentials_enc`, AES-256-GCM con `TOKEN_ENCRYPTION_KEY`, igual que los tokens de OAuth), y el token en `token_enc`. Sólo `openAccountingSession` (accounting/store.ts) los lee; ninguna otra lectura los selecciona, y ninguna acción ni herramienta los devuelve.
- Tablas `tenant()`: `accounting_connections` y `accounting_invoices` con `organization_id`, RLS y sin acceso para `anon`/`authenticated`.

## Configuración
- `SIIGO_PARTNER_ID` (opcional, por defecto `Cortex`): el nombre de la integración que Siigo exige en la cabecera `Partner-Id` (3–100 letras/números, sin espacios).
- Aplicar la migración 0165 y **redesplegar el worker de Railway** (`services/jobs`): el manifiesto ganó `accounting/dispatch` y `accounting/run`.

## Sumar otro programa (Alegra, QuickBooks…)
Escribir `packages/agent-tools/src/accounting/providers/<programa>.ts` con la forma de `siigo.ts` — credenciales, `open()` (autenticar, listar por páginas) y la traducción a la forma común de `accounting/types.ts` — y registrarlo en `providers/index.ts`. El motor, las tablas, la cartera, los pagos, las herramientas y la tarjeta no cambian; `provider` ya acepta `alegra` y `quickbooks`. (QuickBooks usa OAuth: su archivo tendrá que guardar el refresh token en `credentials_enc` y renovarlo.)

## Límites
- Sólo lectura: Cortex no crea ni modifica nada en Siigo.
- Facturas de venta y recibos de caja; no notas crédito, compras, cuentas por pagar ni comprobantes contables (todavía).
- La cartera mira hasta 1.000 facturas abiertas por consulta, como el resto del módulo.
- Probado con pruebas unitarias (cliente con `fetch` falso: auth, paginación, 429, 401), mapeos con los ejemplos de la documentación oficial, el motor contra una base falsa, y la migración en PGlite; **no** contra una cuenta real de Siigo.
