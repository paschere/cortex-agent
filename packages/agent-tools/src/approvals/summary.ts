/**
 * LA FRASE QUE DESCRIBE UNA LLAMADA PARADA, SIN ENSEÑAR SU PAYLOAD.
 *
 * ===========================================================================
 * POR QUÉ ESTO EXISTE DOS VECES EN EL REPOSITORIO
 * ===========================================================================
 * La copia gemela está en `apps/web/lib/tool-labels.ts` y NO se puede borrar
 * ninguna de las dos:
 *
 *   · La del navegador la usan `ConfirmationPrompt` y la tarjeta de
 *     aprobaciones, que son `'use client'`. Importar `@cortex/agent-tools`
 *     desde un componente de cliente arrastra `node:dns` al bundle y rompe el
 *     build de producción mientras el typecheck y las pruebas siguen en verde
 *     — está contado en `apps/web/lib/reports-shape.ts`, que ya lo vivió.
 *   · Esta la necesita `approvals.list`, que corre dentro del paquete y no
 *     puede importar nada de `apps/web` (la dependencia va al revés).
 *
 * Es el mismo trato que ya tienen `lib/actions-shape.ts` y
 * `lib/commitments-shape.ts`, y la duplicación se mantiene honesta igual: una
 * prueba en Node importa las dos y falla en cuanto discrepan
 * (`apps/web/lib/approvals-summary-parity.test.ts`). Un texto que se va de un
 * lado y no del otro deja de ser cosmético en cuanto la frase que aprueba una
 * persona deja de ser la frase que le contó el modelo.
 *
 * ===========================================================================
 * QUÉ PUEDE Y QUÉ NO PUEDE LLEVAR ESTA FRASE
 * ===========================================================================
 * Es lo ÚNICO derivado del payload que `approvals.list` deja entrar en el
 * contexto del modelo, y por eso cada rama nombra campos concretos —el destino,
 * la etapa, la placa, la fecha— en vez de volcar el objeto. La cola puede
 * contener una exportación de nómina; `Ejecutar: Enviar el correo redactado` es
 * una descripción, `{"rows": [...]}` es una fuga. Al añadir una rama aquí, la
 * pregunta no es «¿qué sé de esta llamada?» sino «¿qué necesita saber quien va
 * a decir que sí?».
 */

/**
 * El nombre en español de cada herramienta. Sólo el texto: los iconos son cosa
 * de la interfaz y viven con ella, en `apps/web/lib/tool-labels.ts`.
 */
