/**
 * The material the suite is graded against — eight documents, written out in
 * full, in the repository.
 *
 * WHY THE CORPUS IS SOURCE CODE AND NOT A DATABASE FIXTURE. An evaluation is
 * only a comparison if both sides read the same thing. A corpus that lives in
 * somebody's Supabase drifts silently: a document gets re-ingested with a new
 * parser, a chunk boundary moves, a space is renamed, and the run from Tuesday
 * is no longer comparable with the run from Friday even though both say 0.86.
 * Here the bytes are in git, `suiteDigest()` hashes them, and two runs whose
 * digests differ are refused rather than averaged. That refusal is the whole
 * reason this file is not a seed script.
 *
 * WHY THESE DOCUMENTS. They are the shapes Brain Knowledge really holds in this
 * product, and they are the shapes named in the measurement in
 * `kb/relevance.ts`: a client contract and the otrosí that amends it, the call
 * that produced the amendment, HR policy, an insurance policy, onboarding, and
 * the start-up plan whose PDF is the reason the thresholds were recalibrated at
 * all. Two of them DISAGREE on purpose — the contract says one rate and the
 * otrosí says another — because "which of these two is in force" is a question
 * a retrieval score cannot answer and a grounded answer must.
 *
 * EVERY DOCUMENT CARRIES CHECKABLE FACTS. Figures, dates, article numbers. Not
 * decoration: they are what makes the answer layer gradeable without asking a
 * model whether an answer "is good". A rubric can ask "does the answer contain
 * 4.500.000" and be right or wrong about it; it cannot ask "is this helpful"
 * and be anything.
 *
 * ONE THING IS DELIBERATELY MISSING. Nothing here says anything about working
 * permanently from abroad, about paternity leave beyond the legal minimum, or
 * about a pet policy that permits pets. Those absences are load-bearing: they
 * are what the `absent` group of `suite.ts` asks about, and a system that
 * answers them confidently has failed even though nothing errored.
 *
 * TEXT IS es-CO because the product is, and because retrieval quality in
 * Spanish is the thing being measured. Translating the corpus to English would
 * measure a system nobody uses — the same mistake the old threshold
 * measurement made when it used well-formed questions.
 */

import { chunkText } from '../kb/chunker';

export interface EvalDocument {
  /** Stable id. Referenced by `EvalCase.gold`; never renumber one in place. */
  id: string;
  title: string;
  /** Which space it would live in. The suite runs single-tenant, so this is descriptive. */
  space: string;
  /** ISO date the document is dated, or null when it carries no date. */
  datedAt: string | null;
  body: string;
}

