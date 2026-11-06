# Asignación a operarios y tareas rápidas (Operación de carga v4)

Pedido del dueño (2026-11-06): asignar a operarios ESCOGIDOS de una lista (no «el primero que
toque»), y no solo vuelos sino tareas rápidas («ir a recoger X a Y», entregar, trasladar,
apoyar…). Por cada asignación el operario registra eventos de inicio, proceso, fin y uso de
equipos, y se calculan costos. Fácil y rápido.

## Plataforma (motor, general para cualquier app)
1. SDK `cortex.people.list(opts?: { roles?: string[] }): Promise<{ ref: string; name: string;
   roleKey: string; roleName: string; onShift: boolean }[]>` — reusa `listAssignablePeople`
   (packages/agent-tools/src/apps/location.ts), con su permiso `canAssignTasks`.
2. `cortex.user.me()` incluye `ref` con EL MISMO formato que `people.list` (para que una pantalla
   sepa si una fila está asignada a quien mira).
3. Regla `notify_app_user` con `to: { field: '<clave>' }`: avisa a las personas cuyos `ref`
   están en ese campo de la fila (texto con refs separados por coma). Mismo canal que hoy
   (campana + push), sirve para usuarios de la app y miembros de Cortex con rol.

## Datos (script)
### Tabla `tareas_operacion`
| campo | tipo |
|---|---|
| titulo | text |
| tipo | select: Recoger · Entregar · Traslado · Apoyo a vuelo · Revisión · Otro |
| descripcion | longtext |
| desde | text (lugar de origen) |
| hasta | text (lugar de destino) |
| vuelo | relation→vuelos (opcional) |
| asignados_ids | text (refs separados por coma) |
| asignados | text (nombres, para leer) |
| prioridad | select: Normal · Urgente |
| para_fecha | date |
| para_hora | time |
| estado | select: Asignada · En curso · Terminada · Cancelada |
| inicio | text ISO (Bogotá) |
| fin | text ISO |
| duracion_min | number |
| costo_equipos | number (COP) |
| costo_otros | number (COP) |
| costo_total | number (COP) |
| creada_por | text |
| notas_cierre | longtext |
| fotos | file (múltiple) |

### Campos nuevos
- `vuelos`: asignados_ids (text), asignados (text) — si tiene asignados, SOLO ellos lo toman.
- `eventos_operacion`: tarea (relation→tareas_operacion); al select `tipo` se le AGREGAN
  «Inicio», «En proceso», «Fin», «Uso de equipo» (sin quitar los existentes).
- `equipos_usados`: tarea (relation→tareas_operacion).

### Permisos
- supervisor: crea/edita/lee `tareas_operacion`; edita `vuelos.asignados_ids/asignados`.
- operario: lee `tareas_operacion` SOLO donde está asignado si el motor lo permite
  (filtro de fila por «contiene $user.ref»; si el motor solo tiene `equals`, lectura `all` y la
  pantalla filtra) y edita estado, inicio, fin, duracion_min, costo_*, notas_cierre, fotos;
  crea `eventos_operacion` y `equipos_usados` con `tarea`.
- documental: lee y crea tareas (también asigna).
- gerencia: lee.

### Reglas
1. Tarea nueva (o `asignados_ids` cambia) → `notify_app_user` `to: {field: 'asignados_ids'}`
   «Nueva tarea: {{titulo}}» con pantalla `campo`.
2. Vuelo con `asignados_ids` cambia → aviso a los asignados «Te asignaron el vuelo {{numero_vuelo}}».
3. Tarea terminada → aviso a supervisor con duración y costo.
4. Equipo usado con `tarea` y costo → la misma cuenta por pagar probable que ya existe
  (`ledger_payable`, revisa que la regla actual no exija `atencion`).

## Pantallas
- `asignar` (nueva, supervisor y documental): crear tarea en 10 segundos — botones de plantilla
  (Recoger, Entregar, Traslado, Apoyo a vuelo), desde/hasta con sugerencias de lugares usados,
  chips de operarios (de `people.list({roles:['operario']})`, primero los de turno abierto),
  prioridad, para cuándo. Debajo: tablero de tareas por estado (Asignada · En curso ·
  Terminada hoy) con quién, cuánto lleva, costo; reasignar o cancelar. Sección «Vuelos por
  asignar»: escoger operarios para un vuelo.
- `campo` (operario, mejora): arriba «Mis tareas» (tareas y vuelos asignados a mí) en tarjetas
  grandes. Flujo de una tarea: Iniciar (evento Inicio, hora, ubicación) → En proceso (nota
  rápida/foto/voz, evento) → Usé un equipo (tarifa del tarifario, cantidad, foto → equipos_usados
  con tarea + evento Uso de equipo) → Terminar (evento Fin, notas, fotos; calcula
  duracion_min y costo_equipos = suma de equipos de la tarea, costo_otros = suma de costos de sus
  eventos, costo_total). Vuelos asignados a otros NO aparecen para tomar; sin asignados sigue
  «el primero que toque».
- `costos` e `indicadores`: incluir tareas (costo por tipo de tarea y por operario, tiempos).