export const TOOL_LABEL_TEXT: Record<string, string> = {
  feed_table_query: 'Consultar la hoja de cálculo de Feed',
  management_advance_collection: 'Actualizar o detener el seguimiento',
  management_brief: 'Revisar la gerencia de la empresa',
  management_collection_status: 'Consultar el seguimiento del cobro',
  management_daily_brief: 'Preparar el parte diario',
  management_inspect: 'Consultar un asunto y su historial',
  management_record: 'Organizar y seguir un asunto',
  work_record: 'Anotar trabajo en el registro',
  work_record_batch: 'Anotar muchas filas de trabajo',
  work_preview_batch: 'Mirar qué trabajo entraría al registro',
  work_assign: 'Pasar trabajo a otra persona',
  work_suggest_mapping: 'Proponer cómo una tabla se vuelve trabajo',
  work_configure: 'Configurar el registro de trabajo',
  work_update_person: 'Anotar equipo, cargo o días fuera',
  work_query: 'Consultar el registro de trabajo',
  management_start_collection: 'Iniciar seguimiento y preparar un cobro',
  gmail_propose_learning: 'Proponer un aprendizaje del correo',
  management_operation: 'Consultar el ciclo gerencial',
  management_propose_decision: 'Preparar una decisión para revisión',
  security_report_refusal: 'Registrar una acción rechazada',
  security_get_action_policy: 'Consultar los permisos de acción',
  security_set_action_policy: 'Configurar los permisos de acción',

  qualify_lead: 'Calificar prospecto',
  hubspot_search_companies: 'Buscar empresas en HubSpot',
  hubspot_get_company: 'Ver detalle de la empresa',
  hubspot_search_deals: 'Buscar negocios',
  hubspot_get_deal: 'Ver detalle del negocio',
  hubspot_search_contacts: 'Buscar contactos',
  hubspot_get_contact: 'Ver detalle del contacto',
  hubspot_create_deal: 'Crear negocio',
  hubspot_update_deal: 'Actualizar negocio',
  hubspot_create_contact: 'Crear contacto',
  hubspot_log_activity: 'Registrar actividad',
  hubspot_get_pipeline_summary: 'Resumen del embudo',
  hubspot_list_recent_activities: 'Actividad reciente',
  gmail_search: 'Buscar en Gmail',
  gmail_read_thread: 'Leer conversación de correo',
  gmail_draft: 'Redactar correo',
  gmail_send_draft: 'Enviar el correo redactado',
  gmail_send_message: 'Enviar este correo tal cual',
  actions_propose: 'Dejar la acción lista para aprobar',
  actions_list: 'Ver lo que espera tu aprobación',
  approvals_list: 'Ver lo que espera tu permiso para ejecutarse',
  gmail_list_threads: 'Listar conversaciones de correo',
  gmail_archive_thread: 'Guardar el hilo en el cerebro',
  gmail_train_brain: 'Aprender de tu buzón',
  gmail_training_status: 'Ver cómo va el aprendizaje del buzón',
  gcal_list_events: 'Ver eventos del calendario',
  gcal_create_event: 'Crear evento en el calendario',
  gsheets_read_range: 'Leer hoja de cálculo',
  gsheets_append_row: 'Agregar fila a la hoja',
  kb_search: 'Buscar en el cerebro',
  screen_point_at: 'Señalar en tu pantalla',
  // Como `screen_point_at`: no está en el registro —se declara en `/api/chat` y
  // no ejecuta nada— pero su nombre sí tiene que estar aquí, porque este
  // catálogo y el de `apps/web/lib/tool-labels.ts` son la misma tabla partida en
  // dos y `approvals-parity.test.ts` exige que no se separen.
  ask_choice: 'Preguntarte',
  sales_draft_proposal: 'Redactar propuesta',
  // Ventas (0182).
  sales_quote_create: 'Crear una cotización',
  sales_quote_send: 'Mandar la cotización al cliente',
  sales_invoice_emit: 'Emitir la factura electrónica',
  sales_list: 'Ver cotizaciones, pedidos y facturas',
  crm_pipeline: 'Ver el embudo comercial',
  crm_create_opportunity: 'Abrir una oportunidad de venta',
  crm_update_opportunity: 'Mover o actualizar una oportunidad',
  crm_log_activity: 'Anotar una actividad comercial',
  crm_at_risk: 'Ver los clientes en riesgo de perderse',
  crm_send_nps: 'Mandar la encuesta de satisfacción',
  team_invite: 'Invitar a alguien a la empresa',
  team_founder_promote: 'Nombrar a un cofundador',
  team_founder_transfer: 'Pasar la propiedad de la empresa',
  team_founder_step_down: 'Dejar de ser fundador',
  team_leave_company: 'Salir de la empresa',
  web_search: 'Buscar en internet',
  web_scrape: 'Abrir página web',
  browser_list_flows: 'Ver los trámites aprendidos',
  browser_run_flow: 'Hacer el trámite en el portal',
  browser_submit_flow: 'Radicar el trámite en el portal',
  browser_open_page: 'Abrir el sitio en una pestaña viva',
  browser_act: 'Dar un paso en la página',
  browser_read_page: 'Leer la página como está',
  browser_ask_person: 'Pedirte el volante de la pestaña',
  browser_request_secret: 'Pedirte una clave directo a la página',
  browser_close_page: 'Cerrar la pestaña',
  gdrive_search_files: 'Buscar archivos en Drive',
  gdrive_read_doc: 'Leer documento de Drive',
  schedule_create: 'Programar rutina',
  schedule_list: 'Ver rutinas programadas',
  schedule_update: 'Actualizar rutina',
  vehicles_register: 'Registrar vehículo',
  vehicles_list: 'Ver vehículos',
  vehicles_get: 'Ver detalle del vehículo',
  vehicles_check_runt: 'Consultar el RUNT (SOAT y tecnomecánica)',
  vehicles_check_simit: 'Consultar el SIMIT (comparendos)',
  vehicles_recently_changed: 'Revisar cambios en la flota',
  goals_set: 'Fijar una meta de la empresa',

  // El resto del registro. Iba cayendo a `toTitleCase`, o sea que una llamada
  // parada de `payments.receivables` se anunciaba como «Payments Receivables»
  // en el correo de aprobación y en la tarjeta de Google Chat. Las frases —y el
  // porqué de cada una— están comentadas en el gemelo de
  // `apps/web/lib/tool-labels.ts`; aquí sólo va el texto, y tiene que ser el
  // MISMO texto: `approvals-parity.test.ts` compara los dos mapas enteros.
  outlook_search: 'Buscar en Outlook',
  outlook_read_thread: 'Leer conversación de Outlook',
  outlook_list_threads: 'Listar conversaciones de Outlook',
  outlook_draft: 'Redactar correo en Outlook',
  outlook_send_draft: 'Enviar el correo redactado en Outlook',
  outlook_archive_thread: 'Guardar el correo en el cerebro',
  mscal_list_events: 'Ver el calendario de Outlook',
  mscal_create_event: 'Crear evento en el calendario de Outlook',
  gcal_upcoming_meetings: 'Ver las próximas reuniones',
  browser_resume_flow: 'Retomar el trámite con lo que dijiste',
  hubspot_get_contact_timeline: 'Ver el historial del contacto',
  github_list_repositories: 'Ver repositorios de GitHub',
  github_get_repository: 'Ver detalle del repositorio',
  github_get_repo_contents: 'Leer archivos del repositorio',
  github_get_issue: 'Ver la incidencia de GitHub',
  github_list_issue_comments: 'Leer los comentarios de la incidencia',
  github_list_pull_requests: 'Ver los pull requests',
  github_repo_activity: 'Resumir la actividad del repositorio',
  github_pr_metrics: 'Medir la salud de los pull requests',
  github_create_issue: 'Crear una incidencia en GitHub',
  github_create_issue_comment: 'Comentar en GitHub',
  linear_list_teams: 'Ver los equipos de Linear',
  linear_list_projects: 'Ver los proyectos de Linear',
  linear_get_project: 'Ver detalle del proyecto',
  linear_list_issues: 'Ver tareas en Linear',
  linear_get_issue: 'Ver detalle de la tarea',
  linear_list_comments: 'Leer los comentarios de la tarea',
  linear_cycle_stats: 'Medir el avance del ciclo',
  linear_workload_stats: 'Ver la carga de cada persona',
  linear_create_issue: 'Crear tarea en Linear',
  linear_create_comment: 'Comentar en la tarea',
  kb_list_spaces: 'Ver los espacios del cerebro',
  kb_create_document: 'Guardar en el cerebro',
  kb_share_space: 'Cambiar quién ve un espacio',
  kb_context: 'Reunir contexto del cerebro',
  attachments_promote: 'Guardar el adjunto en el cerebro',
  payroll_team_overview: 'Ver el tamaño del equipo',
  payroll_team_assignments: 'Ver quién está con cada cliente',
  payroll_employee_profile: 'Ver la ficha de alguien del equipo',
  payroll_expenses_report: 'Ver gastos y reembolsos del equipo',
  payroll_payroll_stats: 'Ver cuánto cuesta la nómina',
  payroll_client_report: 'Ver el costo de la cuenta del cliente',
  payroll_cost_projection: 'Proyectar el costo del equipo',
  payroll_period_summary: 'Ver cómo va la nómina del periodo',
  payroll_register_novelty: 'Registrar una novedad de nómina',
  payroll_approve_period: 'Aprobar la nómina',
  payroll_payslip: 'Ver el desprendible de pago',
  payroll_leave_request: 'Pedir vacaciones o un permiso',
  payroll_leave_status: 'Ver el saldo de vacaciones',
  payroll_leave_decide: 'Aprobar o rechazar una ausencia',
  sst_status: 'Ver cómo va el SG-SST',
  sst_log_activity: 'Registrar una actividad del SG-SST',
  sst_report_incident: 'Reportar un accidente de trabajo',
  web_news: 'Buscar noticias',
  presentations_pick_candidate: 'Elegir de quién es la presentación',
  presentations_create_pdf: 'Armar la presentación en PDF',
  presentations_list_recent: 'Ver presentaciones ya armadas',
  slack_post_message: 'Publicar en un canal de Slack',
  whatsapp_customer_conversations: 'Ver las conversaciones de atención por WhatsApp',
  whatsapp_reply: 'Responder a un cliente por WhatsApp',
  chat_send_message: 'Publicar en Google Chat',
  chat_send_dm: 'Mandar un privado por Google Chat',
  people_search: 'Buscar el correo de una persona',
  directory_line: 'Ver quién le responde a quién',
  growth_find_signals: 'Buscar oportunidades comerciales',
  growth_list_signals: 'Ver las oportunidades detectadas',
  growth_update_signal: 'Actualizar la oportunidad',
  growth_identify_contact: 'Averiguar con quién hablar',
  growth_draft_outreach: 'Preparar un mensaje comercial',
  commitments_due_soon: 'Ver lo que se vence',
  commitments_record: 'Anotar un vencimiento para vigilarlo',
  commitments_mark_met: 'Marcar el compromiso como cumplido',
  commitments_pending_review: 'Ver los vencimientos por confirmar',
  commitments_extract_from_document: 'Leer los vencimientos de un documento',
  commitments_confirm_extracted: 'Confirmar el vencimiento leído del documento',
  commitments_reject_extracted: 'Descartar el vencimiento leído',
  clients_search: 'Buscar un cliente',
  clients_directory: 'Ver el directorio de clientes',
  clients_overview: 'Ver la ficha del cliente',
  clients_register: 'Registrar o actualizar el cliente',
  clients_link: 'Enganchar esto a la ficha del cliente',
  clients_merge: 'Unir dos clientes repetidos',
  documents_extract: 'Leer los datos del documento',
  documents_pending_review: 'Ver los documentos por confirmar',
  documents_confirm: 'Confirmar lo que se leyó del documento',
  documents_reject: 'Descartar la lectura del documento',
  documents_expiring: 'Ver los documentos que vencen',
  help_search: 'Buscar en la ayuda de Cortex',
  documents_track_expiration: 'Registrar un documento que vence',
  documents_confirm_expiration: 'Confirmar el vencimiento leído del documento',
  documents_correction_stats: 'Ver qué campos siempre hay que corregir',
  documents_records: 'Ver los documentos confirmados',
  documents_totals: 'Sumar lo facturado',
  payments_record: 'Registrar un pago que entró',
  payments_list: 'Ver los pagos registrados',
  payments_receivables: 'Ver la cartera',
  payments_disputes: 'Ver los pagos que no cuadran',
  payments_resolve_dispute: 'Resolver el pago que no cuadra',
  payments_preview_bank_statement: 'Mirar el extracto del banco',
  payments_import_bank_statement: 'Importar el extracto del banco',
  payments_bank_unmatched: 'Ver lo que entró al banco sin factura',
  payments_apply_to_invoice: 'Atar el pago a su factura',
  payments_recovered: 'Ver la plata recuperada con Cortex',
  recommendations_list: 'Ver lo que te recomendé y qué pasó',
  ledger_record: 'Anotar un movimiento en el libro de plata',
  ledger_record_batch: 'Anotar varios movimientos en el libro de plata',
  ledger_preview_batch: 'Mirar qué entraría al libro de plata',
  ledger_recategorize: 'Corregir la categoría de los movimientos',
  ledger_query: 'Consultar el libro de plata',
  ledger_set_balance: 'Fijar el saldo de una cuenta',
  ledger_forecast: 'Proyectar la caja de las próximas semanas',
  ledger_explain_week: 'Explicar la caja de una semana',
  ledger_save_scenario: 'Guardar un escenario de caja',
  ledger_declare_recurring: 'Anotar un ingreso o gasto que se repite',
  ledger_decide_recurring: 'Confirmar o ignorar un movimiento que se repite',
  ledger_set_minimum_cash: 'Fijar la caja mínima de la empresa',
  ledger_categorize_pending: 'Ponerle categoría a lo que no tiene',
  payables_inbox: 'Ver las facturas de proveedor por pagar',
  payables_pay_plan: 'Ver el programa de pagos a proveedores',
  payables_record: 'Anotar una factura de proveedor',
  payables_approve: 'Aprobar facturas de proveedor',
  payables_reject: 'Rechazar facturas de proveedor',
  payables_schedule: 'Programar el pago a proveedores',
  autopilot_plan: 'Ver lo que haría el piloto hoy',
  autopilot_status: 'Ver lo que hizo el piloto',
  autopilot_configure: 'Configurar el piloto automático',
  autopilot_remind: 'Recordarle algo a un compañero',
  modules_list: 'Ver los módulos prendidos',
  modules_set: 'Prender o apagar un módulo',
  inventory_stock: 'Ver el inventario',
  inventory_move: 'Registrar un movimiento de inventario',
  inventory_reorder: 'Ver qué hay que pedir',
  purchasing_create_po: 'Crear órdenes de compra',
  purchasing_send_po: 'Aprobar y enviar una orden de compra',
  purchasing_receive: 'Recibir la mercancía de una orden de compra',
  // Proyectos y flota (0196).
  projects_create: 'Abrir una orden de servicio o proyecto',
  projects_status: 'Ver cómo van los proyectos',
  projects_log_time: 'Registrar horas en un proyecto',
  projects_profitability: 'Ver la rentabilidad de los proyectos',
  projects_invoice: 'Dejar en borrador la factura de un proyecto',
  fleet_status: 'Ver la flota',
  fleet_log_fuel: 'Registrar un tanqueo',
  fleet_log_maintenance: 'Registrar un mantenimiento',
  fleet_log_trip: 'Registrar un recorrido',
  tax_calendar: 'Ver el calendario de impuestos',
  tax_configure: 'Configurar el perfil tributario',
  tax_mark: 'Marcar un impuesto presentado o pagado',
  tax_draft: 'Armar el borrador de una declaración',
  tax_certificates: 'Mandar certificados de retención',
  tax_exogena_export: 'Preparar la exógena',
  statements_get: 'Ver los estados financieros',
  budget_get: 'Ver el presupuesto contra lo real',
  budget_set_line: 'Fijar una línea del presupuesto',
  forecast_pnl: 'Pronosticar ventas y resultados',
  board_generate: 'Armar el informe para socios',
  board_send: 'Mandar el informe para socios',
  contracts_draft: 'Redactar un borrador de contrato',
  contracts_list: 'Ver los contratos',
  contracts_obligations: 'Ver las obligaciones de los contratos',
  contracts_extract_obligations: 'Leer las obligaciones de un contrato',
  compliance_status: 'Ver cómo va el cumplimiento',
  compliance_mark: 'Marcar una obligación de cumplimiento',
  compliance_pqrs_create: 'Radicar una PQRS',
  compliance_pqrs_respond: 'Guardar la respuesta de una PQRS',
  compliance_case_update: 'Actualizar un proceso judicial',
  // Cierre contable (0192).
  close_status: 'Ver cómo va el cierre del mes',
  close_mark_task: 'Marcar una tarea del cierre',
  close_close_period: 'Cerrar el mes',
  accounting_write_purchase: 'Causar facturas de compra en el programa contable',
  accounting_write_receipt: 'Registrar recibos de caja en el programa contable',
  accounting_write_supplier_payment: 'Registrar pagos a proveedores en el programa contable',
  goals_offer_metrics: 'Ver qué se puede medir aquí',
  goals_list: 'Ver las metas y cómo van',
  goals_measure: 'Medir cómo vamos este período',
  company_facts: 'Leer la ficha de la empresa',
  kb_propose_memory: 'Proponer un recuerdo para la empresa',
  feed_connect_google_sheet: 'Conectar una hoja de Google',
  trackers_propose_from_source: 'Proponer una tabla desde una hoja',
  trackers_sync_from_source: 'Llenar una tabla sola desde una fuente',
  trackers_update_from_source: 'Actualizar una tabla desde una fuente',
  trackers_syncs: 'Ver las tablas que se llenan solas',
  trackers_row_lookup_create: 'Consultar una API fila por fila',
  trackers_row_lookup_status: 'Ver cómo van las consultas automáticas',
  trackers_row_lookup_update: 'Cambiar o pausar una consulta automática',
  trackers_propose_from_drive_folder: 'Proponer una tabla desde una carpeta de Drive',
  trackers_sync_from_drive_folder:
    'Llenar una tabla desde una carpeta de Drive (hojas, documentos y fotos)',
  trackers_drive_syncs: 'Ver las carpetas de Drive que llenan tablas',
  trackers_retry_sync: 'Volver a correr una sincronización',
  accounting_status: 'Ver cómo va el programa contable',
  accounting_sync_now: 'Traer ya los datos del programa contable',
  trackers_define: 'Crear o cambiar una tabla',
  trackers_list: 'Ver las tablas inventadas',
  trackers_query: 'Consultar la tabla',
  trackers_upsert: 'Anotar en la tabla',
  trackers_remove: 'Borrar de la tabla',
  views_list: 'Ver las vistas',
  views_get: 'Abrir una vista',
  views_create: 'Crear una vista',
  views_update: 'Cambiar una vista',
  views_share: 'Compartir una vista',
  views_archive: 'Archivar una vista',
  views_company_pulse: 'Armar el pulso de la empresa',
  views_refresh_summary: 'Actualizar el resumen del día',
  views_schedule_pulse: 'Programar el resumen diario',
  views_weekly_review: 'Escribir la revisión semanal',
  views_schedule_weekly_review: 'Programar la revisión semanal',
  reports_generate: 'Armar el informe',
  reports_list: 'Ver los informes guardados',
  reports_open: 'Abrir un informe guardado',
  reports_share: 'Compartir el informe por enlace',
  reports_chart: 'Dibujar un gráfico',
  reports_compose: 'Armar un informe a la medida',
  reports_run: 'Volver a correr el informe',
  reports_recipes: 'Ver los informes a la medida guardados',
  errands_start: 'Encargarle el trabajo a Cortex',
  errands_status: 'Ver en qué va el encargo',
  errands_answer: 'Contestarle al encargo',
  pipeline_create: 'Guardar un procedimiento',
  pipeline_list: 'Ver los procedimientos guardados',
  pipeline_get: 'Ver el procedimiento',
  pipeline_update: 'Actualizar el procedimiento',
  pipeline_run: 'Ejecutar el procedimiento',
  pipeline_finish_run: 'Cerrar la ejecución del procedimiento',
  meetings_list_transcripts: 'Ver qué reuniones dejaron transcripción',
  meetings_get_transcript: 'Leer la transcripción de la reunión',
  meetings_import_transcript: 'Guardar la reunión en el cerebro',
  meetings_join_live: 'Entrar a la reunión en vivo',
  meetings_live_status: 'Ver cómo va la reunión',
  meetings_speak: 'Hablar en la reunión en vivo',
  meetings_prepare_briefing: 'Preparar la reunión',
  meetings_schedule_briefings: 'Programar el aviso antes de cada reunión',
  cortex_remember: 'Recordar esto tuyo',
  cortex_forget: 'Olvidar eso que recordaba',
  cortex_process: 'Procesar el texto aparte',
  security_review_action: 'Consultar si esto pasa el filtro',
  security_recent_events: 'Ver lo que marcó la seguridad',
  inbox_overview: 'Ver qué está esperando por ti',
  inbox_priorities: 'Priorizar lo que llegó a tu correo',
  inbox_deliver_digest: 'Mandar el resumen del día',
  inbox_due_digests: 'Ver a quién le toca el resumen del día',
};

