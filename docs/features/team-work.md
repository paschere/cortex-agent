# Trabajo del equipo: cifras y señales

«¿Cómo va el equipo?» contestado con evidencia, no con una nota. Para cada persona: qué tiene abierto, qué ya venció, qué cerró, qué tanto a tiempo, cuánto tarda y qué produjo, por tipo de trabajo y por día trabajable. Encima, unas pocas señales («Laura tiene 16 despachos abiertos, 7 vencidos; la mediana del equipo en despachos es 4») con sus cifras y algo concreto que hacer («Reasignar 5 a Andrés Restrepo (tiene 3 despachos pendientes) y 3 a Sofía Martínez (tiene 4)»).

Es un motor **puro** (no lee la base ni el reloj): entra el registro de trabajo (`WorkItem[]`, `WorkPerson[]`, el contrato de `packages/agent-tools/src/work/types.ts`) y sale un `TeamWorkReport`. El registro (store, adaptadores, herramientas) lo llena desde casos de Gerencia, vencimientos, filas con responsable, cartera, aprobaciones y solicitudes.

## Piezas
| Archivo | Qué hace |
|---|---|
| `work/metrics.ts` | `personStats(items, persona, período, tipo \| 'all', { asOf, holidays })` → `PersonWorkStats`. `teamBaselines(stats)` → medianas por tipo y 'all'. Días trabajables, festivos, la foto al cierre, horas de ciclo. |
| `work/signals.ts` | `detectSignals({ current, previous, baselines, items, people, period?, asOf? })` → `WorkSignal[]` ordenadas (gravedad, tipo de señal, persona). |
| `work/report.ts` | `buildTeamReport({ items, people, period, previous?, asOf?, holidays? })` → `TeamWorkReport` con `notes`. `describePerson(report, personId, items?)` → el párrafo de «Mi semana». |
| `work/metrics.fixtures.ts` | Logística Andina S.A.S.: 6 personas, despachos, cobros, casos y solicitudes. |

## Qué se mide (por persona, período y tipo de trabajo)
- **Abiertos al cierre** (`openNow`): abiertos ese día y cerrados después, o nunca. El período anterior se mide con la foto de SU cierre, no con la de hoy. Si el período sigue en curso, la foto es al `asOf`.
- **Vencidos** (`overdueNow`): de los abiertos, los que vencían antes del día del cierre (el que vence hoy no está vencido).
- **Cerrados en el período** (`done`), y por **día trabajable**.
- **A tiempo** (`onTimeRate`): de los cerrados CON vencimiento, los cerrados ese día o antes (días de Bogotá). `withDue` dice la base. Sin vencimientos es nulo, no cero.
- **Horas de ciclo** (`medianCycleHours`): mediana de abrir a cerrar. Fecha sin hora = medianoche de Bogotá; instante sin zona = hora de Bogotá.
- **Lo producido** (`output`): suma de `quantity` de lo cerrado, por unidad (guías, COP…).
- **Días trabajables**: lunes a viernes, menos festivos de Colombia (los 18 de la Ley 51 de 1983, calculados para cualquier año, los mismos de Gerencia en `management/follow-up.ts`), menos los `awayDays` de la persona (vacaciones, incapacidad). Un día fuera que ya era sábado o festivo no se descuenta dos veces.
- **Muestra** (`sample`): ítems distintos detrás de las cifras (abiertos al cierre + cerrados).

## Qué nunca se mide
- Nunca una nota única de «rinde / no rinde», ni un ranking: el reporte ordena a las personas alfabéticamente y ninguna estructura tiene puntaje.
- Nunca el contenido de chats, correos o mensajes personales: sólo trabajo registrado (tareas, casos, cobros, despachos, solicitudes).
- Lo cancelado no cuenta en contra. Lo marcado como hecho sin fecha de cierre no cuenta (no se sabe cuándo).
- Los días fuera y los festivos no cuentan en contra.

## Cómo se compara
1. **Peras con peras**: por tipo de trabajo (un despacho no se compara con un caso) y por día trabajable.
2. **Primero contra su propia historia** (el período anterior del mismo largo), **después contra la mediana del equipo** en ese tipo. Entra en la mediana de un tipo sólo quien tuvo trabajo de ese tipo en el período: quien no despacha no baja la mediana de despachos con un cero.
3. **Muestras chicas se dicen, no se interpretan**: con menos de 8 cerrados no hay «bajó», «mejoró» ni «destaca»; con menos de 3 días trabajables no se compara por día; con menos de 3 personas en un tipo nadie se destaca contra la mediana.

