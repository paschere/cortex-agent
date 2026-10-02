# Extractos bancarios: qué facturas se pagaron de verdad

La empresa descarga los movimientos de su cuenta desde la banca en línea (Excel `.xlsx` o CSV), los sube en **Pagos** o se los pasa a Cortex en el chat, y Cortex toma **sólo lo que entró**, busca la factura que paga cada abono, ata solo lo inequívoco y deja el resto en una lista de conciliación con sugerencias de un clic. **No hay migración**: cada abono entra como un `payment_report` de la 0098 por `importSystemPayments`, la puerta que ya estaba lista para «un extracto de Bancolombia».

## Cómo se usa
- **Pagos → Importar extracto del banco** (`/payments`):
  1. Archivo (`.xlsx`, `.csv` o texto separado por `;`, `,`, tabulador o `|`; hasta 10 MB y 20.000 filas).
  2. **Cuenta**: un nombre libre («Bancolombia corriente 1234») con los ya usados como sugerencia. **Siempre el mismo para la misma cuenta**: es parte de la clave que evita duplicar.
  3. **Moneda**: sin valor por defecto, igual que al anotar un pago. Nunca se asume.
  4. **Ver qué trae** → vista previa sin escribir nada: banco detectado (y cómo), periodo, columnas usadas, abonos y total, cuántos ya estaban importados (se saltan), cuántos se atan solos / quedan por revisar / sin factura, salidas ignoradas, filas que no se pudieron leer, y la lista de abonos con su factura probable y el porqué.
  5. **Importar N abonos**. Queda en `audit_events` (`payments.import_bank_statement`, superficie web).
- **Conciliación del banco** (misma página): tres pestañas.
  - **Por revisar**: abonos con una o varias facturas probables, cada una con sus razones; **Es esta** la ata. Si ninguna es, «Es otra factura…» deja escoger cualquiera abierta de la misma moneda.
  - **Sin factura**: abonos sin candidata (o en disputa con otra fuente); se pueden atar a mano.
  - **Atados a su factura**: los 50 más recientes.
- **Formato no reconocido**: la vista previa enseña los encabezados encontrados y unas filas de muestra, y deja escoger qué columna es la fecha, créditos/débitos o valor con signo, descripción, referencia, id de transacción, saldo, tipo y NIT, y en qué fila están los encabezados. No hay un modelo adivinando columnas: con dinero, escoge la persona.
- **En el chat** (el archivo, adjunto o del Feed, se pasa por el `id` de su etiqueta `<archivo>`):
  - `payments.preview_bank_statement` — sólo lectura; si responde `needs_mapping` trae encabezados y muestra para preguntarle a la persona y repetir con `columns` (encabezado o número de columna por papel).
  - `payments.import_bank_statement` — **confirmación obligatoria e indelegable** (`security/mandatory-confirmation.ts`).
  - `payments.bank_unmatched` — sólo lectura: lo que entró sin factura, con sugerencias.
  - `payments.apply_to_invoice` — ata un pago a la factura que la persona confirmó; pide confirmación.

## Bancos y formatos
| Banco | Cómo se reconoce | Columnas típicas |
|---|---|---|
| Bancolombia | «Bancolombia» en las primeras filas o el nombre del archivo; o `SUCURSAL` + `DCTO.` | FECHA · DESCRIPCIÓN · SUCURSAL · DCTO. · VALOR (con signo) · SALDO |
| Davivienda | nombre; o `Descripción motivo` / `Oficina de Recaudo` / `ID Origen/Destino` | Fecha de Sistema · Documento · Descripción motivo · Transacción · Oficina · ID Origen/Destino (NIT) · Valor Total · Referencia 1 · Referencia 2 |
| BBVA | nombre; o `Fecha Operación` + `Fecha Valor` | Fecha Operación · Fecha Valor · Concepto · Importe · Saldo |
| Banco de Bogotá | nombre; o Transacción + Oficina + Débitos + Créditos | Fecha · Transacción · Oficina · Documento · Débitos · Créditos · Saldo |
| Otro | genérico: cualquier archivo con encabezados reconocibles | sinónimos en `bank/profiles.ts` |

El banco sólo pone la etiqueta y dice si su «valor» trae signo; **qué entra lo decide el papel de cada columna**, reconocido por sinónimos comunes a todos. Los perfiles están hechos sobre los formatos públicos conocidos y hay que validarlos con archivos reales de cada banco: cuando un banco cambie su exportación, el peor caso es la pantalla de escoger columnas, no un número mal leído.

