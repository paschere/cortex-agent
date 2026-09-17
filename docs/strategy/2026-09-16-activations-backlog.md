# Cortex Activaciones: auditoría, backlog y criterios de lanzamiento

Fecha: 16-09-2026. Acompaña la [estrategia](2026-09-16-cortex-company-scale.md).
Estado: propuesta lista para convertir en tickets; no migraciones ni features implementadas en este cambio.

## Evidencia del estado actual

Los números de línea corresponden al código revisado en esta fecha y pueden cambiar. Existencia en código no equivale a prueba de producción.

| Hallazgo | Evidencia local | Consecuencia |
| --- | --- | --- |
| Registro con código obligatorio | `apps/web/app/(auth)/signup/page.tsx:169`, `apps/web/lib/signup-code.ts:74` | Apertura pública requiere decisión y configuración explícitas |
| Dos definiciones de onboarding | `packages/agent-tools/src/billing/onboarding.ts:3`, `apps/web/lib/management/launch-plan.ts:39`, `apps/web/app/(app)/dashboard/page.tsx:74` | Una sola máquina de progreso debe gobernar redirecciones y UI |
| Cobro no integrado en el flujo revisado | `packages/agent-tools/src/billing/plans.ts:139`, `apps/web/app/(app)/plan/page.tsx:256` | Planes y metering no son checkout ni suscripción cobrada |
| Enterprise por defecto en migración | `infra/supabase/migrations/0114_default_enterprise_plan.sql:49` | Inspeccionar estado real; grants de piloto no deben confundirse con clientes de pago |
| Medición parcial de costos | `apps/web/app/(app)/admin/usage/page.tsx:101`, `apps/web/lib/nav-usage.ts:1` | Completar COGS y embudo; clicks locales no miden cohortes |
| Feed distingue temporal de permanente | `infra/supabase/migrations/0128_feed.sql:1`, `0145_feed_content_identity.sql:1` | Reutilizar staging y dedupe, mantener promoción explícita |
| Clasificación de tablas basada en encabezados | `apps/web/lib/feed/intelligence.ts:123` | Recomendación no equivale a mapping ni carga operativa |
| Estados de conexión heterogéneos | `apps/web/app/(app)/integrations/page.tsx:93`, `apps/web/lib/management/diagnostics.ts:122` | Necesitamos salud, credenciales y reparación uniformes |
| Drive tiene patrón incremental | `apps/web/inngest/functions/drive-sync.ts:41` | Extraer capacidades probadas sin rehacer toda la ingesta |
| Barrido Gmail acotado sin paginación visible | `apps/web/inngest/functions/gmail-learn.ts:165` | Verificar equidad y cobertura de todos los buzones |
| Mandatos por rutina coexistiendo con autoridad legacy | `infra/supabase/migrations/0133_routine_mandates.sql:1`, `apps/web/inngest/functions/schedule-run.ts:117` | Unificar autoridad con migración y revisión de consentimientos |
| Orquestador evita reintentos inseguros | `apps/web/inngest/functions/orchestrator-run.ts:19` | Reintento seguro necesita registro por operación, no repetir toda la tarea |
| Auditoría de intención previa a efectos | `packages/agent-tools/src/registry.ts:203` | Reutilizar, añadir verificación de resultado externo |
| Aislamiento en aplicación con service-role | `infra/supabase/migrations/0064_tenant_isolation.sql:19` | Auditar rutas raw y diseñar defensa de base de datos efectiva |
| Finanzas tiene alcance explícitamente limitado | `apps/web/lib/finance/overview.ts:159` | No vender caja, presupuestos o rentabilidad como capacidades completas |

## Primera entrega vertical

Una empresa conecta una hoja con facturas de prueba, confirma columnas e identidad, ejecuta una simulación de posibles duplicados, revisa un caso, aprueba una acción interna y obtiene evidencia verificable. Luego repite el mismo lote sin duplicar asuntos. No se envían correos ni se modifican facturas de un ERP en esta primera entrega.

Este alcance permite validar onboarding, mapeo, permisos, ejecución y resultado antes de añadir escrituras externas. El siguiente incremento incorpora UN destino externo en sandbox con contrato de lectura/escritura y reconciliación probado.

## Contratos propuestos

Los nombres son propuestas. Antes de crear tablas, mapearlos contra rutinas, auditoría y fuentes existentes para evitar duplicar sistemas.

