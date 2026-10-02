# Proyección de caja a 13 semanas

«¿Me alcanza?» contestado semana a semana: con cuánto arranca la caja, qué se espera que entre y salga cada semana (lunes a domingo, días de Bogotá), con qué queda, cuál es la semana más apretada y por qué. Cada línea trae su razón en español («vence el 3 nov; Nexa Logística suele pagar 12 días tarde (6 facturas); se cuenta el 96%») y la proyección dice sus supuestos en una lista: nada de caja negra.

Es un motor **puro** (no lee la base ni el reloj): entra un `ForecastInput` y sale un `ForecastResult`, el contrato de `packages/agent-tools/src/ledger/types.ts`. `ledger/plans.ts` (`buildForecastInput`, `runForecast`) lee el libro y los planes guardados (migración 0173) y arma la entrada; lo usan la pantalla de Finanzas, el centro de mando, las vistas (`cortex.flujo_caja`, `cortex.pyg`), el pulso, la revisión semanal y las herramientas del chat.

## Piezas
| Archivo | Qué hace |
|---|---|
| `ledger/behavior.ts` | `behaviorFromHistory(movements, { asOf })`: atraso típico (mediana) y tasa de cobro de cada cliente a partir de sus facturas por cobrar. `companyBehavior`: el cliente promedio. |
| `ledger/recurring.ts` | `detectRecurring(movements, asOf)`: lo que se repite cada mes o cada semana (nómina, arriendo, PILA, servicios, combustible…). |
| `ledger/forecast.ts` | `forecast(input)`: las semanas, la más baja, las alertas y los supuestos. |
| `ledger/scenario.ts` | `describeScenario(s)` y la aplicación de ajustes (`delay_counterparty`, `drop_counterparty`, `add_recurring`, `scale_category`, `one_off`). |
| `ledger/forecast-explain.ts` | `explainWeek(result, día)` (líneas ordenadas por peso + una frase) y `compareScenarios(base, escenario)` (delta por semana + «Si Nexa paga 30 días más tarde, la caja más baja pasa de $ 20,5 M a $ 15 M en la semana del 23 nov.»). |
| `ledger/forecast-shared.ts` | Fechas de Bogotá, cifras («$ 4,5 M»), nombres y categorías. |
| `ledger/plans.ts` | Escenarios guardados (`listScenarios`, `saveScenario`, `deleteScenario`), recurrentes declarados y decisiones sobre los detectados (`listRecurringDecisions`, `declareRecurring`, `decideDetectedRecurring`), `buildForecastInput` / `runForecast`, y `monthlyPnl` (PyG de caja por mes). |
| `ledger/payables.ts` | Ata las salidas del banco a las facturas por pagar que pagaron (contraparte, valor ±1%, después de emitida) y las salda; reversible. Corre en cada `syncLedger` y al importar un extracto. |
| `ledger/privacy.ts` | La nómina con nombres sólo para `org_admin`; para los demás, «Nómina (confidencial)». |
| `ledger/forecast-tools.ts` | `ledger.forecast`, `ledger.explain_week` (lectura), `ledger.save_scenario`, `ledger.declare_recurring`, `ledger.decide_recurring` (piden confirmación). |

## Supuestos (los mismos que la proyección dice en palabras)
- **Caja inicial**: suma de los saldos de las cuentas en la moneda pedida. Otras monedas quedan por fuera, sin convertir, y se dice. Sin cuentas, arranca en 0. Un saldo de hace más de 7 días se señala.
- **Cobros**: saldo pendiente (`outstanding`, o el monto) en el vencimiento + el atraso típico del cliente, ponderado por su tasa de cobro.
  - Atraso: mediana de días entre vencimiento y pago (pagar antes cuenta como 0). Con menos de 5 facturas se encoge hacia el promedio de la empresa (como si hubiera 3 facturas promedio más), y la razón lo dice.
  - Tasa de cobro: cobradas / (cobradas + vencidas hace más de 90 días), siempre suavizada con 3 facturas promedio (6 de 6 ≠ certeza). Las anuladas no cuentan para nada: una nota crédito no es un mal pagador. Sin historia en la empresa: a tiempo y 95%.
  - Ya vencida pero dentro de lo que el cliente suele demorarse: cuando suele pagar. Más tarde que eso: se reparte en 2 a 6 semanas desde hoy (más vieja, más repartida) y pierde probabilidad: 90 días después de su atraso típico cuenta la mitad.
  - Factura sin vencimiento: 30 días desde la emisión.
