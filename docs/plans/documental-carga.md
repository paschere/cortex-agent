# Documental de carga (v3 de Operación de carga)

Decisión del dueño (2026-11-06): «vamos con todo». El documental hoy trabaja en correo, hojas,
WhatsApp y portales (DIAN MUISCA, aerolínea). Le duele: digitar guías, cuadrar diferencias,
perseguir información y plazos/multas. Todo eso pasa a Cortex, en la app con código
«Operación de carga» (`docs/examples/operacion-carga/`, ver `operacion-carga-codigo.md`).

Reglas fijas: Cortex NUNCA envía nada a la DIAN (prepara borradores y guarda soportes; la
persona carga en MUISCA). Cambios de producción solo por script transaccional que corre el
dueño. Plazos configurables (no en código).

## Datos nuevos (los crea el script de datos)

### Tabla `plazos_dian` (configuración, editable por supervisor/documental)
| campo | tipo | nota |
|---|---|---|
| tramite | text | nombre, ej. «Informe de descargue e inconsistencias» |
| desde | select: Llegada · Fin de descargue · Informe presentado | evento que arranca el reloj |
| horas | number | plazo en horas desde `desde` |
| avisar_horas_antes | number | |
| activo | select: Sí · No | |
| descripcion | longtext | qué es y dónde se hace |
Semilla (marcada «confirmar con el equipo» en la descripción): Informe de descargue e
inconsistencias — Fin de descargue — 12 h — aviso 3 h; Justificación de inconsistencias —
Informe presentado — 120 h — aviso 24 h.

### Tabla `tramites_dian`
vuelo (relation→vuelos), tramite (text), desde_evento (text), inicio (text ISO fecha-hora
Bogotá), vence (text ISO), estado (select: Pendiente · En curso · Presentado · Vencido ·
No aplica), presentado_por (text), presentado_en (text ISO), numero_radicado (text),
soporte (file, múltiple), borrador (longtext — el informe armado por Cortex), notas (longtext).

### Tabla `avisos_cliente`
vuelo (relation), guia (relation→prefacturacion), cliente (relation→clientes_facturacion),
tipo (select: Llegada · Novedad · Diferencia de peso · Faltante · Sobrante · Documento
faltante · Otro), canal (select: WhatsApp · Correo · Llamada), mensaje (longtext),
estado (select: Por enviar · Enviado · Respondido), enviado_por (text), enviado_en (text ISO),
enlace_documentos (text — enlace para que el cliente suba lo que falta).

### Campos nuevos
- `vuelos`: fin_descargue_fecha (date), fin_descargue_hora (time), manifiesto_numero (text),
  matricula (text), destino (text), estado_documental (select: Sin prealertas · Prealertado ·
  Manifiesto cargado · Cruzado · Con inconsistencias · Listo), inconsistencias (number),
  manifiesto_archivo (file).
- `prealertas`: vuelo (relation→vuelos), estado_cruce (select: Sin vuelo · En vuelo ·
  Coincide · Faltante · Sobrante · Diferencia), guia_normalizada (text), documento (file),
  canal (select: Correo · WhatsApp · Hoja MERFLEX · Formulario cliente · Escaneo).
- `prefacturacion` (guía del vuelo): estado_cruce (mismo select), lista_prefactura (select: Sí · No),
  falta (text — qué le falta para prefacturar).
- `clientes_facturacion`: whatsapp (text), correo (text), contacto (text).

### Rol documental
Lee y crea/edita: vuelos (más los campos nuevos), prealertas (crear, editar, marcar),
prefacturacion (sus campos + estado_cruce, falta), tramites_dian, avisos_cliente,
plazos_dian, clientes_facturacion (solo whatsapp/correo/contacto). `export: true`.
Supervisor: lo mismo. Gerencia: lectura.

### Reglas nuevas
1. Vuelo pasa a «Aterrizó» o se llena `fin_descargue_*` → crea los `tramites_dian` activos de
   `plazos_dian` cuyo `desde` ya ocurrió, con `inicio` y `vence` calculados (idempotente por
   vuelo+trámite). Si la regla no puede calcular fechas, la pantalla lo hace al abrir el vuelo
   (`asegurarTramites`).
2. Programada cada 15 min: trámites Pendiente/En curso que vencen en ≤ avisar_horas_antes →
   avisa a documental y supervisor (una vez); vencidos → estado Vencido + aviso.
3. Prealerta nueva → busca vuelo por número de vuelo (y fecha estimada) y la enlaza
   (`link_rows`), `estado_cruce` = En vuelo o Sin vuelo; normaliza la guía.

## Pantallas (código)
| slug | roles | qué hace |
|---|---|---|
| `bandeja` (nueva, inicio del documental) | documental, supervisor | Su día: trámites por vencer con cuenta regresiva, prealertas sin vuelo, vuelos sin manifiesto, inconsistencias sin reportar, avisos por enviar, guías no listas para prefacturar. Cada tarjeta lleva a resolver. Sondeo 30 s. |
| `prealertas` (nueva) | documental, supervisor | Entrada: soltar varias fotos/PDF/correos (texto pegado) → `docs.scan` (kind guia o general con renglones) → revisar → crear prealertas con canal y documento; enlazar a vuelo; marcar duplicada; filtros por estado de cruce. Muestra cuándo fue la última fila de la hoja MERFLEX. |
| `vuelos` (mejora) | | «Nuevo vuelo desde manifiesto»: adjuntar foto/PDF → `docs.scan({kind:'manifiesto'})` → rellena número de vuelo, aerolínea, fecha, origen, destino, matrícula, manifiesto, totales (piezas, kilos) y crea el vuelo + sus guías + guarda el archivo en `manifiesto_archivo`. Si el vuelo ya existe (mismo número y fecha), ofrece actualizarlo. |
| `vuelo` (mejora) | | Pestañas: Resumen · Guías y cruce · Trámites DIAN · Avisos · Documentos. Adjuntar manifiesto también RELLENA lo vacío del vuelo (no pisa lo escrito sin confirmar). Cruce de tres vías prealerta ↔ manifiesto ↔ recibido. Trámites con cuenta regresiva, botón «Armar borrador» (`ai.ask` con las inconsistencias → texto del informe para copiar a MUISCA), subir soporte, marcar Presentado con radicado. Avisos: genera mensajes por cliente según el cruce, abre WhatsApp (`https://wa.me/<num>?text=`) o copia, y registra el aviso. |
| `tramites` (nueva) | documental, supervisor, gerencia | Todos los trámites con semáforo y vencimientos; editor de `plazos_dian` (supervisor/documental). |

Webhook listo para correo entrante (cuando haya buzón): función `server/prealerta-correo.ts`
+ webhook `prealerta-correo` que recibe {asunto, de, texto, adjuntos[{nombre, base64}]} y crea
prealertas (requiere escaneo en servidor: si el SDK de funciones no tiene `docs.scan`, deja
la prealerta con el documento y estado Sin vuelo para revisión).