| Entidad | Campos mínimos y vínculo |
| --- | --- |
| source_connection | organization_id, provider, credential_ref, actor, scopes, state, last_success_at, freshness_target |
| source_checkpoint | connection_id, stream, cursor, schema_version, backfill_state, checkpoint_version |
| source_record_link | organization_id, provider_record_id, entity_type, canonical_id, revision, observed_at |
| activation_definition | organization_id, version, trigger, conditions, mapping_version, action_plan, verifier, routine_id, mandate_id, owner |
| activation_run | definition/version, trigger_key, state, evidence_refs, cost, started_at, completed_at |
| activation_operation | run_id, step_key, idempotency_key, intent_hash, attempt, provider_ref, outcome, verification |
| activation_event | run_id, actor, state transition, timestamp, correlation_id; contenido mínimo y redactado |

Restricciones únicas por tenant e identidad original, y por run/step. Referencias entre tablas deben validar tenant común. No guardar tokens en logs ni tablas de eventos. Retención y borrado deben alcanzar snapshots, índice y resultados derivados.

Conexión: `draft → authorizing → testing → backfilling → ready`; estados laterales `delayed`, `failed`, `revoked`, `paused`. Definir qué condiciones exactas habilitan cada transición.

Ejecución: `queued → evaluating → awaiting_approval → executing → verifying → succeeded`. Alternativas explícitas: `blocked`, `failed`, `cancelled`, `outcome_unknown`, `compensation_required`. “No aplicó” se registra sin contar como proceso completado con valor.

## Backlog priorizado

Tamaños relativos: S = pocos días, M = aproximadamente una semana, L = varias semanas; estimaciones sujetas a descubrimiento. Responsables son roles propuestos, no asignaciones a personas.

| ID | Prioridad | Entregable | Responsable | Dependencia | Aceptación | Tamaño |
| --- | --- | --- | --- | --- | --- | --- |
| ACT-01 | P0 | Inventario de fuentes y contratos | Integraciones | Ninguna | Lista de capacidades reales, auth, límite, sandbox y política de errores por conector | M |
| ACT-02 | P0 | Conexión y estado uniformes para primera fuente | Backend | ACT-01 | Reconexión/revocación/diagnóstico visibles; credencial presente no equivale a ready | L |
| ACT-03 | P0 | Mapping versionado y revisión | Producto + backend | ACT-02 | Moneda, identidad y campos obligatorios; drift bloquea datos afectados | M |
| ACT-04 | P0 | Simulación sin efectos | Backend + frontend | ACT-03 | Muestra registros, cambios, exclusiones y versión exacta; cero escrituras de negocio | M |
| ACT-05 | P0 | Definición de activación ligada a rutina y mandato | Backend | ACT-04 | Una autoridad común; aprobación invalidada tras cambios; revocación efectiva | L |
| ACT-06 | P0 | Operaciones idempotentes y reconciliación | Backend | ACT-05 | Timeout después de efecto no provoca duplicado; resultado desconocido visible | L |
| ACT-07 | P0 | Verificación y vista de ejecución | Backend + frontend | ACT-06 | Evidencia por paso; acción intentada distinta de resultado confirmado | M |
| ACT-08 | P0 | Plantilla de duplicados con revisión | Producto + QA | ACT-03..07 | Dataset etiquetado, falsos positivos/negativos medidos, segundo lote no duplica casos | M |
| REL-01 | P0 | Cobertura paginada del barrido Gmail | Integraciones | Ninguna | 450 buzones sintéticos atendidos; fallo de uno no bloquea otros; no starvation | S/M |
| SEC-01 | P0 | Pruebas adversarias de aislamiento y autoridad | Seguridad + backend | Ninguna | Rechazo de IDs cruzados, sesión/grants revocados y tareas reanudadas sin permiso | M |
| SEC-02 | P0 diseño, P1 migración | Defensa de datos adicional a service-role | Backend | SEC-01 | Rol/contexto tenant efectivo; rutas raw inventariadas; rollout reversible sin pérdida de datos | L |
| PLG-01 | P0 | Evento de activación, cohortes y atribución | Producto + frontend | Ninguna | Embudo servidor deduplicado; pruebas internas excluidas; definición única | M |
| PLG-02 | P0 | Onboarding único y retomable | Producto + frontend | PLG-01 | Dashboard y wizard usan mismo estado; primera misión precede configuración avanzada | M |
| PLG-03 | P0 antes de abrir | Grants y registro público controlado | Backend | SEC-01, PLG-02 | pilot/trial/paid explícitos; expiración y límites; sin cortar acuerdos vigentes | M |
| BILL-01 | P0 decisión, P1 entrega | Facturación y ciclo de suscripción | Fundador + backend | Experimento comercial | Proveedor seleccionado, webhook idempotente, cancelación, recibos, conciliación y entitlements | L |
| COST-01 | P0 | Ledger de costos y presupuestos | Backend + finanzas | Ninguna | IA/voz/browser/infra/soporte por cuenta; conciliación contra facturas de proveedores | M/L |
| OPS-01 | P0 | Monitor, runbook y pausa | Fiabilidad | ACT-06 | Alertas con responsable; recuperación ensayada; comportamiento en vuelo documentado | M |
| PILOT-01 | P0 | Cinco pilotos pagados objetivo | Fundador + implementación | ACT-08, SEC-01, COST-01 | Contrato/alcance, línea base y evaluación real; la meta no implica pilotos ya vendidos | 4–6 semanas |
| ACT-09 | P1 | Escritura a UN destino externo | Integraciones | ACT-06, piloto interno | Sandbox con fallo antes/después del efecto y reconciliación; aprobación exacta | L |
| ACT-10 | P1 | Plantilla cartera | Producto | ACT-09 | Pago verificado antes de cerrar; respuestas no equivalen a pago; avisos sin duplicados | L |
| ACT-11 | P1 | SDK interno de conectores | Integraciones | Dos conectores reales | Contrato de paginación, cursor, límites, backfill, test, repair y verificación | L |
| UX-01 | P1 | Navegación por rol y momento | Diseño + frontend | Pruebas PLG-02 | Usuario nuevo encuentra fuente, trabajo pendiente y aprobación sin asistencia | M |
| GTM-01 | P1 | Paquete de implementación para socios | Fundador | PILOT-01 | Alcance reusable, permisos por cliente, aceptación y margen medidos | M |
| ACT-12 | P2 | Más sectores, destinos y marketplace | Producto | Retención/costo/canal | Expandir solo al reutilizar motor y demostrar demanda | Por definir |

