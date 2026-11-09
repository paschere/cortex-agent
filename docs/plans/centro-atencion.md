# Centro de atención en vivo, operario sin señal y manifiesto (Operación de carga v6)

Pantalla nueva `centro` para supervisor, documental y gerencia, más escritura sin señal en `campo`
y ajustes del manifiesto.

## Centro de atención (`screens/centro.tsx`, `lib/centro.ts`)
- Tiempo real: `useCarga(..., tablasVivo)` recarga en 1–2 s cuando cambia una tabla (`cortex.live`);
  el sondeo queda de respaldo (`RESPALDO_VIVO_MS`, 2 min). Tablero, bandeja, torre, eventos y campo
  también van en vivo.
- Indicador «En vivo» / «Reconectando…» (`useLiveStatus`). Contadores con número animado:
  atenciones abiertas, sin tomar, críticas sin ver, cerradas hoy.
- Feed de novedades de hoy (eventos + novedades de atención + novedades de guía): entran animadas,
  críticas destacadas, «hace 12 s» corriendo, filtros Críticas · Sin ver · Vuelos · Tareas · Todo.
  Sonido WebAudio y vibración para críticas nuevas; silenciar se recuerda en localStorage.
- «Lo vi» / «Lo tomo» escriben `visto_por`, `visto_en`, `tomado_por` en `eventos_operacion`.
  Las novedades de atención y de guía no tienen esos campos: su «visto» queda solo en el equipo.
- Crítica sin ver pasados `OBJETIVOS.escalaCriticaMin` (10 min) = «Escalada» en rojo.
- Atenciones activas con cronómetro por etapa (llegó → tomado → en proceso → cerrado), ámbar al 75 %
  del objetivo y rojo al pasarlo. TODOS los objetivos están en `OBJETIVOS` (`lib/centro.ts`).
- Operarios en turno: qué hacen y desde cuándo, con su última ubicación (`useLocations`).
- Modo TV: pantalla completa (si el marco la permite; si no, ocupa la ventana), letra grande,
  tema oscuro opcional y rotación de secciones tras 20 s sin tocar nada.
- Clic en una novedad: panel lateral de vista rápida (hoja en móvil) con tarjeta de embarque, etapas
  y línea de tiempo del vuelo.

## Operario sin señal (`screens/campo.tsx`, `lib/SinSenal.tsx`, `lib/enVivo.ts`)
Todas las escrituras de campo (tomar, guardar/cerrar atención, equipos, eventos, inicio/fin de tarea,
fotos) usan `{ offline: true }`. Barra «N cambios esperando señal · Reintentar» (`useOutbox`) y lo
encolado aparece en las listas como «Pendiente de enviar». Al cerrar una tarea sin señal los costos
se calculan con lo que la pantalla ya tenía.

## Manifiesto
Peso con coma decimal y punto de miles en la impresión (`1.250,50`); en Excel es número con formato
de celda `#,##0.00` (la coma la pone Excel según la región). Logos de las aerolíneas incrustados como
PNG en data URI (`lib/manifiesto-logo.ts`, fuente Wikimedia Commons); UNITED y CARGOJET no tienen
versión estable y llevan logotipo tipográfico.

## Datos (script fuera del repo)
`/Users/paschere/Developer/cortex-ops/operacion-carga/centro/` (mismo patrón que `manifiesto/`):
campos `visto_por`, `visto_en`, `tomado_por`, `escalado` en `eventos_operacion`; documental y
gerencia editan solo los tres primeros; regla «Crítico sin ver: escala…» con espera de 10 min
(`wait` + `stillIf visto_por vacío`) que marca `escalado` y avisa a supervisor y gerencia.
El aviso al crearse un evento crítico ya existía.
Aplicar: `./verificar` (ensayo con ROLLBACK, `railway run … node verificar.mjs`) y luego `./aplicar.sh`;
revertir con `./aplicar.sh deshacer.sql`. Refrescar `captura.json` con `capturar.mjs` antes.
Pantalla registrada en `operacion-carga/pantallas.json` (posición 1, tras Tablero).

## Pendientes
- Aplicar los datos del centro en producción (sin ellos «Lo vi» avisa que faltan campos).
- Si cambia `escalaCriticaMin`, cambiar también `ESCALA_MIN` en `centro/gen.ts` y regenerar.