Reglas de lectura (`bank/format.ts`, `bank/parse.ts`):
- **Números**: `1.234.567,89` y `1,234,567.89` son lo mismo. El separador decimal se decide por **columna**, por mayoría; `1.234` sin más contexto son mil doscientos treinta y cuatro. Acepta `$`, `COP`, paréntesis y signo al final (`1.200,00-`).
- **Fechas**: dd/mm/aaaa (y dd-mm-aa, aaaa-mm-dd, aaaammdd, «15-ene-2026», número de serie de Excel); si alguna fila de la columna trae un «mes» mayor que 12, la columna entera es mm/dd. dd/mm sin año sólo si el extracto dice el año arriba.
- **Entradas y salidas**: columnas de créditos/débitos; o valor con signo; o valor sin signo + columna de tipo (C/D, crédito/débito); o, como último recurso, palabras de la descripción («ABONO», «CONSIGNACION»… contra «RETIRO», «COMPRA», «4X1000»…). Lo que sigue sin saberse **no se importa** y se avisa.
- Se saltan filas vacías y de resumen (saldo anterior/final, totales). Excel antiguo `.xls` y PDF se rechazan con instrucciones para exportar `.xlsx`/CSV.

## Idempotencia
- `source_kind = 'system'`, `source_system = 'extracto · <cuenta normalizada>'` (minúsculas, ≤ 60). La cuenta va en la fuente: dos cuentas nunca comparten referencias, y en una disputa se lee «extracto · bancolombia corriente 1234». «extracto» ya está en `BANK_SYSTEMS` (rango de banco, que sólo ordena la cola de disputas).
- `source_ref`:
  - con id de transacción del banco: `t:<fecha>:<id>` (más `#n` si el id se repite el mismo día dentro del archivo);
  - sin id: `h:` + sha256 de fecha, importe, descripción y referencia normalizadas, **saldo después del movimiento** y el ordinal entre gemelos idénticos del archivo.
- La vista previa salta las referencias ya guardadas; si dos importaciones corren a la vez, gana `payment_reports_source_once_idx`. Reimportar el mismo archivo o un periodo que se solapa no duplica.
- Límites conocidos: cambiar el nombre de la cuenta entre importaciones duplica (la pantalla ofrece los ya usados); sin id ni saldo, un archivo que empieza a mitad de un día con dos abonos idénticos puede tomar el segundo por el primero.

## Emparejar (`bank/match.ts`, puro)
Contra las facturas por cobrar abiertas: documentos confirmados (0076; saldo = total − pagos atados, por moneda) y facturas del programa contable (0165; saldo de Siigo/Alegra/QuickBooks menos lo ya atado desde el banco, sólo para sugerir). Una factura que existe en los dos lados cuenta una vez, la del documento.

| Señal | Puntos |
|---|---|
| Importe exacto al saldo / ±1 % / 85–99 % (retenciones) / abono parcial | 50 / 35 / 15 / 5 |
| Número de factura entero en descripción o referencia / sólo sus cifras (≥ 3) | 40 / 25 |
| NIT de quien paga (columna o glosa, con o sin DV) = el de la factura o su cliente | 35 |
| Nombre del cliente aproximado (palabras y prefijos, sin S.A.S./LTDA) | hasta 25 |
| Vencimiento a ± 15 días | 3 |

- Se descarta: otra moneda, saldo cero, o abono **anterior** a la fecha de la factura.
- **Se ata solo** sólo si hay UNA candidata con importe exacto + (número de factura o NIT), ninguna otra factura nombrada entera en la glosa, y ningún otro abono del mismo extracto apunta a la misma factura. Todo lo demás va a «por revisar» (hasta 3 sugerencias) o «sin factura».
- La lista de conciliación **no se guarda**: los abonos sin atar se vuelven a emparejar cada vez contra las facturas abiertas de ese momento.

## Escrituras
- Importar: `importBankStatement` → `importSystemPayments` → `recordPaymentReport` (el emparejador de fuentes de la 0098: si Siigo ya reportó ese pago del mismo cliente, enlaza y sube la confianza; si discrepa, disputa). `SystemPaymentRow` ganó `extractionId` y `clientId` opcionales y el resultado `outcomes` por fila.
- Atar: `applyPaymentToInvoice` en `payments/store.ts`, tercer llamante de `writePayment`. Exige la persona, sólo rellena la factura que faltaba (`extraction_id` para documentos, `invoice_number` para facturas del programa contable), toma el cliente de la factura sólo si el pago no tenía, rechaza pagos en disputa o descartados, monedas distintas, clientes distintos y facturas por pagar. Quién lo hizo queda en `audit_events`.

## Archivos
- `packages/agent-tools/src/payments/bank/` — `format.ts`, `profiles.ts`, `parse.ts`, `read.ts` (CSV propio + exceljs vía `kb/spreadsheets.ts`), `match.ts`, `store.ts`, `tools.ts`, tests en `__tests__/`.
- `apps/web/app/(app)/payments/bank-actions.ts` (acciones), `_components/BankSection.tsx` (servidor), `_components/BankStatements.tsx` (cliente), `_components/bank-types.ts`.

## Pendiente
- Validar los perfiles con extractos reales de cada banco (y añadir Banco de Occidente, Popular, AV Villas, Colpatria…).
- PDF de extracto y `.xls` antiguo.
- Las salidas (pagos a proveedores) no se importan todavía.
- Repartir un abono entre varias facturas.