La secuencia del primer sprint es REL-01 + PLG-01 + SEC-01 + diseño ACT-01/02. ACT-04 a ACT-08 constituyen la primera funcionalidad vendible. BILL-01 requiere decisión de cobro; no habilitar cargos reales por inferencia de este documento.

## Matriz mínima de aceptación

| Escenario | Resultado esperado |
| --- | --- |
| Mismo evento 10 veces | Una operación de negocio y trazas de deduplicación |
| Evento viejo después de uno nuevo | No sobrescribe el estado reciente |
| Proveedor aplicó cambio pero devolvió timeout | outcome_unknown; lectura de reconciliación antes de reintentar |
| Revocación antes de ejecutar | No se envía la operación |
| Datos cambiaron tras aprobación | Revisión requerida, sin usar la aprobación vieja |
| Fuente deja de entregar datos | Se muestra atraso/error; no “todo al día” |
| Columna de importe cambia formato | Cuarentena de filas afectadas y reparación guiada |
| Dos facturas similares pero legítimas | No borrar/unir automáticamente; falso positivo medido |
| Usuario cambia empresa | Limpieza de estado transitorio y rechazo de IDs del tenant anterior |
| Se pausa una activación | No se inicia trabajo nuevo; estado de operaciones en vuelo visible |
| Se elimina/restringe documento fuente | Contexto y derivados respetan borrado/permisos según política |
| Correo de respuesta sin comprobante | Asunto continúa pendiente de verificación |

Gates de publicación: pruebas de contrato y E2E con cuentas autorizadas; costos por cliente visibles; errores con recuperación; no acciones sin autoridad; rollout por cohortes; rollback compatible con datos existentes. Mantener datos sintéticos y cuentas de sandbox separados de clientes. La medición de valor exige revisión del responsable, no autoevaluación del modelo.

## Decisiones que faltan antes de ejecución comercial

- Primer segmento y proceso según entrevistas.
- Fuentes concretas de las primeras cuentas y acceso a sandbox.
- Equipo/capacidad y presupuesto disponibles.
- Proveedor y modalidad de cobro; alcance de pilotos vigentes.
- Línea base, duración y criterio de éxito de cada piloto.

Estas decisiones no bloquean instrumentación, auditoría de permisos ni pruebas sintéticas. Sí condicionan precios publicados, cobros, mensajes comerciales y actuaciones sobre datos reales.
