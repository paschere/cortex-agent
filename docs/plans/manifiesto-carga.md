# Manifiesto de carga: primer paso del documental (Operación de carga v6)

Pedido del dueño (2026-11-08): el PRIMER paso del documental al crear un vuelo es armar el
manifiesto de la aerolínea con el formato de su plantilla «MANIFIESTO AEROLINEAS NO MODIFICAR»
(copia sin datos personales: /Users/paschere/Developer/cortex-ops/manifiesto/plantilla.xlsx,
hoja «MANIFIESTO FORMULADO»), y poder exportarlo TAL CUAL para imprimir.

## La plantilla (hoja «MANIFIESTO FORMULADO», carta vertical, ajustada a 1 página, sin cuadrícula,
márgenes 0,25" lados / 0,75" arriba y abajo; Arial 11, títulos en negrita)
- Encabezado: logo de la aerolínea (E3:F5) + recuadro «MANIFIESTO <AEROLÍNEA>» (H2:I4, Arial 20
  negrita, fondo amarillo #FFFF00, borde grueso).
- Fila 8/9 bilingüe: «MARKS OF NACIONALITY AND REGISTRATION: / MATRICULA, MARCA Y NACIONALIDAD:»
  (valor F8, subrayado) · «FLIGHT No: / VUELO No:» (valor H8) · «DATE: / FECHA:» (valor J8:L8).
- Fila 11/12: «POINT OF LOADING: / PUNTO DE CARGA:» valor C11:F11 (p. ej. MIA) con «(PLACE AND
  COUNTRY) (LUGAR Y PAIS)» debajo · «POINT OF UNLOADING: / PUNTO DE DESCARGA:» valor I11:L11 (BOG).
- Tabla (encabezado bilingüe filas 15–18): AIRWAYBILL NUMBER / NUMERO DE GUIA (A:B) · NUMBER OF
  PACKAGES / NUMERO DE PAQUETES (C) · PESO (D) · NATURE OF GOODS / NATURALEZA DE LA MERCANCIA (E:G)
  · CONSIGNEES (H) · FOR OFFICIAL USE ONLY / PARA USO OFICIAL SOLAMENTE (I:L, en blanco).
  Renglones 19–60 (42 por página); fila 61 = totales de paquetes (C) y peso (D).
- Pie: «PREPARED BY / PREPARADO POR:» (A62:C63, valor D63:G63) · «PAGE / PAGINA» n/m (H62:I63) ·
  «<n> Reg,» (A64: cuántas guías).
- Aerolíneas con su logo (hoja AEROLINEAS): LATAM, AMERIJET, FEDEX, UNITED, CARGOJET, KALITTA,
  AIR CANADA, UPS, KLM, ABX, ATLAS (URLs de logos en la plantilla; usar las de Wikimedia cuando
  existan y quitar parámetros utm).

## Flujo nuevo del documental
1. «Nuevo vuelo» = «Nuevo manifiesto»: elige aerolínea (con logo), escribe matrícula, número de
   vuelo (prellena aerolínea por código), fecha, origen y destino (BOG por omisión).
2. Guías: tabla editable tipo hoja (pegar desde Excel, agregar desde las prealertas de ese vuelo,
   o leer un PDF/foto con docs.scan) con guía, paquetes, peso, naturaleza, consignatario; totales en vivo.
3. Guardar crea/actualiza el vuelo (aerolinea, numero_vuelo, fecha, origen, destino, matricula,
   piezas/kilos esperados = totales, preparado_por) y sus guías (prefacturacion: guia, vuelo,
   piezas_esperadas, kilos_esperados, naturaleza, consignatario, prealerta si cruza).
4. Exportar: «Imprimir / PDF» (réplica exacta en HTML de impresión: misma grilla, bordes, fuentes,
   amarillo, logo, bilingüe, 42 renglones por página con totales y PAGINA n/m) y «Descargar Excel»
   (xlsx con la misma estructura de la plantilla — mismas celdas, combinaciones, anchos, bordes y
   formato de impresión).
El manifiesto se puede volver a abrir, editar y reimprimir desde el vuelo.

## Datos nuevos (script)
- prefacturacion: naturaleza (text), consignatario (text).
- vuelos: preparado_por (text), manifiesto_impreso_en (text ISO).
- Permisos: documental y supervisor escriben esos campos.

## Plataforma
`cortex.ui.print(html: string, opts?: { title?: string })`: el marco padre imprime el HTML en un
iframe oculto `sandbox="allow-same-origin allow-modals"` SIN allow-scripts (srcdoc; se quitan
<script> y manejadores on*), llama a print() y lo retira. El iframe de la app no puede imprimir
por sí mismo (sandbox sin allow-modals).
