# Cortex: estrategia de producto y negocio para construir una empresa de escala

Fecha: 16 de septiembre de 2026. Responsable propuesto: fundador de Cortex.

Estado: análisis y decisiones propuestas, no implementación de Activaciones ni validación de mercado. La meta se interpreta como una valoración de US$1.000 millones, no ingresos de ese tamaño. Las cifras de precios, márgenes, contratación y conversión son hipótesis explícitas. No se consultaron ingresos, caja, contratos, cohortes ni cuentas de clientes en producción. No se enviaron mensajes ni se publicaron ofertas.

## Decisión principal

Cortex debe convertirse en el lugar donde una empresa define trabajo recurrente, autoriza su ejecución y verifica resultados. La entrada comercial recomendada es control de facturación y cartera para empresas B2B con sistemas fragmentados. El producto podrá expandirse a otros procesos; la venta inicial debe resolver una necesidad específica.

La promesa inicial propuesta es: **“Cortex conecta tus facturas, pagos y comunicaciones, detecta pendientes y coordina su resolución con evidencia y tu control.”** La visión de gerente virtual se mantiene como dirección del producto. No significa sustituir responsabilidad legal, criterio ejecutivo ni garantizar que cualquier operación pueda automatizarse.

Tres decisiones inmediatas:

1. Priorizar un proceso completo antes de añadir más módulos independientes.
2. Separar software repetible de implementación y servicio humano, tanto en costos como en contratos.
3. Abrir el autoservicio cuando usuarios nuevos demuestren que pueden obtener valor sin intervención de ingeniería.

## 1. Lo que podemos y no podemos concluir hoy

El repositorio tiene Feed temporal, cerebro empresarial, herramientas, integraciones, finanzas, mandatos, rutinas, asuntos y capacidades de navegador y voz. Eso reduce el trabajo de construir primitives; no demuestra que exista una oferta lista para miles de clientes.

Los documentos existentes son coherentes con esta limitación. [Oferta de operación administrada](../product/managed-operations-offer.md) separa la oferta de COP 10 millones de una validación de precio y requiere medir resultados. [APIs personalizadas](../features/custom-api-onboarding.md) describe preparación de una operación por vez y limita OAuth, firmas dinámicas y flujos de varias peticiones. [Gerencia](../features/management.md) distingue cierres y evidencia de atribución económica automática.

No contamos en este análisis con: clientes activos de pago confirmados; ARR contractual; churn; NRR; margen bruto por cohorte; costo real de soporte; conversión del onboarding; frecuencia y gravedad de incidentes; adquisición repetible; tamaño verificable del mercado inicial. Un forecast sin esos datos sería una simulación, no un diagnóstico financiero de Cortex.

Hallazgos de revisión estática, con referencias reproducibles en [el backlog](2026-09-16-activations-backlog.md): el registro exige código de invitación; el catálogo declara que aún no hay gateway de cobro; una migración concede enterprise por defecto; hay dos criterios de onboarding; el dispatcher de Gmail selecciona hasta 200 buzones sin recorrido paginado visible; algunas rutas usan autoridad legacy; la separación de tenants depende en parte del cliente de aplicación con service-role. Esto no prueba una fuga ni un incidente en producción: son riesgos y límites que requieren validación y corrección antes de ampliar el lanzamiento.

Los agentes de auditoría revisaron código y documentación sin modificar servicios, consultar cuentas productivas ni ejecutar flujos con datos reales. El análisis principal verificó las referencias comerciales y de arquitectura clave. Las modificaciones ajenas de Meet/voz presentes en el árbol de trabajo no forman parte de esta entrega.

## 2. Cliente inicial y oportunidad de mercado

**Hipótesis de cliente ideal:** empresa B2B de servicios o distribución, con 20–200 empleados, facturación recurrente o frecuente, datos repartidos entre un sistema administrativo, hojas de cálculo y correo, y una persona responsable de administración o finanzas. El tamaño es un filtro de prospección a validar, no un requisito técnico.