export const CORPUS: readonly EvalDocument[] = [
  {
    id: 'contract-nexa',
    title: 'Contrato de prestación de servicios — Nexa Logística S.A.S.',
    space: 'Clientes',
    datedAt: '2025-11-03',
    body: `CONTRATO DE PRESTACIÓN DE SERVICIOS PROFESIONALES
Entre CÓRTEX S.A.S. (el contratista) y NEXA LOGÍSTICA S.A.S. (el contratante), NIT 901.455.302-1.
Suscrito el 3 de noviembre de 2025 en Bogotá D.C.

CLÁUSULA PRIMERA — OBJETO. El contratista desarrollará e implementará el módulo de trazabilidad de despachos y prestará el soporte de segundo nivel asociado.

CLÁUSULA SEGUNDA — DURACIÓN. Doce (12) meses contados desde el 1 de diciembre de 2025, prorrogables por acuerdo escrito de las partes.

CLÁUSULA TERCERA — VALOR Y FORMA DE PAGO. El contratante pagará un valor fijo mensual de COP 38.400.000 más IVA, dentro de los primeros diez (10) días calendario de cada mes, contra factura electrónica.

CLÁUSULA CUARTA — TARIFAS POR HORA ADICIONAL. Las horas por fuera del alcance se facturan así:
  · Ingeniero senior: COP 210.000 por hora.
  · Ingeniero semisenior: COP 155.000 por hora.
  · Líder técnico: COP 260.000 por hora.
Ninguna hora adicional se factura sin orden de servicio escrita y previa.

CLÁUSULA QUINTA — NIVELES DE SERVICIO. Incidente crítico: respuesta en 2 horas hábiles y solución o plan de contingencia en 8 horas hábiles. Incidente mayor: respuesta en 8 horas hábiles. El incumplimiento sostenido de estos tiempos por dos meses seguidos da lugar a un descuento del 5% sobre la mensualidad del segundo mes.

CLÁUSULA SEXTA — PROPIEDAD INTELECTUAL. El código fuente entregado y aceptado es propiedad del contratante. Las librerías y herramientas internas del contratista siguen siendo suyas y se licencian de forma perpetua y no exclusiva.

CLÁUSULA SÉPTIMA — CONFIDENCIALIDAD. Obligación mutua, vigente durante el contrato y por tres (3) años más.

CLÁUSULA OCTAVA — TERMINACIÓN ANTICIPADA. Cualquiera de las partes puede terminar con preaviso escrito de sesenta (60) días. Si termina el contratante sin justa causa antes del mes seis, paga una penalidad equivalente a una mensualidad.

CLÁUSULA NOVENA — EQUIPO ASIGNADO. El contratista mantendrá asignado un equipo mínimo de un (1) líder técnico con dedicación del 50%, dos (2) ingenieros senior con dedicación del 100% y un (1) ingeniero semisenior con dedicación del 100%. Cualquier cambio en la composición del equipo se avisa con quince (15) días de anticipación y el reemplazo debe tener experiencia equivalente o superior.

CLÁUSULA DÉCIMA — LUGAR DE PRESTACIÓN. Los servicios se prestan de forma remota. El contratista asistirá presencialmente a las oficinas del contratante en Bogotá un (1) día al mes para el comité de seguimiento, y a los talleres de arranque de cada trimestre.

CLÁUSULA DÉCIMA PRIMERA — COMITÉ DE SEGUIMIENTO. Se reúne el primer martes de cada mes. Asisten el líder técnico del contratista y el gerente de operaciones del contratante. Del comité sale un acta con los compromisos y sus responsables, que se envía dentro de los dos (2) días hábiles siguientes.

CLÁUSULA DÉCIMA SEGUNDA — GARANTÍA SOBRE LOS ENTREGABLES. Noventa (90) días calendario contados desde la aceptación de cada entregable. Durante ese periodo, los defectos atribuibles al contratista se corrigen sin costo y sin consumir horas del contrato.

CLÁUSULA DÉCIMA TERCERA — POLÍTICA DE CAMBIOS. Todo cambio de alcance se documenta en una solicitud de cambio con estimación de horas y de impacto en el cronograma. Nada se empieza a construir antes de que el contratante la apruebe por escrito.

CLÁUSULA DÉCIMA CUARTA — PROTECCIÓN DE DATOS. El contratista actúa como encargado del tratamiento de los datos personales que el contratante le entregue, en los términos de la Ley 1581 de 2012. Los datos no salen de las bases del contratante salvo para las integraciones acordadas, y se devuelven o destruyen a la terminación del contrato.

CLÁUSULA DÉCIMA QUINTA — SUBCONTRATACIÓN. El contratista puede subcontratar partes del servicio con aviso previo y escrito, y responde por sus subcontratistas como si fueran suyos.

CLÁUSULA DÉCIMA SEXTA — CESIÓN. Ninguna de las partes puede ceder el contrato sin autorización escrita de la otra.

CLÁUSULA DÉCIMA SÉPTIMA — SOLUCIÓN DE CONTROVERSIAS. Las diferencias se intentan resolver primero en el comité de seguimiento, luego mediante conciliación ante la Cámara de Comercio de Bogotá, y solo después ante la justicia ordinaria.

CLÁUSULA DÉCIMA OCTAVA — FACTURACIÓN ELECTRÓNICA. El contratista factura los primeros cinco (5) días de cada mes. Las horas adicionales del mes anterior se facturan en el mismo documento, discriminadas por rol y por orden de servicio.

CLÁUSULA DÉCIMA NOVENA — INTERESES DE MORA. La mora en el pago causa intereses a la tasa máxima legal permitida, contados desde el día siguiente al vencimiento.`,
  },
  {
    id: 'otrosi-nexa',
    title: 'Otrosí No. 1 al contrato Nexa Logística — firmado',
    space: 'Clientes',
    datedAt: '2026-04-15',
    body: `OTROSÍ No. 1 AL CONTRATO DE PRESTACIÓN DE SERVICIOS PROFESIONALES SUSCRITO ENTRE CÓRTEX S.A.S. Y NEXA LOGÍSTICA S.A.S.
Firmado el 15 de abril de 2026. Rige desde el 1 de mayo de 2026.

Las partes acuerdan modificar el contrato del 3 de noviembre de 2025 en los siguientes términos, y dejar el resto del articulado intacto.

PRIMERO — VALOR MENSUAL. La cláusula tercera se modifica: el valor fijo mensual pasa de COP 38.400.000 a COP 44.900.000 más IVA, a partir de la facturación de mayo de 2026. El aumento reconoce la incorporación del módulo de conciliación de fletes al alcance.

SEGUNDO — TARIFAS POR HORA ADICIONAL. La cláusula cuarta se modifica en su totalidad:
  · Ingeniero senior: COP 245.000 por hora.
  · Ingeniero semisenior: COP 180.000 por hora.
  · Líder técnico: COP 300.000 por hora.
Estas tarifas reemplazan las del contrato original. Cualquier referencia a COP 210.000 por hora de ingeniero senior queda sin efecto desde el 1 de mayo de 2026.

TERCERO — NIVELES DE SERVICIO. El tiempo de respuesta para incidente crítico baja de 2 horas hábiles a 1 hora hábil. El descuento por incumplimiento sostenido sube de 5% a 8%.

CUARTO — DURACIÓN. El contrato se prorroga hasta el 30 de noviembre de 2027.

QUINTO — LO DEMÁS SIGUE IGUAL. Las cláusulas primera, sexta, séptima y octava del contrato original quedan vigentes sin modificación, incluido el preaviso de sesenta (60) días para terminación anticipada.

SEXTO — EQUIPO. La cláusula novena se ajusta: se suma un (1) ingeniero de integraciones con dedicación del 50% mientras dure la implementación del módulo de conciliación de fletes, y hasta el 31 de diciembre de 2026. Ese perfil no genera cobro por hora adicional durante ese periodo.

SÉPTIMO — COMITÉ DE SEGUIMIENTO. Pasa de mensual a quincenal durante los primeros cuatro (4) meses de vigencia de este otrosí, y vuelve a ser mensual a partir de septiembre de 2026. Los días se acuerdan entre las partes.

OCTAVO — GARANTÍA. La cláusula décima segunda se extiende de noventa (90) a ciento veinte (120) días calendario para los entregables del módulo de conciliación de fletes. Para todo lo demás sigue en noventa (90) días.

NOVENO — ALCANCE DEL MÓDULO DE CONCILIACIÓN DE FLETES. Comprende: la carga de los manifiestos de carga desde el ERP, el cruce automático contra las facturas de los transportadores, la marcación de diferencias por encima de COP 50.000 y el reporte semanal de diferencias abiertas. No comprende el pago a transportadores ni la gestión de glosas, que quedan por fuera y se cotizan aparte si el contratante los quiere.

DÉCIMO — CRONOGRAMA DEL MÓDULO. Salida a producción el 31 de agosto de 2026. Un retraso atribuible al contratista de más de treinta (30) días calendario da lugar a un descuento de media (0,5) mensualidad.

DÉCIMO PRIMERO — REVISIÓN ANUAL DE PRECIOS. A partir de 2027, el valor mensual se ajusta cada 1 de enero con el IPC del año anterior certificado por el DANE, más dos (2) puntos porcentuales. Este es el único mecanismo de ajuste y reemplaza cualquier acuerdo verbal anterior.

DÉCIMO SEGUNDO — CONSTANCIA. Las partes declaran que este otrosí recoge íntegramente lo acordado en la reunión de renegociación del 12 de marzo de 2026 y que no hay acuerdos por fuera de este documento.`,
  },
  {
    id: 'call-nexa',
    title: 'Transcripción — llamada de renegociación con Nexa (12 de marzo de 2026)',
    space: 'Clientes',
    datedAt: '2026-03-12',
    body: `Transcripción de la reunión de renegociación con Nexa Logística. 12 de marzo de 2026, 9:05 a. m. Participantes: Daniela Ríos (Nexa, gerente de operaciones), Andrés Peláez (Nexa, compras), Mariana Gil (Córtex), Julián Torres (Córtex).

Daniela Ríos: Lo que nos duele no es la mensualidad, es que conciliación de fletes lo estamos haciendo a mano y ya son dos personas de tiempo completo.

Mariana Gil: Entonces la conversación no es de descuento, es de alcance. Si conciliación entra al contrato, la mensualidad tiene que subir.

Andrés Peláez: ¿Cuánto estamos hablando?

Mariana Gil: Poniéndolo en números redondos, alrededor de 6,5 millones más al mes. Nos quedaría en cuarenta y cuatro y algo.

Andrés Peláez: Puedo llevar eso a comité si el tiempo de respuesta de crítico baja. Dos horas nos deja parados media mañana.

Julián Torres: Una hora hábil lo podemos sostener, pero necesitamos que la penalidad suba también, para que el compromiso sea de lado y lado. Ocho por ciento.

Daniela Ríos: Aceptado. Y la prórroga la queremos hasta finales de 2027, no queremos volver a abrir esto en diciembre.

Mariana Gil: Perfecto. Lo dejamos en otrosí y no tocamos nada más del contrato — el preaviso de sesenta días se queda como está.

Andrés Peláez: Una cosa más: ¿las horas adicionales suben también?

Julián Torres: Sí, proporcionalmente. Senior queda en doscientos cuarenta y cinco mil.

Julián Torres: Volviendo al alcance, quiero dejar claro qué entra y qué no. Entra cargar los manifiestos desde el ERP, cruzarlos contra las facturas de los transportadores y marcar las diferencias. No entra pagarle a los transportadores ni manejar glosas.

Daniela Ríos: Las glosas las seguimos haciendo nosotros entonces.

Julián Torres: Por ahora sí. Si después las quieren, se cotiza aparte.

Andrés Peláez: ¿Y desde qué monto marcan diferencia? Porque si me marcan todo, no sirve.

Julián Torres: Pensábamos en cincuenta mil pesos hacia arriba. Por debajo de eso el ruido es más caro que la diferencia.

Andrés Peláez: Cincuenta mil está bien.

Daniela Ríos: ¿Y cuándo estaría en producción?

Mariana Gil: Finales de agosto. Si nos atrasamos más de un mes por culpa nuestra, les descontamos media mensualidad. Eso lo dejamos escrito.

Daniela Ríos: Me sirve. Otra cosa, el comité mensual se nos queda corto mientras esto arranca.

Mariana Gil: Lo volvemos quincenal los primeros cuatro meses y después vuelve a mensual.

Andrés Peláez: ¿Y el equipo? Porque si le meten conciliación al mismo equipo, se les va a caer el soporte.

Julián Torres: Sumamos un ingeniero de integraciones a medio tiempo mientras dure la implementación, hasta diciembre. Ese no se los cobramos por hora aparte.

Daniela Ríos: Perfecto. Última cosa, y esta sí es de compras: no quiero volver a negociar precio cada año a pulso.

Andrés Peláez: Propongo IPC del año anterior más dos puntos, cada primero de enero, desde 2027.

Mariana Gil: Aceptado, y que quede como el único mecanismo de ajuste. Nada de acuerdos verbales por fuera.

Daniela Ríos: De acuerdo. Y la garantía de lo de conciliación, ¿sigue en noventa días?

Julián Torres: La subimos a ciento veinte para ese módulo. Para el resto se queda en noventa.

Daniela Ríos: Listo. Mándennos el borrador y lo firmamos antes de semana santa.`,
  },
  {
    id: 'policy-vacaciones',
    title: 'Política de vacaciones y ausencias',
    space: 'Gente',
    datedAt: '2026-01-20',
    body: `POLÍTICA DE VACACIONES Y AUSENCIAS — CÓRTEX S.A.S.
Vigente desde el 1 de febrero de 2026. Reemplaza la versión de 2024.

1. VACACIONES. Quince (15) días hábiles por año cumplido, como manda la ley. Se piden por Cortex con quince (15) días calendario de anticipación y las aprueba el líder directo.

2. ACUMULACIÓN. Se pueden acumular hasta dos periodos, es decir treinta (30) días hábiles. Pasado eso, Gente y Cultura programa el disfrute de oficio.

3. DÍAS DE LA CASA. Además de las vacaciones, cada persona tiene tres (3) días de la casa al año, que no requieren justificación y se avisan con veinticuatro (24) horas de anticipación. No son acumulables ni compensables en dinero.

4. INCAPACIDADES. Se reportan el mismo día a Gente y Cultura, con el soporte de la EPS dentro de los tres (3) días hábiles siguientes.

5. LICENCIA DE LUTO. Cinco (5) días hábiles remunerados por fallecimiento de cónyuge o compañero permanente, o de familiar hasta el segundo grado de consanguinidad.

6. TRABAJO REMOTO. El esquema es híbrido: dos (2) días presenciales por semana, martes y jueves, en la oficina de Bogotá. Los equipos pueden mover esos días de común acuerdo dentro de la misma semana.

7. TRABAJO DESDE OTRA CIUDAD. Se permite hasta cuatro (4) semanas al año desde cualquier ciudad de Colombia, avisando con dos semanas de anticipación.

8. CÓMO SE PIDEN LAS VACACIONES. Se radican por Cortex indicando fecha de salida y fecha de regreso. El líder tiene tres (3) días hábiles para responder. Si no responde en ese plazo, la solicitud se entiende aprobada y Gente y Cultura la registra.

9. CUÁNDO SE PUEDEN NEGAR. Solo por una razón escrita y concreta: un cierre contable, una salida a producción comprometida con un cliente, o que el equipo quede sin cubrimiento. "No es buen momento" no es una razón. Si se niega, el líder propone dos ventanas alternativas dentro de los sesenta (60) días siguientes.

10. VACACIONES COLECTIVAS. La empresa cierra entre el 24 de diciembre y el 1 de enero. Esos días se descuentan del periodo de vacaciones de cada persona, salvo quien esté en el turno de guardia de fin de año, que los disfruta en enero.

11. TURNO DE GUARDIA DE FIN DE AÑO. Se arma con voluntarios en la primera semana de noviembre. Quien lo tome recibe un bono equivalente a dos (2) días de salario por cada día de guardia efectivamente cubierto.

12. PERMISOS NO REMUNERADOS. Hasta treinta (30) días calendario al año, con aprobación del líder y de Gente y Cultura. Durante el permiso se suspende el auxilio de conectividad y el de alimentación, y la seguridad social queda a cargo de la persona.

13. LICENCIA DE MATRIMONIO. Cinco (5) días hábiles remunerados, que se toman dentro del mes siguiente a la fecha del matrimonio.

14. CALAMIDAD DOMÉSTICA. Hasta tres (3) días hábiles remunerados por evento, con soporte posterior. Casos que excedan ese plazo se miran uno a uno.

15. CAMBIO DE LOS DÍAS PRESENCIALES. Un equipo puede cambiar martes y jueves por otros dos días de la misma semana si todo el equipo está de acuerdo y el cambio queda avisado en el canal del equipo antes del lunes.

16. VISITAS A CLIENTE. Un día de visita a un cliente cuenta como día presencial, aunque no sea en la oficina.

17. INCUMPLIMIENTO DE LOS DÍAS PRESENCIALES. Es una conversación con el líder, no una sanción automática. Si se vuelve un patrón, entra Gente y Cultura.

18. VIÁTICOS POR VIAJE. Los viajes a cliente los aprueba el líder y los reembolsa Gente y Cultura contra factura, dentro de los topes que fija el área financiera cada año.`,
  },
  {
    id: 'policy-nomina',
    title: 'Calendario de nómina y beneficios',
    space: 'Gente',
    datedAt: '2026-02-02',
    body: `NÓMINA Y BENEFICIOS — CÓRTEX S.A.S. Actualizado el 2 de febrero de 2026.

PAGOS. La nómina se paga dos veces al mes: el día 15 y el último día hábil del mes. Cuando el 15 cae en sábado, domingo o festivo, se adelanta al día hábil anterior.

NOVEDADES. El corte de novedades es el día 8 y el día 23. Lo que llegue después entra en el pago siguiente, sin excepción.

AUXILIO DE CONECTIVIDAD. COP 120.000 mensuales para toda persona en esquema híbrido o remoto. No constituye salario.

AUXILIO DE ALIMENTACIÓN. COP 220.000 mensuales, pagados con la nómina de fin de mes.

PLAN DE MEDICINA PREPAGADA. Córtex paga el 70% del plan individual con Colsanitas. El 30% restante se descuenta por nómina. Beneficiarios (cónyuge, hijos) van por cuenta de la persona, con la tarifa corporativa.

BONO DE DESEMPEÑO. Se evalúa dos veces al año, en junio y en diciembre. El bono máximo es un (1) salario mensual y se paga con la nómina de julio y la de enero.

PRIMA, CESANTÍAS E INTERESES. Como manda la ley: prima el 30 de junio y el 20 de diciembre; cesantías consignadas antes del 14 de febrero; intereses a las cesantías pagados antes del 31 de enero.

AUXILIO EDUCATIVO. Hasta COP 3.000.000 al año por persona para formación relacionada con el cargo, con aprobación previa del líder y de Gente y Cultura.

CUENTA DE NÓMINA. El pago se hace por transferencia a la cuenta que cada persona registre en Cortex. Un cambio de cuenta se registra con cinco (5) días hábiles de anticipación al pago y lo confirma Gente y Cultura por teléfono, nunca solo por correo.

HORAS EXTRA. Aplican únicamente a los cargos que por ley las causan y requieren autorización previa del líder registrada antes de trabajarlas. Se pagan con la nómina del mes siguiente al que se causaron.

RECARGO DE GUARDIA. Quien esté en el turno de guardia de producción recibe COP 180.000 por semana de guardia, se active o no un incidente. Si se activa fuera del horario laboral, cada activación paga adicionalmente COP 90.000.

ANTICIPOS. Se puede pedir un anticipo de hasta el 40% del salario del mes, una vez por semestre, con aprobación de Gente y Cultura. Se descuenta del pago de fin de mes.

PRÉSTAMOS. Hasta dos (2) salarios mensuales, a doce (12) meses, sin intereses, para vivienda, salud o educación. Cupo sujeto a caja y a aprobación de la gerencia.

DOTACIÓN. Aplica solo a quienes la ley la exige por su nivel salarial, tres veces al año en las fechas de ley.

CERTIFICADOS LABORALES. Se piden por Cortex y salen el mismo día hábil. El certificado de ingresos y retenciones se emite antes del 31 de marzo de cada año.

RETIRO. La liquidación se paga dentro de los cinco (5) días hábiles siguientes al último día trabajado. El certificado de cesantías y la carta de terminación salen junto con ella.

DESCUENTOS. Solo se descuenta de la nómina lo que la ley permite o lo que la persona haya autorizado por escrito: aportes de ley, el 30% de la medicina prepagada, préstamos, anticipos y aportes voluntarios a pensión.

APORTES VOLUNTARIOS A PENSIÓN Y AFC. Se registran en Cortex y se aplican desde el corte de novedades siguiente. La empresa no aporta contrapartida.

PLAN DE MEDICINA PREPAGADA — INGRESO. Se puede entrar en cualquier momento, con carencias según lo que defina Colsanitas. Al ingresar a la empresa, la afiliación se hace en el primer mes.`,
  },
  {
    id: 'policy-poliza',
    title: 'Póliza de responsabilidad civil profesional — Seguros Bolívar',
    space: 'Legal',
    datedAt: '2026-01-08',
    body: `PÓLIZA DE RESPONSABILIDAD CIVIL PROFESIONAL
Aseguradora: Seguros Bolívar. Tomador: CÓRTEX S.A.S. Póliza No. RCP-2026-44871.
Vigencia: del 15 de enero de 2026 al 15 de enero de 2027.

VALOR ASEGURADO. COP 2.000.000.000 por evento y en el agregado anual.

DEDUCIBLE. 10% del valor de la pérdida, con un mínimo de COP 12.000.000 por evento.

AMPARO BÁSICO. Perjuicios patrimoniales causados a terceros por errores u omisiones en la prestación de servicios de desarrollo de software, consultoría e implementación.

AMPAROS ADICIONALES. Gastos de defensa hasta COP 300.000.000. Perjuicios por pérdida de datos de terceros hasta COP 500.000.000.

EXCLUSIONES PRINCIPALES. Actos dolosos. Multas y sanciones administrativas. Reclamaciones por incumplimiento de plazos contractuales que no deriven en un error profesional. Daños derivados de servicios prestados antes del 1 de enero de 2024.

AVISO DE SINIESTRO. Dentro de los diez (10) días hábiles siguientes al conocimiento del hecho, por escrito y con la documentación de soporte.

PRIMA ANUAL. COP 34.700.000, pagada en cuatro cuotas trimestrales.

ASEGURADOS ADICIONALES. Quedan cubiertos los empleados y contratistas del tomador mientras actúen por cuenta de él y dentro del objeto amparado.

COBERTURA GEOGRÁFICA. Territorio colombiano. Reclamaciones originadas en servicios prestados a clientes domiciliados fuera de Colombia no están cubiertas salvo anexo expreso, y a la fecha no hay ninguno.

MODALIDAD DE COBERTURA. Claims made. Ampara reclamaciones presentadas durante la vigencia por hechos ocurridos a partir del 1 de enero de 2024, que es la fecha de retroactividad pactada.

PERIODO DE DESCUBRIMIENTO. Doce (12) meses después de la terminación de la póliza, únicamente si no se renueva con otra aseguradora y previo pago de una prima adicional del 25%.

OBLIGACIONES DEL ASEGURADO EN CASO DE SINIESTRO. Avisar dentro de los diez (10) días hábiles. No reconocer responsabilidad ni ofrecer arreglos sin autorización escrita de la aseguradora. Entregar toda la documentación que se le pida y colaborar en la defensa.

EXCLUSIONES ADICIONALES. Reclamaciones entre empresas del mismo grupo. Responsabilidad asumida contractualmente que exceda la que habría existido sin el contrato. Perjuicios extrapatrimoniales. Lucro cesante del propio asegurado. Retiro, reparación o reemplazo del producto o servicio defectuoso en sí mismo.

RENOVACIÓN. Aviso de no renovación con treinta (30) días de anticipación por cualquiera de las partes. La renovación automática no opera si hay siniestros pendientes de definición.

CORREDOR. La intermediación está a cargo de Delima Marsh. Toda comunicación formal con la aseguradora se canaliza a través del corredor.

REVISIÓN DEL VALOR ASEGURADO. Se revisa cada año contra el valor de los contratos vigentes. Si la suma de los contratos supera el valor asegurado, se evalúa subirlo antes de la renovación.

PAGO DE LA PRIMA. Cuatro cuotas trimestrales con vencimiento el 15 de enero, el 15 de abril, el 15 de julio y el 15 de octubre. La mora superior a treinta (30) días suspende la cobertura.`,
  },
  {
    id: 'guide-onboarding',
    title: 'Guía de onboarding — primeras dos semanas',
    space: 'Gente',
    datedAt: '2026-03-01',
    body: `GUÍA DE ONBOARDING — CÓRTEX S.A.S.

DÍA 1. Firma de contrato y afiliaciones con Gente y Cultura. Entrega del equipo por parte de TI. Creación de cuentas: correo corporativo, Slack, Linear y Cortex. Almuerzo con el equipo.

DÍA 2 Y 3. Recorrido por el producto con el líder técnico. Lectura obligatoria: el documento de arquitectura y la guía de estilo de código. Primer pull request de calentamiento, típicamente un arreglo pequeño con pruebas.

PRIMERA SEMANA — OBJETIVO. Tener el entorno local corriendo, haber abierto un pull request y haber pasado por una revisión de código completa. Nadie se queda sin mergear algo en la primera semana; si eso pasa, es un problema del onboarding, no de la persona.

SEGUNDA SEMANA. Rotación de una hora con cada área: Ventas, Operaciones y Soporte, para entender de dónde vienen los tickets. Se asigna un padrino o madrina de onboarding que acompaña los primeros noventa (90) días.

A LOS 30 DÍAS. Conversación de expectativas con el líder directo, sin formato ni calificación. A los 90 días, evaluación de periodo de prueba.

OFICINA. Estamos en la calle 93 con carrera 13, piso 6, en Bogotá. La recepción abre de 7:00 a. m. a 6:00 p. m.

ANTES DEL DÍA 1. Gente y Cultura envía la carta de oferta firmada, la lista de documentos y el enlace para registrar la cuenta bancaria. TI prepara el equipo y lo despacha para que llegue dos días antes. Si el equipo no llegó, el día 1 se hace igual con un equipo de préstamo.

DOCUMENTOS QUE HAY QUE ENTREGAR. Cédula, hoja de vida, certificados de estudio, certificados laborales, certificado de afiliación a EPS y a fondo de pensiones, y certificado bancario. Todo se sube por Cortex.

ACCESOS. Correo corporativo y Slack el día 1. Linear y Cortex el día 1. Acceso al repositorio y al entorno de desarrollo el día 2, después de firmar el acuerdo de confidencialidad. Acceso a datos de cliente solo cuando el líder lo solicite y por el tiempo que lo necesite.

QUÉ NO SE HACE EN LA PRIMERA SEMANA. No se entra a un incidente de producción, no se hace guardia y no se habla directamente con un cliente sin acompañamiento. Eso no es desconfianza, es que el contexto todavía no está.

PADRINO O MADRINA. Se asigna el día 1 y acompaña noventa (90) días. Tiene una reunión de treinta minutos por semana las primeras cuatro semanas, y luego cada quince días. No es el líder: es alguien del equipo que ya pasó por lo mismo.

FORMACIÓN OBLIGATORIA. Seguridad de la información y manejo de datos personales, en la primera semana. Uso de Cortex y de Brain Knowledge, en la segunda semana.

RITUALES DEL EQUIPO. Daily de quince minutos a las 9:00 a. m. Revisión de sprint los viernes. Retrospectiva cada dos semanas. Demo interna el último jueves del mes.

HERRAMIENTAS. Slack para lo del día, Linear para el trabajo, Cortex para lo que hay que recordar y para preguntar por documentos, correo solo para hablar con gente de afuera.

ALMUERZO Y CAFÉ. La cocina del piso 6 tiene café y agua. No hay servicio de almuerzo; alrededor hay opciones en la 93.

SALUD Y SEGURIDAD. La brigada de emergencia está identificada con distintivo naranja. El punto de encuentro es el parque de la 93. El simulacro es en octubre.

PARQUEADERO. Hay ocho (8) cupos rotativos que se reservan por Cortex el viernes anterior. Hay parqueadero de bicicletas sin cupo limitado en el sótano 1.

MASCOTAS. No hay política de mascotas y el edificio no las permite, salvo perros guía.`,
  },
  {
    id: 'plan-bbic',
    title: 'CÓRTEX · Plan de arranque para BBIC S.A.S.',
    space: 'Clientes',
    datedAt: '2026-05-22',
    body: `CÓRTEX · PLAN DE ARRANQUE PARA BBIC S.A.S.
Documento de trabajo, 22 de mayo de 2026.

FASE 1 — DESCUBRIMIENTO (semanas 1 y 2). Levantamiento de los procesos de facturación y cartera. Inventario de fuentes de datos: el ERP, las dos hojas de cálculo de tesorería y el correo de cobranza. Entregable: mapa de procesos y lista priorizada de dolores.

FASE 2 — CONEXIÓN (semanas 3 a 5). Integración con el ERP y con el correo. Carga inicial de Brain Knowledge con contratos, políticas de cartera y el manual de cobranza. Entregable: Cortex respondiendo preguntas sobre la cartera con citas a los documentos reales.

FASE 3 — AUTOMATIZACIÓN (semanas 6 a 9). Recordatorios de vencimientos, borradores de correos de cobro y el informe semanal de cartera. Entregable: tres rutinas corriendo solas y medidas.

FASE 4 — ADOPCIÓN (semanas 10 a 12). Formación por área, medición de uso y ajuste de las rutinas con base en lo que la gente realmente pregunta. Entregable: informe de adopción y plan de los siguientes noventa días.

EQUIPO. Un líder técnico al 50%, un ingeniero senior al 100% y un consultor de procesos al 30%.

INVERSIÓN. Implementación por COP 96.000.000 en cuatro pagos contra entregable, más la suscripción mensual desde la fase 3.

CONTEXTO. BBIC S.A.S. es una comercializadora de insumos industriales con sede en Medellín y bodegas en Bogotá y Barranquilla. Factura alrededor de nueve mil facturas al mes y su cartera vencida a más de noventa días viene creciendo desde el segundo semestre de 2025.

QUÉ NOS PIDIERON. Que la gente de cartera deje de buscar en tres sistemas para responder una pregunta de un cliente, y que los recordatorios de vencimiento salgan solos.

FASE 1 — DESCUBRIMIENTO, DETALLE. Entrevistas con las cinco personas de cartera, dos de tesorería y el líder de facturación. Observación de un día de trabajo real, no de una demostración. Extracción de una muestra de datos del ERP para medir calidad: cuántas facturas tienen fecha de vencimiento vacía, cuántos clientes tienen dos NIT, cuántos correos de contacto rebotan.

FASE 2 — CONEXIÓN, DETALLE. Conector de solo lectura contra el ERP. Ingesta del buzón de cobranza. Carga de Brain Knowledge con los contratos marco, la política de cartera, el manual de cobranza y las plantillas de correo que hoy se usan a mano. Al final de esta fase, una persona de cartera debe poder preguntar "¿qué dice el contrato de este cliente sobre plazos?" y recibir la respuesta con la cita.

FASE 3 — AUTOMATIZACIÓN, DETALLE. Rutina de vencimientos que corre todos los días a las 7:00 a. m. Rutina de borradores de correo de cobro, que deja el borrador listo para que una persona lo revise y lo envíe: no se envía nada solo. Informe semanal de cartera los lunes a las 8:00 a. m. con lo vencido por tramo y por vendedor.

FASE 4 — ADOPCIÓN, DETALLE. Dos talleres por área. Medición semanal de uso: cuántas preguntas, cuántas respondidas con material propio, cuántas sin nada. Ajuste de Brain Knowledge con base en las preguntas que quedaron sin respuesta, que es la señal más útil que da el sistema.

GOBIERNO DEL PROYECTO. Comité quincenal de una hora con el patrocinador y el responsable de proceso. Tablero de avance en Linear, visible para BBIC.

CRITERIOS DE ÉXITO. Al cierre de la fase 4: al menos el 70% de las preguntas de cartera respondidas con cita a un documento propio, los recordatorios saliendo solos todos los días, y el tiempo de preparación del informe semanal bajando de cuatro horas a menos de treinta minutos.

QUÉ NO INCLUYE ESTE PLAN. No incluye migración de datos históricos anteriores a 2024, no incluye cambios dentro del ERP, y no incluye integración con el portal de facturación electrónica.

FORMA DE PAGO. Cuatro pagos iguales de COP 24.000.000 contra la aceptación de cada entregable de fase.

SUPUESTOS. BBIC asigna un responsable de proceso con dedicación de al menos ocho (8) horas semanales. Sin eso, el cronograma se corre.

RIESGOS. El principal es la calidad de los datos del ERP; si la cartera está desactualizada en origen, la fase 3 no arranca en la semana 6. El segundo es la rotación en el área de cartera, que ya perdió dos personas en 2026.`,
  },
] as const;

