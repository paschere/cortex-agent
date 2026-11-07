# Operación de carga v5 — rediseño completo

Pedido del dueño (2026-11-07): «mejora toda la app, mejor diseño, todo mejor; busca ejemplos en internet».

## Hallazgos de la investigación (patrones, no copias)
Fuentes: Inform GroundStar (turnaround Gantt con línea de «ahora», GS TeamWork asignación móvil),
Assaia ApronAI (hitos de turnaround, mapa + lista), CargoWise (colas de trabajo con siguiente acción),
guías de UX de campo (resco.net, app-fabric) y de tableros en vivo (UXmatters 2025, Juice Analytics, xenia).

Principios:
- **Por excepción:** lo normal sobrio, lo que se atrasa/difiere resalta y sube. «Actualizado hace Xs» siempre visible; aviso si el dato está viejo.
- **Siguiente acción** visible en cada fila/tarjeta (qué sigo), una sola acción primaria por pantalla en móvil, botón de ancho completo al alcance del pulgar.
- **Resumen arriba, detalle abajo:** 4–5 cifras clicables que filtran; panel lateral de detalle sin perder el contexto (escritorio) / hoja inferior (móvil).
- **Campo (sol, guantes):** objetivos ≥ 56 px, contraste ≥ 7:1 en datos críticos (nada de grises medios), steppers +/− grandes y teclado numérico, eventos de un toque que sellan la hora, foto dentro del flujo con estado «en cola», etiqueta en cada ícono.
- **Estados:** color + texto + ícono (nunca solo color). Verde listo/en tiempo, ámbar en riesgo, rojo atrasado/bloqueado, azul en curso, gris pendiente.
- **Dos densidades:** campo espaciosa; escritorio compacta (filas 36–40 px, tablas densas con encabezado fijo).
- **Gerencia:** una pregunta por tarjeta (cifra grande + variación vs periodo anterior + mini gráfico), periodo comparable, desglose al tocar, frase narrativa automática, gráficos simples (barras, líneas, bullet de meta).
- **Movimiento:** 120–200 ms, solo para confirmar (contador que sube, tarjeta que cambia de columna) o dato en vivo; respeta prefers-reduced-motion; nada decorativo en campo.
- Evitar: tablas anchas en móvil, gestos como única vía, modales encadenados, confirmación en cada paso (mejor deshacer), alertas por todo.

## Momentos wow
1. Tomar vuelo → atención prellenada, conteo esperado vs real que se llena en vivo y celebra al cuadrar en cero.
2. Tablero tipo Gantt del día con línea de «ahora» que avanza y tarjetas que cambian de color al acercarse al atraso.
3. Manifiesto: soltar archivo → detección en segundos, solo lo dudoso resaltado.
4. Asignar: elegir/arrastrar a un operario (escritorio) y su teléfono recibe el aviso.
5. Costo del vuelo/tarea calculado al tocar «Terminé», visible para operario y gerente.
6. Gerencia en una frase + cifra («Hoy: 4 vuelos, 1 atrasado, costo por kilo −6 %»), con tocar para ver por qué.
7. Ficha de vuelo con línea de tiempo vertical (quién, qué, cuándo) de todo lo que pasó.
8. Barra de comandos (Ctrl/Cmd+K) en escritorio para saltar a un vuelo, guía o tarea.