## Señales
Cada señal trae `message` (español, cifras es-CO), `evidence` (todas las cifras de la frase y de la sugerencia, con el mismo redondeo; porcentajes como enteros), `suggestion` y, cuando aplica, `itemIds`. Los títulos de ítems van en la evidencia como texto. Las pruebas verifican que cada número escrito está en la evidencia.

| Señal | Cuándo | Gravedad |
|---|---|---|
| `overloaded` | Abiertos ≥ máx(2 × mediana, mediana + 5) en ese tipo (≥ 2 personas en el tipo). Sugiere a quién pasarle cuántos: los de menor carga en el mismo tipo, que no estén fuera hoy, de uno en uno al que menos tiene, hasta emparejar. | warn; critical si ≥ 3 × mediana y ≥ mediana + 10, o la mitad o más ya venció. |
| `overdue_pile` | Vencidos ≥ 5, o ≥ 3 y ≥ 50% de lo abierto (todos los tipos). Si la persona está fuera hoy, se pide cubrirla. | warn; critical si ≥ 10, o ≥ 5 y ≥ 50%. |
| `slowing` | Cerrados por día trabajable −40% contra su período anterior, mismo tipo, con ≥ 8 cerrados antes, ≥ 3 días trabajables en ambos y algo esperando (si no queda nada abierto, llegó menos trabajo). Dicho como pregunta: «¿Hay algo frenando a …?». | siempre info. |
| `improving` | Contra su propia historia, ≥ 8 cerrados en ambos: cerrados por día +40% (si el a tiempo no cayó más de 10 puntos), a tiempo +20 puntos (≥ 8 con fecha en ambos), o ciclo −30%. | info. |
| `standout` | Sólo si no hubo `improving`. Contra la mediana (≥ 3 personas), ≥ 8 cerrados: ≥ 1,5 × la mediana de cerrados por día sin estar por debajo en a tiempo, o ≥ 95% a tiempo cuando la mediana es ≤ 80%. | info. |
| `unassigned_pile` | ≥ 5 abiertos sin responsable en un tipo. Sugiere repartirlos entre los dos de menor carga que han hecho ese tipo. | warn; critical si ≥ 15 o ≥ 5 vencidos. |
| `stale_item` | Abiertos quietos (desde `lastActivityAt`, o desde que se abrieron) más del doble de la mediana de ciclo de su tipo (mínimo 24 horas; la mediana necesita ≥ 5 cerrados entre este período y el anterior). Una señal por tipo con los 3 más quietos. | info; warn si ≥ 5 o alguno venció. |

## «Mi semana» (`describePerson`)
En segunda persona y con tono de apoyo: lo que cerró (y en cuántos días; los días fuera se dicen), a tiempo con su base («7 de 9»), lo producido, lo que la espera (y, con `items`, lo primero), lo que mejoró o en qué destaca. La carga alta se dice como «se sugirió repartir, no es un reclamo»; una baja, como «si algo te está frenando, dilo». Sin historia: «esto es sólo la foto de hoy».

## Límites (los mismos que el reporte dice en `notes`)
- Sin vencimiento no se mide a tiempo (los casos de Gerencia suelen no tenerlo).
- Sin `lastActivityAt`, «quieto» cuenta desde que se abrió.
- No se sabe cuándo se canceló algo: lo cancelado sale de todas las fotos, también de las pasadas.
- Lo que no se registra no aparece: una persona con trabajo fuera del registro se ve con menos cerrados. Por eso «bajó» es una pregunta, nunca una conclusión.
- El género de los tipos («solicitudes vencidas», «despachos vencidos») sale de una heurística por terminación.
- Determinista: misma entrada, mismo resultado, sin importar el orden de los ítems o las personas.

## Privacidad
- Cada persona puede ver todo lo que se mide de ella (`describePerson` usa sólo sus cifras y las medianas del equipo, nunca las de otra persona con nombre).
- Las señales con nombre (sobrecarga, vencidos, baja) son para quien reparte el trabajo; la sugerencia siempre es de redistribuir o preguntar, nunca de sancionar.
- El motor no guarda nada: recibe ítems ya filtrados por empresa y devuelve cifras.