Comprador: fundador, gerente de operaciones o líder financiero. Usuario diario: responsable de cartera/administración. Beneficiario: gerencia, por visibilidad y menos seguimiento manual. Descartar inicialmente cuentas que no tengan acceso autorizado a sus fuentes, responsable del proceso o disposición a medir un resultado.

La primera cuña recomendada es **control de facturación y seguimiento de cartera**. Comparar en entrevistas con seguimiento comercial antes de invertir meses. Para elegir, ponderar dolor económico (30%), acceso a datos (20%), repetibilidad (20%), velocidad de compra (15%) y facilidad de verificar resultados (15%). Puntuar con evidencia de entrevistas, no con intuición del equipo.

“Lo puede usar cualquiera” significa una interfaz comprensible para una persona no técnica. No exige soportar todos los países, ERP, sectores y políticas desde el primer lanzamiento.

Mercado de abajo hacia arriba:

- TAM: empresas que realmente podrían comprar los procesos soportados × ingreso anual razonable por empresa.
- SAM: subconjunto accesible con idiomas, geografía, conectores y requisitos de compra actuales.
- SOM a tres años: capacidad de adquirir y retener cuentas con los canales y equipo disponibles.
- Construir una lista deduplicada de 300 cuentas calificadas y ampliar a 1.000 con país, sector, stack, responsable y señal del problema. Medir cuántas aceptan conversar y pagar.
- Ejemplo únicamente aritmético: 50.000 cuentas elegibles × US$18.000/año = US$900 millones de mercado anual. Ni las 50.000 cuentas ni esa disposición de pago están demostradas. Si fueran solo 5.000, serían US$90 millones: la expansión de mercado sería indispensable.

La relación comercial con Inma o BBIC puede servir como acceso a pilotos, pero no prueba ingresos, contratos ni uso. Mantenerlas como empresas distintas y no compartir sus datos.

## 3. Competencia y posición defendible

| Alternativa | Capacidad observada en fuente oficial | Implicación para Cortex |
| --- | --- | --- |
| Fivetran | Movimiento de datos y activaciones desde una fuente central hacia aplicaciones | Adoptar contratos, sincronización incremental y trazabilidad; integrarlo si el cliente ya lo usa |
| Microsoft Copilot Studio | Construcción de agentes y conexión con procesos/datos del ecosistema Microsoft | No competir solo por chat empresarial o conectores |
| Salesforce Agentforce | Agentes con acceso a conocimiento y acciones; modelos de cobro por uso y licencia | La presencia de IA en un CRM no es una ventaja exclusiva |
| Zapier Agents | Agentes y automatización sobre aplicaciones | Debemos reducir la configuración y resolver procesos, no sumar otro constructor genérico |
| n8n | Flujos, integraciones y ejecución; precios basados en ejecuciones | Buen referente de control; un cliente técnico puede construir alternativas |
| Personal administrativo, consultores y BPO | Alternativa operativa que debe verificarse en entrevistas | Competir con costo total, confianza y tiempo de resolución, no solo con otra suscripción |