- **Pagos**: el día que vencen. Vencidos: esta semana, con la nota «sigue sin pagar». Vencidos hace más de 60 días sin una salida del banco que coincida: «¿ya la pagaste? lleva N días vencida», contados al 50% y la mitad cada 60 días más (piso 10%). Los que una salida del banco ya pagó quedan saldados en el libro (`payables.ts`) y no aparecen.
- **Lo que se repite**: se detecta del historial liquidado y se le SUMA lo declarado (`recurring`); si hablan de lo mismo (misma `detectedKey`, o misma contraparte —o categoría si a alguno le falta—, mismo sentido y periodicidad, día ±6) manda lo declarado. Lo ignorado por una persona (`ignoredRecurring`) no entra; lo confirmado lo dice en su razón. `detectRecurring: false` usa sólo la lista. La detección: ≥ 3 veces, mensual (mismo día ±6, en meses casi seguidos; el 30 y el 1 son vecinos; la quincena sale como dos mensuales) o semanal (~7 días), visto hace menos de 45 / 14 días, monto = mediana de las tres últimas, montos estables (±35%). Lo bimestral, anual o irregular no se proyecta. No se detectan cobros de facturas (eso es comportamiento, no calendario). Cada detectado lleva una `detectedKey` estable (contraparte o firma, periodicidad y día) para que las decisiones sigan valiendo.
- **Sin contar dos veces**: una ocurrencia que ya está como movimiento abierto (misma contraparte, o misma categoría y palabras, monto ±35%, fecha ±12 días mensual / ±3 semanal) se omite: el arriendo de octubre ya facturado no se suma al proyectado.
- **Gasto fijo que no aparece**: si uno detectado debía pasar en los últimos 5 días y no hay pago ni factura, se cuenta esta semana.
- **Caja mínima**: la que se fije o, si no, un mes de los gastos que se repiten.
- **Ventas estimadas** (`includeEstimatedSales`, por defecto sí): a cada cliente con factura (o ingreso de venta) en 3 o más de los últimos 6 meses se le proyecta lo que falta facturar cada mes: su promedio de esos 6 meses (los meses sin factura cuentan como 0), menos lo ya facturado ese mes, el día que suele facturar, cobrado con su plazo mediano y su atraso típico, contado al 60% de su tasa de cobro. Líneas «Ventas estimadas a <cliente>», `from: 'estimate'`. Un cliente que ya entra como ingreso que se repite no se estima. Fuera de eso, lo no facturado no entra; un escenario (`add_recurring`) sirve para suponer ventas nuevas.

## Alertas
- `negative_cash` (crítica): la primera semana en rojo y la más baja. Si la hay, no se repite como `low_cash`.
- `low_cash` (aviso): la semana más baja queda por debajo de la caja mínima.
- `concentration`: un cliente es más del 40% de lo que se espera cobrar.
- `late_payer`: cliente que suele pagar ≥ 30 días tarde o cobra < 75% (≥ 2 facturas), o con cartera vencida hace más de 60 días.
- `big_outflow`: hasta 3 pagos no recurrentes ≥ máx(un mes de gastos fijos, 25% de la caja inicial); aviso si caen en una semana ya apretada.

## Límites
- Una sola moneda por proyección; no convierte.
- Un saldo viejo no se completa con los movimientos posteriores.
- Las facturas abiertas que llevan poco vencidas no informan el atraso del cliente (sólo las pagadas): un cliente que se está atrasando ahora se ve tarde. Las vencidas hace más de 90 días sí bajan su tasa de cobro, y además decaen por edad: doble prudencia a propósito.
- Lo «cada 14 días», bimestral o anual (primas, impuestos) no se detecta; hay que declararlo o ponerlo como escenario.
- La `detectedKey` incluye el día: si un gasto fijo cambia de día (del 5 al 15), es otro recurrente y la decisión anterior no lo alcanza.
- Saldar una factura por pagar con el banco no tiene todavía un «no era esa» de una persona: se deshace sola sólo si la salida deja de contar.
- Determinista: misma entrada, mismo resultado (sin reloj, sin azar, orden estable).
