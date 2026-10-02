# Acciones seguras de repetir

Un reintento del modelo, de la red, de un paso de Inngest/pg-boss o un doble clic en «Aprobar» ya no manda el mismo correo dos veces, ni crea el mismo evento, ni anota el mismo pago otra vez. Y las acciones importantes se **verifican** después de hacerse: «Verificado: el correo está en Enviados». Migración `0168_action_idempotency.sql`; el código vive en `packages/agent-tools/src/safe-actions/` y lo cumple `runTool` (`packages/agent-tools/src/registry.ts`), así que ninguna herramienta tiene que acordarse de nada.

## Qué ve la persona
- **En el chat**, si el modelo intenta repetir algo ya hecho, la herramienta no corre y el modelo recibe «Ya lo había hecho a las 10:42; no lo repetí». Si la persona dice «sí, envíalo otra vez», el modelo vuelve a llamar con `repeatConfirmedByUser: true` y la tarjeta de confirmación lo dice: «… · REPETICIÓN: ya se había hecho».
- **En `/approvals`**, una aprobación pendiente que repite algo que esa persona ya hizo dentro de la ventana avisa antes del botón: «Esto repite algo que ya se hizo a las 10:42. Aprobar lo hace otra vez.» Aprobarla ejecuta a sabiendas (`allowRepeat`). Una tarjeta sin aviso que llega tarde (otra igual ya se ejecutó) vuelve como «Aprobada; ya estaba hecha».
- **Fichas**: «Verificado», «No se pudo verificar» y «No repetido (ya hecho)» (y «Repetido a pedido») en el resultado de una aprobación y en `/admin/audit` (tabla y detalle), leídas de los metadatos de la fila de auditoría.

## Cómo funciona
1. **La huella.** `sha256(empresa, persona, herramienta, input canonizado, alcance)`. Canonizar: claves ordenadas, `null` = ausente, texto en NFC, recortado y con los espacios colapsados; el orden de los arreglos se respeta. El alcance sólo existe en las rutinas: `routine:<id>:<hora programada>` (`schedule-run.ts`), así un reintento de ese paso no repite el envío y la ejecución de mañana sí corre.
2. **Mirada previa** (después del bloqueo de seguridad, antes de pedir confirmación): si la misma acción ya salió bien dentro de su ventana, se devuelve lo de entonces con `_idempotency` — sin tarjeta y sin ejecutar. Si otra igual está en vuelo, se rechaza.
3. **El reclamo** (después de todas las puertas, antes de la fila `attempted`): `insert` en `action_idempotency`; si choca con la restricción única `(organization_id, key)`, se lee la fila y, si toca reintentar (falló, venció la ventana, o se pidió repetir), se toma con un compare-and-swap sobre `attempt_id` + `status`. Dos workers a la vez: uno ejecuta, el otro recibe «Esto mismo se está ejecutando ahora…».
4. **Al terminar**: `succeeded` (con el resultado si cabe en 8 kB, un resumen corto y `window_ends_at`) o `failed` (libera la clave: el siguiente intento ejecuta). Si el handler terminó pero su salida no valida, se da por hecha: el efecto casi seguro ocurrió.
5. **Verificar**: si la política tiene `verify`, corre con tope de 5 s y nunca rompe la llamada. Queda en la fila `ok` de `audit_events` (`metadata.verification`), en `action_idempotency.verification` y en el resultado como `_verification` (sólo `not_verified` pide al modelo que lo cuente).
6. **Un intento que quedó en vuelo más de 10 min** (el proceso murió): no se repite solo — «no sé si llegó a hacerse; revisa primero» — salvo que se pida repetir.
7. **Si la tabla no responde** (migración sin aplicar, base caída), la acción corre como antes y la auditoría lo marca `idempotency.outcome = 'unguarded'`.

## Qué herramientas
`safe-actions/catalog.ts` (una lista explícita; una herramienta puede declarar su propia `safeAction` en `registerTool` y esa gana):

| Herramienta | Ventana | Verificación |
|---|---|---|
| `gmail.send_message`, `gmail.send_draft` | 24 h | el mensaje tiene la etiqueta `SENT` |
| `outlook.send_draft` | 24 h | aparece en Enviados por conversación y asunto (Outlook manda en diferido: si aún no está, «no se pudo verificar», nunca «no se envió») |
| `gcal.create_event`, `mscal.create_event` | 24 h | el evento existe y no está cancelado |
| `payments.record` | 24 h | la fila de `payments` existe |
| `trackers.upsert` (sólo creación; con `rowId` no hay guardia) | 30 min | la fila de `tracker_rows` existe |
| `slack.post_message`, `chat.send_message`, `chat.send_dm`, `linear.create_comment`, `github.create_issue_comment` | 6 h | — |
| `linear.create_issue`, `github.create_issue` | 24 h | — |
| `gsheets.append_row` | 30 min | — |

Verificación: 404 → `not_verified`; cualquier otro fallo al consultar → `unverifiable` («no saber no es saber que no»).

## Declarar una herramienta nueva
```ts
registerTool({
  id: 'algo.send',
  // …
  safeAction: {
    windowMs: 24 * 60 * 60_000,       // 0 = sólo verificación
    noun: 'el mensaje',               // «Ya lo había hecho…»
    key: (input) => input.rowId ? null : input, // null = esta llamada sin guardia
    verify: async ({ input, output, ctx, startedAt }) => ({ status: 'verified', detail: '…' }),
  },
});
```
`registerTool` añade `repeatConfirmedByUser` al esquema que ve el modelo (sólo en esquemas `z.object`); `runTool` lo quita antes del handler y lo conserva en la petición de confirmación.

## Tabla y retención
`action_idempotency` (`tenant()` en `tenancy/tables.ts`): RLS activo, sin acceso para `anon`/`authenticated`, sólo `service_role`. Guarda la huella, nunca el input. `action_idempotency_purge()` (RPC `maintenance`) borra lo vencido hace más de dos días; corre en el barrido nocturno de latencias (`turn-latency/purge`, paso `sweep-action-idempotency`).

## Pendiente
- WhatsApp no tiene herramienta de envío propia (sólo respuestas de grupo por el canal), así que no hay verificación de estado de entrega.
- `slack`, `chat`, `linear`, `github` y `gsheets` tienen guardia pero no verificación.
- `hubspot.create_contact`/`create_deal` existen pero no están registradas (no salen del barril de `hubspot/`); si se registran, añadirlas al catálogo.
- La guardia la cumple el modelo para `repeatConfirmedByUser` («sólo tras pedirlo la persona»): la defensa es que la tarjeta de confirmación y la auditoría lo marcan.