function toTitleCase(s: string): string {
  return s.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** El nombre que una persona debería leer. Nunca el id en bruto. */
export function pendingToolLabel(toolId: string): string {
  return TOOL_LABEL_TEXT[toolId.replace(/\./g, '_')] ?? toTitleCase(toolId);
}

/**
 * Una frase en español que dice qué va a hacer la llamada que está esperando.
 *
 * Gemela exacta de `confirmationSummary` en `apps/web/lib/tool-labels.ts` — ver
 * la cabecera de este archivo para por qué son dos y qué las mantiene iguales.
 */
export function pendingSummary(toolId: string, input: Record<string, unknown>): string {
  // Acciones seguras de repetir (0168): una repetición pedida a sabiendas lo
  // dice en la propia frase que se aprueba. Gemela de `confirmationSummary` en
  // apps/web/lib/tool-labels.ts.
  const repeat = input.repeatConfirmedByUser === true ? ' · REPETICIÓN: ya se había hecho' : '';
  return `${pendingSummaryBase(toolId, input)}${repeat}`;
}

function pendingSummaryBase(toolId: string, input: Record<string, unknown>): string {
  const key = toolId.replace(/\./g, '_');
  switch (key) {
    case 'hubspot_update_deal':
      return `Actualizar el negocio${input.dealstage ? ` a la etapa "${input.dealstage}"` : ''}${input.amount ? ` · monto $${input.amount}` : ''}`;
    case 'hubspot_create_deal':
      return `Crear el negocio "${input.dealname}" en la etapa "${input.dealstage}"`;
    case 'hubspot_create_contact':
      return `Crear el contacto ${[input.firstName, input.lastName].filter(Boolean).join(' ')} <${input.email}>`;
    case 'hubspot_log_activity':
      return `Registrar ${input.type} "${input.subject}" en ${input.associatedObjectType} ${input.associatedObjectId}`;
    case 'browser_submit_flow':
      return `Ejecutar el trámite "${input.flow}" en el portal, que radica o envía algo con la identidad de la empresa`;
    case 'gmail_send_draft':
      return `Enviar el correo redactado ${input.draftId}`;
    case 'gcal_create_event':
      return `Crear el evento "${input.summary}" el ${input.start}`;
    case 'gsheets_append_row':
      return `Agregar una fila a la hoja "${input.spreadsheetId}"`;
    case 'schedule_create': {
      const when =
        input.scheduleKind === 'once'
          ? `una vez, el ${input.runAt}`
          : `con la programación "${input.cron}" (${input.timezone ?? 'UTC'})`;
      const writes = input.allowUnattendedWrites ? ' · PUEDE ESCRIBIR sin supervisión' : '';
      return `Programar "${input.name}" — se ejecuta ${when}${writes}`;
    }
    case 'views_schedule_pulse': {
      const hour = typeof input.hour === 'number' ? input.hour : 7;
      const minute = typeof input.minute === 'number' ? input.minute : 0;
      const days = Array.isArray(input.weekdays) ? input.weekdays.join(',') : '1-5';
      return `Programar el resumen diario de la vista «${input.view ?? 'pulso_empresa'}» — a las ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (${input.timezone ?? 'America/Bogota'}), días ${days}${input.notifyEmail ? ' · también por correo' : ''}`;
    }
    case 'views_schedule_weekly_review': {
      const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
      const day = typeof input.weekday === 'number' ? (days[input.weekday] ?? 'lunes') : 'lunes';
      const hour = typeof input.hour === 'number' ? input.hour : 7;
      const minute = typeof input.minute === 'number' ? input.minute : 30;
      return `Programar la revisión semanal de la vista «${input.view ?? 'pulso_empresa'}» — los ${day} a las ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (${input.timezone ?? 'America/Bogota'})${input.notifyEmail ? ' · también por correo' : ''}`;
    }
    case 'vehicles_register':
      return `Registrar el vehículo de placa ${input.plate}`;
    case 'payables_record':
      return `Anotar la factura ${input.number} de ${input.supplierName}`;
    case 'payables_approve': {
      const n = Array.isArray(input.invoices) ? input.invoices.length : 0;
      return `Aprobar ${n === 1 ? 'una factura' : `${n} facturas`} de proveedor — no paga nada; el pago se programa después`;
    }
    case 'payables_reject': {
      const n = Array.isArray(input.invoices) ? input.invoices.length : 0;
      return `Rechazar ${n === 1 ? 'una factura' : `${n} facturas`} de proveedor: «${String(input.reason ?? '').slice(0, 120)}»`;
    }
    case 'tax_certificates': {
      const kind =
        input.kind === 'iva' ? 'IVA' : input.kind === 'ica' ? 'ICA' : 'retención en la fuente';
      const n = Array.isArray(input.suppliers) ? input.suppliers.length : 0;
      return `Mandar por correo los certificados de ${kind} ${input.period ? `del bimestre ${input.period} de ${input.year}` : `de ${input.year}`} ${n ? `a ${n === 1 ? 'un proveedor' : `${n} proveedores`}` : 'a todos los proveedores con retención y correo'}`;
    }
    case 'payroll_register_novelty':
      return `Registrar ${String(input.kind ?? 'una novedad').replace(/_/g, ' ')} en la nómina de ${input.person} desde el ${input.date}${input.dateTo ? ` hasta el ${input.dateTo}` : ''}`;
    case 'payroll_approve_period':
      return `Aprobar la nómina ${input.label ? `de ${input.label}` : 'liquidada más reciente'} — no paga nada; el pago se hace desde el banco`;
    case 'payroll_leave_decide':
      return `${input.decision === 'rechazada' ? 'Rechazar' : 'Aprobar'} la solicitud de ausencia${input.person ? ` de ${input.person}` : ''}${input.decision === 'rechazada' && input.note ? `: «${String(input.note).slice(0, 120)}»` : ''}`;
    case 'sst_log_activity':
      return `Registrar en el SG-SST ${String(input.kind ?? 'una actividad').replace(/_/g, ' ')}${input.title ? ` «${input.title}»` : ''} del ${input.date}`;
    case 'sst_report_incident':
      return `Reportar ${input.kind === 'incidente' ? 'un incidente' : input.kind === 'enfermedad_laboral' ? 'una enfermedad laboral' : 'un accidente de trabajo'} del ${input.occurredOn} y crear los avisos de FURAT e investigación`;
    case 'payables_schedule': {
      const n = Array.isArray(input.invoices) ? input.invoices.length : 0;
      return `Programar el pago de ${n === 1 ? 'una factura' : `${n} facturas`} de proveedor ${input.date ? `para el ${input.date}` : 'el día que sugiere la caja'}`;
    }
    case 'sales_quote_create':
      return `Crear una cotización para «${input.client}» con ${Array.isArray(input.lines) ? input.lines.length : 0} línea(s)`;
    case 'sales_quote_send':
      return `Mandar la cotización ${input.quote} por correo ${Array.isArray(input.to) && input.to.length ? `a ${input.to.join(', ')}` : 'al correo del cliente'}`;
    case 'sales_invoice_emit':
      return `Emitir la factura electrónica de ${input.document} en ${input.provider === 'siigo' ? 'Siigo' : input.provider === 'alegra' ? 'Alegra' : 'el programa contable'} — sale con su CUFE a la DIAN`;
    case 'crm_create_opportunity':
      return `Abrir la oportunidad «${input.title}» con ${input.client}${typeof input.value === 'number' ? ` por $${input.value.toLocaleString('es-CO')}` : ''}${input.stage ? ` en ${input.stage}` : ''}`;
    case 'crm_update_opportunity':
      return `Actualizar la oportunidad «${input.opportunity}»${input.stage ? `: pasarla a ${input.stage}` : ''}${input.lostReasonKind ? ` (perdida por ${input.lostReasonKind})` : ''}${typeof input.value === 'number' ? `, valor $${input.value.toLocaleString('es-CO')}` : ''}`;
    case 'crm_log_activity':
      return `Anotar ${input.kind === 'task' ? 'la tarea' : 'la actividad'} «${String(input.title ?? '').slice(0, 120)}»${input.opportunity ? ` en «${input.opportunity}»` : input.client ? ` de ${input.client}` : ''}${input.kind === 'task' && input.dueOn ? ` para el ${input.dueOn}` : ''}`;
    case 'crm_send_nps':
      return input.linkOnly
        ? `Crear el enlace de la encuesta de satisfacción para ${input.client}`
        : `Mandar la encuesta de satisfacción a ${input.client} por correo ${Array.isArray(input.to) && input.to.length ? `a ${input.to.join(', ')}` : 'a su contacto principal'}`;
    case 'team_invite':
      return `Invitar a ${input.email} a la empresa como ${input.role === 'admin' ? 'administrador' : 'miembro'}${input.position ? ` (${String(input.position).slice(0, 80)})` : ''}${input.team ? ` en el equipo ${String(input.team).slice(0, 80)}` : ''} — le llega un correo con el enlace`;
    case 'whatsapp_reply':
      return `Responder por WhatsApp, como persona, en la conversación abierta: «${String(input.text ?? '').slice(0, 120)}»`;
    case 'projects_create':
      return input.fromDocument
        ? `Abrir un proyecto desde ${input.fromDocument}${input.tasksFromLines ? ', con una tarea por línea' : ''}`
        : `Abrir ${input.kind === 'proyecto' ? 'el proyecto' : 'la orden de servicio'} «${input.title}»${input.client ? ` para ${input.client}` : ''}${typeof input.budgetAmount === 'number' ? ` con presupuesto de costo de $${input.budgetAmount.toLocaleString('es-CO')}` : ''}`;
    case 'projects_log_time':
      return `Registrar ${input.hours} h${input.person ? ` de ${input.person}` : ''} en ${input.project}${input.date ? ` el ${input.date}` : ' hoy'}${input.billable === false ? ' (no cobrables)' : ''}`;
    case 'projects_invoice':
      return `Dejar en borrador la factura de ${input.milestone ? `el hito «${input.milestone}» de ` : typeof input.amount === 'number' ? `$${input.amount.toLocaleString('es-CO')} de ` : 'lo que falta de '}${input.project} — no se emite`;
    case 'fleet_log_fuel':
      return `Registrar el tanqueo de ${input.plate}: ${input.gallons} galones por $${Number(input.amount ?? 0).toLocaleString('es-CO')}${typeof input.odometerKm === 'number' ? ` a los ${input.odometerKm.toLocaleString('es-CO')} km` : ''}`;
    case 'fleet_log_maintenance':
      return `Registrar en ${input.plate}: «${String(input.description ?? '').slice(0, 120)}»${typeof input.cost === 'number' ? ` por $${input.cost.toLocaleString('es-CO')}` : ''}`;
    case 'fleet_log_trip': {
      const route = [
        input.origin,
        ...(Array.isArray(input.stops) ? input.stops : []),
        input.destination,
      ]
        .filter(Boolean)
        .join(' → ');
      return `Registrar el recorrido ${route || 'sin ruta'}${input.plate ? ` en ${input.plate}` : ''}${input.date ? ` el ${input.date}` : ''}`;
    }
    case 'inventory_move':
      return input.kind === 'ajuste'
        ? `Ajustar «${input.product}» a ${input.countedQty} contados${input.location ? ` en ${input.location}` : ''}`
        : `Registrar ${input.kind === 'traslado' ? `el traslado a ${input.toLocation}` : `la ${input.kind}`} de ${input.qty} de «${input.product}»${input.unitCost != null ? ` a $${input.unitCost}` : ''}`;
    case 'purchasing_create_po':
      return input.fromSuggestions
        ? `Crear órdenes de compra con lo que hay que reponer${input.approve ? ', y dejarlas aprobadas' : ''}`
        : `Crear una orden de compra a ${input.supplier} con ${Array.isArray(input.lines) ? input.lines.length : 0} producto(s)${input.approve ? ', y dejarla aprobada' : ''}`;
    case 'purchasing_send_po':
      return `Aprobar y enviar la orden de compra ${input.label ?? input.purchaseOrderId}${input.supplierName ? ` a ${input.supplierName}` : ''}${typeof input.expectedTotal === 'number' ? ` por $${input.expectedTotal.toLocaleString('es-CO')}` : ''}${input.to ? ` (${input.to})` : ''}`;
    case 'purchasing_receive':
      return `Recibir ${Array.isArray(input.lines) && input.lines.length ? 'parte de la mercancía' : 'toda la mercancía pendiente'} de la orden ${input.purchaseOrderId}`;
    case 'budget_set_line':
      return `${Number(input.amount) > 0 ? `Fijar ${input.category} en $${Number(input.amount).toLocaleString('es-CO')}` : `Quitar ${input.category}`} del presupuesto ${input.month ? `del mes ${input.month}` : 'de cada mes'}${input.year ? ` de ${input.year}` : ''}`;
    case 'board_generate':
      return `Armar el informe para socios ${input.period ? `de ${input.period}` : 'del mes anterior'} — queda en borrador, no se manda`;
    case 'board_send':
      return `Mandar por correo el informe para socios ${input.report ? `(${input.report})` : 'del mes anterior'} ${Array.isArray(input.to) && input.to.length ? `a ${input.to.join(', ')}` : 'a los correos configurados'}`;
    case 'close_mark_task':
      return `${input.status === 'no_aplica' ? 'Marcar como no aplica' : input.status === 'pendiente' ? 'Volver a pendiente' : 'Dar por hecha'} la tarea «${input.task}» del cierre${input.period ? ` de ${input.period}` : ''}${input.evidence ? `: «${String(input.evidence).slice(0, 120)}»` : ''}`;
    case 'close_close_period':
      return input.action === 'reabrir'
        ? `Reabrir el mes ${input.period ?? 'cerrado'}${input.reason ? `: «${String(input.reason).slice(0, 120)}»` : ''}`
        : `Cerrar el mes ${input.period ?? 'que toca'} — bloquea los cambios de Cortex con fecha de ese mes`;
    case 'accounting_write_purchase': {
      const n = Array.isArray(input.invoices) ? input.invoices.length : 0;
      return `Causar ${n === 1 ? 'una factura' : `${n} facturas`} de proveedor en ${input.provider === 'siigo' ? 'Siigo' : input.provider === 'alegra' ? 'Alegra' : input.provider === 'quickbooks' ? 'QuickBooks' : 'el programa contable'} — queda en los libros de la empresa`;
    }
    case 'accounting_write_receipt': {
      const n = Array.isArray(input.payments) ? input.payments.length : 0;
      return `Registrar ${n === 1 ? 'un recibo de caja' : `${n} recibos de caja`} en ${input.provider === 'siigo' ? 'Siigo' : input.provider === 'alegra' ? 'Alegra' : input.provider === 'quickbooks' ? 'QuickBooks' : 'el programa contable'} — queda en los libros de la empresa`;
    }
    case 'accounting_write_supplier_payment': {
      const n = Array.isArray(input.invoices) ? input.invoices.length : 0;
      return `Registrar ${n === 1 ? 'un pago' : `${n} pagos`} a proveedores en ${input.provider === 'siigo' ? 'Siigo' : input.provider === 'alegra' ? 'Alegra' : input.provider === 'quickbooks' ? 'QuickBooks' : 'el programa contable'} — queda en los libros de la empresa`;
    }
    case 'contracts_draft':
      return `Redactar un borrador de contrato (${String(input.template ?? 'plantilla')})${input.counterparty && typeof input.counterparty === 'object' && (input.counterparty as Record<string, unknown>).name ? ` con ${String((input.counterparty as Record<string, unknown>).name)}` : ''} — queda como borrador para revisión de un abogado; no se firma ni se envía`;
    case 'contracts_extract_obligations':
      return 'Leer el contrato y proponer sus obligaciones y fechas con su frase — ninguna se vigila hasta que alguien la confirme';
    case 'compliance_mark':
      return `Marcar «${input.item}» como ${input.status === 'cumplido' ? 'cumplido' : input.status === 'en_curso' ? 'en curso' : input.status === 'no_aplica' ? 'no aplica' : 'pendiente'}${input.evidenceNote ? `: «${String(input.evidenceNote).slice(0, 120)}»` : ''}`;
    case 'compliance_pqrs_create':
      return `Radicar ${input.kind === 'queja' ? 'una queja' : input.kind === 'reclamo' ? 'un reclamo' : input.kind === 'sugerencia' ? 'una sugerencia' : input.kind === 'felicitacion' ? 'una felicitación' : 'una petición'} de ${input.requesterName}: «${String(input.subject ?? '').slice(0, 100)}» (llegó por ${input.channel})`;
    case 'compliance_pqrs_respond':
      return `Guardar la respuesta de ${input.pqrs}${input.close ? ' y cerrarla' : ''} — no se envía; enviarla es otro paso`;
    case 'compliance_case_update':
      return `${input.id ? 'Actualizar' : 'Registrar o actualizar'} el proceso judicial ${input.title ? `«${input.title}»` : (input.radicado ?? '')}${input.nextHearingOn ? `, con la próxima diligencia el ${input.nextHearingOn}` : ''}`;
    case 'goals_set':
      return `Fijar la meta «${input.label || input.metricKey}» — objetivo ${input.targetValue}, ${
        input.cadence === 'week' ? 'semanal' : 'mensual'
      }`;
    default:
      return `Ejecutar: ${pendingToolLabel(toolId)}`;
  }
}

/** Lo mismo, tolerante con un `input` que no sea un objeto plano. */
export function describePendingCall(toolId: string, input: unknown): string {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  try {
    return pendingSummary(toolId, record);
  } catch {
    return pendingToolLabel(toolId);
  }
}