Fuentes verificadas el 16-09-2026: [Fivetran](https://fivetran.com/docs/activations/overview), [Copilot Studio](https://www.microsoft.com/en-us/microsoft-365-copilot/microsoft-copilot-studio), [Agentforce](https://www.salesforce.com/agentforce/pricing/), [Zapier Agents](https://zapier.com/agents), [n8n](https://n8n.io/pricing/). La última fila es una hipótesis de competencia, no un dato investigado en cuentas de Cortex.

**Diferenciación a demostrar:** menos tiempo para poner un proceso en marcha, menos mantenimiento por cliente y más cierres con evidencia. El tono colombiano, la voz y una interfaz excelente favorecen adopción; por sí solos no constituyen una barrera competitiva.

Ventajas acumulables: plantillas de procesos evaluadas; mapeos reutilizables; historial de excepciones y su resolución; permisos consistentes; evidencia verificable; distribución mediante socios. Reutilizar aprendizaje de producto sin compartir información confidencial entre empresas. No presentar los datos de clientes como un recurso propio para entrenar o revender.

## 4. Producto: una operación conectada

**Fuente → dato confiable → condición → propuesta → permiso → ejecución → verificación → resultado.**

Mantener cuatro clases de información: conocimiento permanente; registros operativos actualizables; eventos; material temporal del Feed. Un correo o cambio de celda no se vuelve automáticamente una memoria permanente.

Una factura debe tener una identidad estable por empresa y origen, y referencias a sistemas relacionados. Las vistas de finanzas y administración consumen ese registro sin crear dos copias inconsistentes. Igual importe y fecha no bastan para unir facturas; coincidencias difusas generan candidatos a revisión. Moneda, emisor, número, notas crédito y cambios de estado requieren reglas explícitas.

**Activación:** definición versionada con disparador, fuentes, condiciones, mapeos, acciones, responsable, mandato, límites, verificador y criterio de cierre. Reutilizar rutinas y mandatos existentes; no introducir un segundo sistema de autorizaciones.

Separar sincronización de acción: recibir una fila no autoriza enviar un correo. Una fuente actualizada no prueba que el dato sea correcto. Una respuesta del destinatario no prueba un pago. Un HTTP 200 no siempre prueba que el sistema externo terminó la operación.

La IA propone mapeos, interpreta documentos y recomienda decisiones. Las reglas de empresa, permisos y cálculos monetarios críticos deben ejecutarse con contratos validados y código determinista. Contenido de documentos y herramientas se trata como datos, nunca como nuevas instrucciones con autoridad.

## 5. Activaciones iniciales y alcance honesto

| Plantilla | Primera versión | Qué constituye resultado |
| --- | --- | --- |
| Posible doble facturación | Importar facturas, contrastar identificadores, preparar revisión | Revisor registra duplicado real o falso positivo con evidencia |
| Cartera | Consultar facturas y pagos, abrir asunto y preparar seguimiento | Pago confirmado en fuente o estado pendiente correctamente mantenido |
| Oportunidad sin próxima acción | Detectar registros sin seguimiento y preparar actividad | Responsable realiza actividad; resultado registrado en CRM |

Empezar con una de ellas; incorporar las siguientes al reutilizar el mismo motor. Detectar una factura duplicada después de emitida no es prevenir doble facturación. La prevención necesita intervenir antes de emitir, con una integración que permita bloquear o revisar esa transacción. No prometer cobertura de un ERP que solo permita lectura.

Outreach será transversal a industrias: señal → cuenta → contacto autorizado → propuesta → aprobación → envío → respuesta → actualización. La adquisición de datos, permisos del canal, límites de envío, exclusiones y baja deben existir. Un borrador no es una campaña ejecutada; no iniciar envíos desde este análisis.

## 6. UX y autoservicio

Navegación principal propuesta: **Inicio, Conversaciones, Trabajo, Fuentes y Empresa**. Trabajo agrupa asuntos y activaciones; Empresa agrupa cerebro, procesos, equipo y configuración. Finanzas conserva un espacio reconocible dentro del trabajo de la empresa. Validar jerarquía con usuarios, sin hacer otro rediseño masivo antes de probarla.

Inicio responde: qué necesita atención, qué resolvió Cortex, qué está bloqueado y qué necesita aprobación. El fundador tiene resumen de empresas con señales agregadas; cada acción conserva su empresa explícita. El espacio personal permanece separado.

Onboarding: elegir objetivo → conectar una fuente → mostrar muestra de datos → confirmar interpretación → escoger autoridad → simular → obtener primer resultado. Un usuario puede dictar todo; Cortex prepara configuración editable y pregunta solo lo que falta. Mantener un centro de puesta en marcha persistente y retomable, no un modal que reaparezca en cada entrada.

Cada activación muestra qué revisa, cuándo, qué puede hacer, quién responde, salud de fuentes, cambios propuestos, historial y botón de pausa. Los detalles técnicos se pueden ampliar. No esconder errores tras “Cortex está pensando”. Ante un bloqueo, señalar requisito, responsable y acción para resolverlo.

Objetivos iniciales de usabilidad, no resultados actuales: ≥80% de diez usuarios de prueba completa la simulación sin ingeniería; mediana ≤15 minutos desde autorización de una fuente limpia hasta primera simulación; ningún participante actúa en la empresa equivocada. Medir por separado tiempo para obtener permisos externos.

## 7. Fiabilidad y arquitectura

No se propone reescribir Next.js, Supabase, Inngest ni los servicios existentes sin evidencia de límites. Construir un plano de control común encima de ellos.

- Conexión: alcance de lectura/escritura, identidad autorizante, salud, expiración, última sincronización y límites del proveedor.
- Ingesta: cursor duradero, backfill acotado, detección de cambios de esquema, cuarentena y reproducción segura de eventos.
- Registros: IDs estables, enlaces entre sistemas, historial, vigencia y reglas de autoridad por campo.
- Ejecución: claves de idempotencia, reserva atómica, outbox, reintentos clasificados, límites de concurrencia y cola de fallos revisables.
- Permisos: revalidar al ejecutar, no solo al crear. Una aprobación referencia versión y contenido exactos; cambios importantes la invalidan.
- Reconciliación: comparar el estado esperado con el observado. Timeout con efecto desconocido exige verificación antes de reintentar.
- Protección contra ciclos: registrar procedencia, operación causante y versión; no activar indefinidamente cambios producidos por Cortex.
- Verificación: lectura del destino, webhook firmado o evidencia revisada, según lo que permita cada conector.
- Recuperación: pausa detiene nuevas acciones; las ya enviadas pueden terminar. Deshacer solo cuando exista reversión real; en otros casos, compensación explícita.

Pruebas obligatorias: webhook repetido, evento fuera de orden, permisos revocados durante ejecución, aprobación obsoleta, caída después de escribir y antes de confirmar, datos contradictorios, aislamiento entre empresas y cambio de esquema. No prometer ejecución exactamente una vez sobre proveedores que no soportan garantías equivalentes.

No indexar todo el correo indiscriminadamente. No cargar todo el cerebro en cada turno. Recuperar contexto pertinente, mantener reglas permanentes y conservar permisos originales. La voz es una interfaz del mismo trabajo y sus mandatos, no una vía alternativa de autorización.

## 8. Modelo comercial y economía unitaria

Separar ingresos recurrentes de software, implementación única y operación humana recurrente. Una factura de setup no entra en ARR. Un servicio humano mensual puede ser recurrente, pero debe informarse separado del ARR de software para que no esconda una consultoría.

Paquetes a probar, sin cambiar precios vigentes:

| Paquete hipotético | Precio mensual USD a experimentar | Alcance comercial |
| --- | ---: | --- |
| Equipo | 300 | Una plantilla estable, fuentes soportadas y capacidad limitada |
| Operación | 1.500 | Varios procesos, controles y mayor capacidad |
| Enterprise | Desde 7.000 | Requisitos y volumen acordados; implementación cotizada aparte |

No convertir estas cifras a COP con una tasa inventada. No reemplazan propuestas comerciales anteriores de COP 3,5M o COP 10M. Probar precio, alcance y volumen con pilotos pagados. El paquete de entrada solo es viable con adquisición y soporte baratos; no atenderlo con venta consultiva ilimitada.

Cobro recomendado: base por empresa + capacidad incluida + excedentes publicados. Mostrar ejecuciones, minutos de voz/navegador y almacenamiento de forma entendible. Medir tokens internamente, sin obligar al usuario a comprar una unidad opaca. No cobrar reintentos causados por fallos internos como trabajo nuevo. No cobrar por supuesto dinero recuperado sin una regla de atribución acordada.

Ejemplo ilustrativo por cuenta de US$1.500/mes:

| Escenario | Costo directo mensual | Margen bruto | Contribución mensual | Payback con CAC de US$6.000 |
| --- | ---: | ---: | ---: | ---: |
| Eficiente | 300 | 80% | 1.200 | 5,00 meses |
| Base | 450 | 70% | 1.050 | 5,71 meses |
| Intensivo en servicio | 900 | 40% | 600 | 10,00 meses |

Desglose hipotético base: modelos 100, infraestructura 60, servicios externos 50, soporte directo 150, atención recurrente 45, pagos 45. Total 450. No son tarifas comprobadas de proveedores. Incluir también otros costos directos que aparezcan en la medición real; no dejar fuera navegador, observabilidad, reintentos o almacenamiento.

Payback = CAC / (ingreso mensual − costos directos). No incluye churn, costo de capital ni desfase de cobros. CAC debe incluir personas, comisiones, marketing y herramientas atribuibles a adquisición. Medir margen de implementación por separado e incorporar su subsidio al costo de adquirir/activar la cuenta.

Meta propuesta: margen de contribución positivo en cada piloto; margen bruto recurrente ≥65% antes de acelerar ventas y una ruta medida a ≥75%. Si el costo directo supera 35% del precio de manera sostenida, revisar alcance, automatización o precio. Estos son criterios propios, no benchmarks observados de Cortex.

## 9. Qué significa matemáticamente la meta de US$1B

Como sensibilidad simplificada, valoración = ARR × múltiplo hipotético. No es una valoración formal ni una predicción del mercado. No incorpora deuda, caja, términos de financiación ni distinción entre valor de empresa y de acciones.

| Múltiplo ilustrativo, no prometido | ARR necesario para US$1B | Cuentas a US$18.000/año, redondeadas hacia arriba |
| --- | ---: | ---: |
| 5× | US$200,0M | 11.112 |
| 10× | US$100,0M | 5.556 |
| 15× | US$66,7M | 3.704 |

El precio por sí solo no resuelve la escala. Una mezcla ilustrativa de 6.000 cuentas a US$300/mes, 2.000 a US$1.500 y 500 a US$7.000 suma **US$99,6M ARR** y requiere atender **8.500 clientes** con canales diferentes. No es una proyección de ventas.

La valoración dependerá de crecimiento, retención, concentración, calidad de ingresos, márgenes y mercado de capital. [SaaS Capital](https://www.saas-capital.com/the-saas-capital-index/) es una referencia sobre valoración comparativa; no aplicamos automáticamente sus múltiplos a Cortex. [Bessemer, State of AI 2025](https://www.bvp.com/atlas/the-state-of-ai-2025) documenta que crecimiento rápido puede coexistir con márgenes débiles y retención frágil. Su selección de empresas destacadas no representa la probabilidad de éxito de una nueva compañía.

Hitos comerciales por evidencia: 10 clientes que paguen y usen; 50 del mismo perfil con onboarding repetible; 200 con un canal rentable y retención medida; 1.000 con operación y soporte escalables; expansión internacional y de procesos después. No asignar fechas a US$100M sin disponer de cohortes y capacidad de distribución.

## 10. Distribución y ventas

Primeros clientes: ventas del fundador, entrevistas sobre un proceso específico, diagnóstico con datos autorizados y piloto pagado de 4–6 semanas. Registrar situación inicial, costo humano, fallos, volumen y criterio de éxito antes de activar nada.

Oferta de piloto: un proceso, fuentes nombradas, límites claros, un responsable, reporte semanal y precio acordado. No ofrecer “hacemos todo”. Considerar cliente de diseño solo al que participa y permite evaluar; una reunión comercial no equivale a adopción.

Embudo inicial a medir: cuenta calificada → entrevista → diagnóstico → piloto pagado → primer resultado → uso cuatro semanas → renovación → segundo proceso. Ejemplo de experimento, no forecast: 100 cuentas cuidadosamente seleccionadas, 20 conversaciones, 8 diagnósticos y 4 pilotos. Si falla, entender el tramo antes de comprar más tráfico.

Tras validar repetibilidad: socios contables/operativos y consultores de ERP con plantillas certificadas. Incentivos sobre ingreso cobrado y retención, acceso segregado por cliente y acuerdos de soporte. No abrir marketplace hasta poder evaluar versiones, permisos y calidad de los paquetes.

Autoservicio para cuentas pequeñas; venta asistida para las medianas; contrato y revisión técnica para enterprise. Expansión mediante segundo proceso, segundo equipo o segunda empresa del fundador, cada uno con permisos separados. Una invitación de equipo no autoriza extracción de contactos ni mensajes externos.

No escalar publicidad si el producto convierte por demo pero no retiene. Publicar casos de éxito con cifras acordadas y evidencia; no llamar “ingreso generado por Cortex” a toda factura cobrada durante el piloto.

## 11. Métricas y experimentos

Métrica central: **procesos completados correctamente y con evidencia por empresa activa por semana**. Complementarla con porcentaje del trabajo elegible cubierto, tasa de errores y revisión independiente. Evitar inflar el indicador dividiendo una tarea en muchas acciones.

| Métrica | Definición / decisión |
| --- | --- |
| Activación | Primera ejecución real verificada en una fuente autorizada, no login ni conexión |
| Tiempo al valor | Desde registro y, por separado, desde acceso a datos válidos hasta activación |
| Retención de uso | Cohortes que repiten su proceso en semanas 4, 8 y 12 |
| Tasa de éxito | Ejecuciones verificadas / ejecuciones elegibles iniciadas; reportar bloqueos y fallos aparte |
| GRR | (Ingreso inicial de cohorte − bajas − contracción) / ingreso inicial |
| NRR | (Ingreso inicial − bajas − contracción + expansión) / ingreso inicial; excluye clientes nuevos |
| Margen bruto | (Ingreso recurrente − costos directos recurrentes) / ingreso recurrente |
| Soporte | Horas humanas recurrentes por empresa y por 100 ejecuciones |
| CAC payback | CAC / contribución mensual por nueva cuenta, por canal |
| Concentración | Porcentaje del ARR de software en mayor cliente y cinco mayores |

Instrumentación propuesta: onboarding_started, source_authorized, source_diagnosed, mapping_confirmed, simulation_completed, activation_enabled, approval_requested, approval_resolved, execution_attempted, execution_verified, execution_failed, outcome_reviewed, subscription_started y subscription_cancelled. Cada evento lleva tenant, actor, versión, correlation_id y timestamp; no contenido confidencial. Deduplicar entrega y separar cuentas internas/pruebas de clientes.

Metas iniciales propuestas: ≥8/10 usuarios de prueba terminan simulación; ≥80% de cuentas piloto activadas repiten uso durante cuatro semanas; ≥95% de precisión de alertas de duplicados en conjunto etiquetado, midiendo también falsos negativos; cero acciones sin mandato válido; ≥99% de ejecuciones elegibles verificadas en el conjunto de pruebas y piloto acotado. Una muestra pequeña no demuestra seguridad estadística ni fiabilidad universal.

Para escalar adquisición: medir 90 días de cohortes; reducción clara de soporte; payback propuesto ≤12 meses; objetivo a madurez de GRR anual ≥90% y NRR ≥110%, medidos sobre cohortes anuales reales. No anualizar ocho semanas como prueba de retención anual. A modo de sensibilidad, churn mensual de logos de 1%, 2% y 3% implica aproximadamente 88,6%, 78,5% y 69,4% de retención anual de logos; no es NRR.

Experimentos prioritarios: problema/precio con entrevistas y pilotos; onboarding observado; comparación con proceso manual usando casos equivalentes; precisión de duplicados; estrés de reintentos; costo por cliente; canal socio frente a venta directa. Predefinir duración, muestra, responsable y criterio de decisión.

## 12. Hoja de ruta y presupuesto de ejecución

Estimación de planificación: 4–6 personas dedicadas, según experiencia y acceso a sistemas; agentes de programación ayudan pero no sustituyen decisiones del cliente, revisión ni operación. Equipo inicial: líder técnico/backend, ingeniero de integraciones, frontend/producto, QA/fiabilidad, fundador en producto/ventas y apoyo de implementación. Algunas funciones pueden combinarse.

| Etapa | Horizonte orientativo | Criterio de salida |
| --- | --- | --- |
| Auditoría y descubrimiento | Semanas 1–2 | Proceso elegido, fuentes posibles, línea base y backlog priorizado |
| Primera activación completa | Semanas 3–6 | Simulación, aprobación, ejecución, evidencia y reintento seguro en un flujo |
| Pilotos pagados | Semanas 7–10 | 5–10 pilotos objetivo, resultados revisados y costos medidos |
| Autoservicio acotado | Semanas 11–14 | Configuración por usuarios nuevos sin cambios de código por cuenta |
| Lanzamiento controlado | Semanas 15–16 | Gates de seguridad, operación, soporte y precio superados |
| Escalamiento | Meses 5–12, condicionado | Cohortes, canales y márgenes permiten ampliar ventas/procesos |

No usar el calendario para saltarse gates. Presupuesto sin salarios inventados: personas × costo mensual completo × meses + proveedores + asesoría puntual + contingencia. Ejemplo de capacidad: cinco personas durante cuatro meses = veinte meses-persona. Multiplicar por costo real contratado; añadir 20% de contingencia como supuesto y revisar caja disponible.

Financiación por hitos: usar pilotos para reducir incertidumbre; evaluar capital externo cuando acelere un canal repetible o una expansión demostrada. Caja necesaria = burn neto mensual × runway objetivo + obligaciones únicas − caja disponible. Medir burn real y modelar 18–24 meses de runway como escenarios, no como recomendación de gasto ya autorizada.

La diligencia comercial necesita contratos claros, propiedad del software, acuerdos sobre datos/proveedores, recuperación, respuesta a incidentes y evidencias de controles. Validar requisitos concretos por mercado y cliente con especialistas; no afirmar certificaciones ni cumplimiento universal a partir de código.

## 13. Qué aplazar y cuándo cambiar de dirección

Aplazar rediseños generales adicionales, clonación de voz, cientos de conectores, expansión simultánea a todas las industrias, marketplace abierto y promesas de autonomía total. Mantener correcciones críticas de voz y navegador, pero no permitir que esas superficies consuman toda la capacidad de lanzamiento.

Revisar el segmento si menos de 3 de 10 pilotos elegibles aceptan pagar por el resultado; revisar producto si el uso desaparece después de la demo; revisar oferta si la compra depende de una integración exclusiva para cada cuenta; revisar precio/alcance si el costo directo recurrente se mantiene por encima de 35%; frenar escrituras y corregir antes de ampliar ante una fuga entre empresas o una acción no autorizada.

No asumir efecto de red por acumular clientes. La mejora puede venir de plantillas y confiabilidad compartidas, pero debe medirse: cada nueva empresa debería requerir menos configuración y no elevar proporcionalmente el soporte.

## 14. Próximos diez días hábiles

1. Inventario de capacidad y validación con semáforo: existe, probado localmente, probado en producción o pendiente.
2. Elegir facturación/cartera o seguimiento comercial con entrevistas y fuentes disponibles.
3. Definir identidad de registros, políticas de autoridad y una plantilla versionada.
4. Instrumentar embudo y costos antes de nuevos pilotos.
5. Probar fallo después de escritura, aprobación obsoleta y revocación de permisos.
6. Preparar simulación de datos sintéticos y luego una cuenta piloto autorizada.
7. Medir configuración, precisión, tiempo humano y costo; decidir el siguiente alcance.

El backlog ejecutable se mantiene en [Activaciones: backlog y criterios de lanzamiento](2026-09-16-activations-backlog.md). El primer compromiso de producto es una activación verificable, no toda esta plataforma entregada de una vez.