/** Lookup by id, for graders that hold a `gold` reference. */
export const CORPUS_BY_ID: Readonly<Record<string, EvalDocument>> = Object.freeze(
  Object.fromEntries(CORPUS.map((d) => [d.id, d])),
);

export interface CorpusChunk {
  documentId: string;
  documentTitle: string;
  space: string;
  datedAt: string | null;
  chunkIndex: number;
  tokens: number;
  content: string;
}

/**
 * The corpus as retrieval would really see it.
 *
 * IT USES THE PRODUCTION CHUNKER, and that is not a convenience. Chunk length
 * moves a cosine by about 0.03 (measured; `kb/relevance.ts` has the ladder),
 * which is most of the margin the thresholds run on. A suite that chunked by
 * paragraph, or by document, would be measuring a retrieval system this product
 * does not have, and would go on passing on the day somebody changed
 * `targetTokens`. Defaults are left alone for the same reason: they are what
 * `ingest` uses.
 *
 * The title is prepended to the first chunk of each document because that is
 * what ingestion does with a PDF's cover page, and because the document that
 * started all of this was found — barely — on its title line.
 */
export function corpusChunks(): CorpusChunk[] {
  const out: CorpusChunk[] = [];
  for (const doc of CORPUS) {
    const chunks = chunkText(`${doc.title}\n\n${doc.body}`);
    for (const chunk of chunks) {
      out.push({
        documentId: doc.id,
        documentTitle: doc.title,
        space: doc.space,
        datedAt: doc.datedAt,
        chunkIndex: chunk.chunkIndex,
        tokens: chunk.tokens,
        content: chunk.content,
      });
    }
  }
  return out;
}
