# Piloto automático

Cada mañana Cortex arma el plan del día de una empresa, **hace** lo rutinario que tiene permitido y le deja al dueño una lista corta con lo que de verdad necesita su decisión: «Hoy hice 6 cosas; necesito tu decisión en 3». Nace **apagado**: lo enciende un administrador o el dueño en `/piloto` (o en el chat: «hazte cargo de la cobranza»).

## Cómo decide

1. **Recolectar** (`autopilot/collectors.ts`, puros). Una fotografía de la mañana (`sources.ts`, una lectura aislada por fuente) se vuelve `PlanItem`s con su evidencia y cifras:

   | Área | Qué ve | Qué propone |
   |---|---|---|
   | cobro | factura vencida con saldo (escalones 1/30/60/90 días) | correo de cobro al contacto principal del cliente (`gmail.send_message`); sin contacto, sólo lo cuenta |
   | pagos | pagos vencidos / de la semana, multas | nada: nunca mueve plata, sólo cuenta |
   | conciliacion | crédito del banco que casa **sin duda** con una sola factura | `payments.apply_to_invoice`; lo dudoso se cuenta |
   | finanzas | movimientos del libro sin categoría; alertas de caja (rojo / bajo el mínimo) | `ledger.categorize_pending`; las alertas se cuentan |
   | procesos | carpeta de Drive, tabla o programa contable con la última vuelta en error | `trackers.retry_sync` / `accounting.sync_now` |
   | vencimientos | compromiso que vence en ≤ 2 días con responsable | `autopilot.remind` (campana del responsable); lo vencido se cuenta (el resumen diario de vencidos ya se lo dice a cada quien) |
   | equipo | persona sobrecargada (señal `overloaded` del registro de trabajo) | `work.assign` concreto por receptor |
   | gerencia | aprobaciones paradas > 48 h | se cuentan (el recordatorio a cada responsable ya existe, 0177) |

2. **Historia** (`plan.ts`). Lo hecho o descartado en los últimos 7 días no se vuelve a plantear; lo que sigue esperando decisión no se pide otra vez. La clave (`dedupeKey`) es la cosa, no el día: la misma factura en otro escalón de mora sí vuelve.

3. **Política** (`policy.ts`, pura). Por cosa: **hacer**, **preguntar** o **contar**:
   - sin acción o área en «avisar» → contar;
   - mueve plata → preguntar, siempre (con o sin mandato, con o sin «hacer»);
   - área en «proponer» o riesgo alto → preguntar;
   - mensaje externo a un cliente → **siempre preguntar**, con el correo listo: los envíos de correo (`gmail.send_message`, `gmail.send_draft`, `outlook.send_draft`) son `external_send` en `security/policy.ts` y la doctrina no los deja salir sin nadie mirando, ni con un mandato desatendido (promesa de 0099). Otros mensajes externos que la doctrina sí permita desatendidos siguen la regla del mandato (`applies_unattended`) y el tope de mensajes del día;
   - interno y rutinario (`ROUTINE_TOOL_IDS`) de riesgo bajo con el área en «hacer» → hacer; si no, sólo con mandato;
   - topes del día (acciones por corrida, plata mencionada en la moneda de la empresa) → lo que no cabe se pregunta.
   La política consulta la misma doctrina que `runTool` (`classify` + `decide` + `applyMandate` con `surface: 'schedule'`), así que sólo dice «hacer» a lo que de verdad va a pasar.

## La corrida (`run.ts`, dependencias inyectadas)

- `autopilot/dispatch` (cada hora y 5) reparte las empresas cuya hora (Bogotá) es la actual; `autopilot/workspace` corre una. Días, festivos de Colombia y días quietos los decide `runGate`.
- **Una corrida por empresa y día** (índice único `autopilot_runs (organization_id, run_on)`); un reintento retoma la misma corrida y ejecuta sólo lo que quedó en cola.
- Cada acción va por `runTool` como **quien encendió el piloto**, con `idempotencyScope = autopilot:<día>:<clave>` (acciones seguras, 0168). Lo rutinario pasa como confirmado (el dueño lo encendió, igual que `allow_unattended_writes`); bajo mandato, lo levanta el mandato y queda en `mandate_uses`.
- **Interruptor**: la configuración se relee antes de cada acción; apagarlo detiene lo que falta (queda «omitido»).
- Un fallo no bloquea a los demás. Techo de 8 minutos por corrida.
- Lo que espera decisión: los correos a clientes van a la cola de aprobaciones de siempre (`actions`, con su huella); lo demás se aprueba desde `/piloto/<corrida>` (reclamo condicional con la huella de lo que se vio, ejecución como quien aprueba).
- Al final, UN aviso al dueño (campana, clase `management_attention`) y, si lo pidió, un correo.

## Datos (migración 0176)

`autopilot_settings` (por empresa: encendido, hora, días, festivos, días quietos, nivel por área, topes, actor), `autopilot_runs` (una por día, cuentas y resumen), `autopilot_items` (cada cosa: evidencia, decisión y razón, herramienta e input, estado, resultado, verificación, enlace para deshacer, propuesta en `actions`). Tenant las tres.

## Pantallas y chat

- `/piloto`: hoy («lo que hice hoy»), «Probar sin hacer nada» (el plan real sin ejecutar), interruptor, niveles, horario y topes, días anteriores. `/piloto/<corrida>`: la línea de tiempo con verificación, deshacer y aprobar/descartar.
- Inicio: «Piloto automático: hoy hice N, te esperan M» (sólo si está encendido o corrió hoy).
- Herramientas: `autopilot.plan` (ensayo), `autopilot.status` (últimas corridas), `autopilot.configure` (confirmación; administradores o dueño), y las rutinarias `autopilot.remind`, `trackers.retry_sync`, `ledger.categorize_pending`.
- Vitrina de desarrollo: `/v/piloto-showcase?pantalla=inicio|corrida|ensayo|tarjeta&apagado=1&vacio=1&modo=oscuro` (404 en producción).

## Pruebas

`autopilot/collectors.test.ts` (recolectores con Transportes Andinos, configuración, plan), `policy.test.ts` (la matriz), `run.test.ts` (orquestación con base y `runTool` de mentira: idempotencia por día, aislamiento de fallos, interruptor, techo de tiempo, ensayo = plan real menos ejecución) y `autopilot.sql-test.mjs` (0176 en PGlite).
